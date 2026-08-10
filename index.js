export { normalizeInventoryItem, normalizePriceLevel, normalizeSeatQuality, normalizeSectionLabel, normalizeRowLabel, normalizeSeatLabel } from './venue-rules.js';
import { isSpecificSeatMatch, isPriceParityMatch, evaluateEquivalentInventoryCoverage } from './venue-rules.js';
import {
  ensureWorkerLogsTable,
  persistWorkerLog as dbPersistWorkerLog,
  getRecentWorkerLogs,
  getNextEventWithActiveListing,
  getNextUpcomingEvent,
  updateEventScanResult,
  getListingForValidation,
  updateListingState,
  getNextPendingScanJob,
  completeScanJob,
  getVenueBackoffState,
  setVenueBackoffState,
  clearVenueBackoffState,
  cleanupPastEvents,
} from './database/queries.js';
import { MONITORED_TARGETS, ACTIVE_VENUE_SET } from './venue-config.js';
import { SCAN_JITTER_CONFIG } from './global-config.js';
import {
  resolveVenuePolicy,
  buildVenueAdapterSmokeReport,
  buildOperationalTelemetrySnapshot,
  inferVenueTimeZone,
  isMonitoringWindowActive,
  getScheduleModeForCronDate,
  isSkyboxListingEnabled,
  isBlockLikeStatus,
  computeBackoffDelayMs
} from './venue-logic.js';
import { ACTIVE_VENUE_ADAPTERS } from './venue-config.js';
import { STRATEGY_REGISTRY } from './strategies.js';
import { FETCH_PROVIDERS } from './fetch-providers.js';
import { computeStringHash, delayExecution, randomBetween, computeJitteredDelay, buildWorkerLogId, timingSafeEqual } from './utils.js';

export function buildHumanReviewNotification(payload = {}) {
  const coverage = payload.coverage || { targetQuantity: 1, equivalentInventoryCount: 0, requiredMinimum: 3, meetsRequirement: false };
  const details = [
    `Venue: ${payload.venueName || 'unknown venue'}`,
    `Show: ${payload.showName || 'unknown show'}`,
    `Event ID: ${payload.eventId || 'unknown'}`,
    `Seat: ${payload.section || 'unknown'} / ${payload.row || 'unknown'} / ${payload.seat || 'unknown'}`,
    `Price Level: ${payload.priceLevel || 'unknown'}`,
    `Seat Quality: ${payload.seatQuality || 'unknown'}`,
    `Business Window: ${payload.businessWindowOpen ? 'OPEN' : 'CLOSED'}`,
    `Freshness: ${payload.freshnessOk ? 'OK' : 'STALE'}`,
    `Signal Check: ${coverage.meetsRequirement ? '3X coverage met' : '3X coverage not met'}`,
    `Equivalent Inventory: ${coverage.equivalentInventoryCount}/${coverage.requiredMinimum} (3X requirement)`,
    'Action: HUMAN_REVIEW_REQUIRED'
  ].join('\n');

  return {
    action: 'HUMAN_REVIEW_REQUIRED',
    monitoringOnly: true,
    approvalEnabled: false,
    details,
    coverage
  };
}

function trackWorkerLog(env, ctx, level, message, context = {}) {
  const logLine = `[${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(logLine);
  } else if (level === 'warn') {
    console.warn(logLine);
  } else {
    console.log(logLine);
  }

  // Wrap the entire telemetry operation to safeguard against any internal failures.
  try {
    const logId = buildWorkerLogId();

    // Wrap the async database call in a promise that never rejects globally.
    const persistPromise = dbPersistWorkerLog(env, logId, level, message, context)
      .catch(dbErr => {
        // If the DB write fails, log it to the console but don't crash the worker.
        console.error(`[TELEMETRY FAILURE] dbPersistWorkerLog rejected: ${dbErr.message}`);
      });

    // Ensure the database write can complete even if the main handler returns.
    if (ctx?.waitUntil) {
      ctx.waitUntil(persistPromise);
    }
    return persistPromise;
  } catch (err) {
    // Catches synchronous errors (e.g., from buildWorkerLogId).
    console.error(`[TELEMETRY FAILURE] Synchronous step inside trackWorkerLog failed: ${err.message}`);
    // Return a resolved promise to satisfy any code paths expecting a promise.
    return Promise.resolve();
  }
}

function isRequestAuthorized(request, env) {
  const expected = env.WEBHOOK_SHARED_SECRET;
  if (!expected) return false;
  const provided = request.headers.get('X-Webhook-Secret') || '';
  return timingSafeEqual(provided, expected);
}

async function executeSecureFetch(env, targetUrlString, targetRow) {
  const isHighSecurity = targetRow?.security_tier === 'high';
  const providerPool = isHighSecurity
    ? (env.FETCH_PROVIDER_POOL || '').split(',').map(p => p.trim()).filter(Boolean)
    : ['native']; // Low-security targets use the native fetch.

  let lastResult = null;

  for (const providerName of providerPool) {
    const provider = FETCH_PROVIDERS[providerName];
    if (!provider) {
      console.warn(`[PROVIDER POOL] Invalid provider specified in pool: ${providerName}. Skipping.`);
      continue;
    }

    try {
      const result = await provider(env, targetUrlString, targetRow);
      lastResult = result;

      // If the provider was rate-limited, log it and try the next one in the pool.
      if (result.status === 429) {
        console.log(`[PROVIDER POOL] Provider ${providerName} was rate-limited. Attempting next provider.`);
        continue;
      }

      // If we get a successful response, return it immediately.
      return result;
    } catch (err) {
      console.error(`[PROVIDER POOL] Provider ${providerName} threw an exception: ${err.message}. Attempting next provider.`);
      lastResult = { status: 500, text: err.message, routedVia: providerName };
    }
  }

  // If all providers in the pool failed, return the last known result.
  console.error(`[PROVIDER POOL] All fetch providers failed. Returning last known result.`);
  return lastResult || { status: 503, text: 'All fetch providers in the pool failed.', routedVia: 'provider_pool' };
}

async function executeScanForTarget(targetRow, env, ctx, options = {}) {
  const { now, jitterMin, jitterMax, runParser, logPrefix = '[SCAN]' } = options;

  const venueTimezone = inferVenueTimeZone(targetRow.venue_name, null, targetRow.timezone_name);
  if (!isMonitoringWindowActive(now, venueTimezone)) {
    console.log(`${logPrefix} Skipping ${targetRow.show_name}; outside active business window (${venueTimezone}).`);
    return;
  }

  const backoffState = await getVenueBackoffState(env.DB, targetRow.venue_id);
  if (backoffState?.backoffUntil && new Date(backoffState.backoffUntil) > now) {
    console.log(`${logPrefix} Skipping ${targetRow.show_name}; venue ${targetRow.venue_id} is backing off until ${backoffState.backoffUntil} after repeated blocking/rate-limit responses.`);
    await trackWorkerLog(env, ctx, 'warn', 'Scan skipped due to active backoff window', {
      venueId: targetRow.venue_id,
      backoffUntil: backoffState.backoffUntil,
      consecutiveBlocks: backoffState.consecutiveBlocks
    });
    return;
  }

  const jitterMs = computeJitteredDelay(jitterMin, jitterMax);
  console.log(`${logPrefix} Applying randomized delay before fetch: ${jitterMs}ms`);
  await delayExecution(jitterMs);

  try {
    const adapter = ACTIVE_VENUE_ADAPTERS[targetRow.venue_id];
    if (!adapter) {
      throw new Error(`No valid adapter found for venue ${targetRow.venue_id}.`);
    }

    // For discovery scans, the target URL is the main calendar page.
    // For inventory monitoring, it's the specific event's direct ticketing URL from the database.
    const isDiscovery = logPrefix === '[DISCOVERY SCAN]';
    const urlToScan = isDiscovery ? adapter.urlPattern : targetRow.event_url;
      
    const checkPayload = await executeSecureFetch(env, urlToScan, targetRow);
    const htmlBody = checkPayload.text || '';

    if (checkPayload.status < 200 || checkPayload.status >= 300) {
      // Create a snippet for logging purposes only, to avoid logging huge HTML bodies.
      const bodySnippet = htmlBody.slice(0, 500);
      console.warn(`${logPrefix} Non-success response (${checkPayload.status}) fetching ${urlToScan} via ${checkPayload.routedVia}.`);
      await trackWorkerLog(env, ctx, 'warn', 'Non-success response fetching event page', {
        url: urlToScan,
        status: checkPayload.status,
        routedVia: checkPayload.routedVia,
        bodySnippet
      });
    }

    if (isBlockLikeStatus(checkPayload.status)) {
      const consecutiveBlocks = (backoffState?.consecutiveBlocks || 0) + 1;
      const policy = resolveVenuePolicy(targetRow.venue_id);
      const delayMs = computeBackoffDelayMs(consecutiveBlocks, policy);
      const backoffUntil = new Date(now.getTime() + delayMs).toISOString();
      await setVenueBackoffState(env.DB, targetRow.venue_id, { consecutiveBlocks, backoffUntil, lastStatus: checkPayload.status });
      console.warn(`${logPrefix} Received blocking-like response (${checkPayload.status}) for ${targetRow.venue_id}; backing off until ${backoffUntil}.`);
      await trackWorkerLog(env, ctx, 'warn', 'Venue returned blocking/rate-limit response; backing off', {
        venueId: targetRow.venue_id,
        status: checkPayload.status,
        consecutiveBlocks,
        backoffUntil
      });
      return;
    }

    if (backoffState?.consecutiveBlocks) {
      await clearVenueBackoffState(env.DB, targetRow.venue_id);
    }

    if (!isDiscovery) {
      const currentSnapshotHash = computeStringHash(htmlBody);
      const timestampIsoString = now.toISOString();
      await updateEventScanResult(env.DB, targetRow.event_id, currentSnapshotHash, timestampIsoString);
      console.log(`${logPrefix} Swept upcoming slot: ${targetRow.show_name} (${targetRow.showtime}) -> Synchronized.`);
    }

    if (!runParser) {
      return;
    }

    // Begin venue-specific parsing logic
    const strategyFn = adapter && STRATEGY_REGISTRY[adapter.parseStrategy];
    if (typeof strategyFn !== 'function') {
      console.warn(`[PARSER] No parse strategy found for venue: ${targetRow.venue_id}`);
      return;
    }

    // For discovery, we use the dedicated discovery strategy. Otherwise, we use the venue's configured default.
    const effectiveStrategy = isDiscovery ? STRATEGY_REGISTRY.calendarPageDiscovery : strategyFn;    
    const inventory = await effectiveStrategy(targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter);
    console.log(`[PARSER] Parser for ${targetRow.venue_id} found ${inventory.length} item(s).`);

    if (targetRow.listing_row_id) {
      const seatAtLocation = inventory.find(item => isSpecificSeatMatch(item, {
        section: targetRow.section_label,
        row: targetRow.row_label,
        seat: targetRow.seat_label
      }));

      if (seatAtLocation && isPriceParityMatch(seatAtLocation, { priceCents: targetRow.price_cents })) {
        const equivalentCoverage = evaluateEquivalentInventoryCoverage({
          venueId: targetRow.venue_id,
          eventId: targetRow.event_id,
          section: targetRow.section_label,
          priceLevel: seatAtLocation.priceLevel,
          seatQuality: seatAtLocation.seatQuality,
          quantity: 1
        }, inventory);

        if (equivalentCoverage.meetsRequirement) {
          console.log(`${logPrefix} Qualifying inventory found for listing ${targetRow.skybox_listing_id} (seat + price + 3X buffer all confirmed); monitoring only, no action taken.`);
          await trackWorkerLog(env, ctx, 'info', 'Qualifying inventory found during monitoring; buffer criteria met', {
            listingId: targetRow.skybox_listing_id,
            venue: targetRow.venue_name,
            showName: targetRow.show_name,
            section: targetRow.section_label,
            row: targetRow.row_label,
            seat: targetRow.seat_label,
            equivalentInventoryCount: equivalentCoverage.equivalentInventoryCount,
            requiredMinimum: equivalentCoverage.requiredMinimum
          });

          if (env.NOTIFICATION_OUTBOUND_URL) {
            const rawMsg = `✅ QUALIFYING INVENTORY FOUND (MONITOR ONLY) ✅
Venue: ${targetRow.venue_name}
Show: ${targetRow.show_name}
Showtime: ${targetRow.showtime}
Target: Section ${targetRow.section_label} | Row ${targetRow.row_label} | ${targetRow.seat_label}
Listing ID: ${targetRow.skybox_listing_id}
Equivalent Inventory: ${equivalentCoverage.equivalentInventoryCount}/${equivalentCoverage.requiredMinimum} (3X buffer met)

Outcome: Seat, price, and confidence buffer all confirmed live. No action taken — outbound listing approval is disabled.`;
            ctx.waitUntil(fetch(env.NOTIFICATION_OUTBOUND_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: rawMsg })
            }));
          }
        }
      }
    }

  } catch (err) {
    console.log(`${logPrefix} Background trace failed: ${err.message}`);
    await trackWorkerLog(env, ctx, 'error', 'Scan execution failed', { error: String(err), eventId: targetRow.event_id });
  }
}

async function runScheduledCycle(env, ctx, options = {}) {
  const now = options.now || new Date();
  const scheduleMode = options.forcedMode || getScheduleModeForCronDate(now);

  try {
    console.log('====================================================');
    console.log(`[MARKET ENGINE] USA Multi-Venue Priority Engine Cycle Woken Up [${scheduleMode}]`);
    console.log('====================================================');

    const queuedJob = await getNextPendingScanJob(env);
    if (queuedJob) {
      console.log(`[MARKET ENGINE] Resuming durable scan job: ${queuedJob.id} (${queuedJob.job_type})`);
      await completeScanJob(env, queuedJob.id, `resumed:${queuedJob.job_type}:${queuedJob.venue_id}`, null);
    }

    if (scheduleMode === 'listing_watch') {
      await trackWorkerLog(env, ctx, 'info', 'Fast listing watcher pass started', { scheduleMode });
      console.log('[LISTING WATCHER] Fast 10-minute pass: checking active listings and stale-state exposures.');

      const targetRow = await getNextEventWithActiveListing(env.DB, ACTIVE_VENUE_SET);
      console.log(`[LISTING WATCHER] Next active listing to check: ${targetRow ? targetRow.show_name : 'none found'}`);
      if (!targetRow) {
        console.log('[LISTING WATCHER] No active listings need an immediate recheck.');
        return;
      }

      await executeScanForTarget(targetRow, env, ctx, {
        now,
        jitterMin: SCAN_JITTER_CONFIG.listingWatch.minMs,
        jitterMax: SCAN_JITTER_CONFIG.listingWatch.maxMs,
        runParser: true,
        logPrefix: '[LISTING WATCHER]'
      });
      return;
    }

    await trackWorkerLog(env, ctx, 'info', 'Scheduled batch started', { scheduleMode });
    if (scheduleMode === 'idle') {
      await trackWorkerLog(env, ctx, 'info', 'Cron minute outside the monitoring cadence. No work scheduled.', { scheduleMode });
      return;
    }

    // Handle Discovery Scans
    if (scheduleMode === 'discovery_scan') {
      await trackWorkerLog(env, ctx, 'info', 'Discovery scan pass started', { scheduleMode });
      console.log('[DISCOVERY SCAN] Initiating discovery for all active venues.');

      for (const venueId of ACTIVE_VENUE_SET) {
        const adapter = ACTIVE_VENUE_ADAPTERS[venueId];
        // Run discovery for any active venue that has a calendar page URL defined.
        if (adapter && adapter.urlPattern) {
          console.log(`[DISCOVERY SCAN] Running discovery for venue: ${adapter.venueName}`);
          // Create a dummy targetRow for the discovery strategy, as it operates on the venue's main URL
          // This object must be complete enough for `executeScanForTarget` to use.
          const discoveryTargetRow = {
            venue_id: adapter.venueId,
            venue_name: adapter.venueName,
            timezone_name: adapter.timezoneName, // Corrected property name
            security_tier: adapter.securityTier,
            event_url: adapter.urlPattern, // The calendar page URL
            show_name: 'Discovery Scan', // Placeholder name
            event_id: `discovery:${adapter.venueId}`, // A placeholder to prevent D1 errors
          };
          await executeScanForTarget(discoveryTargetRow, env, ctx, {
            now,
            jitterMin: SCAN_JITTER_CONFIG.primaryScan.minMs, // Use primary scan jitter for discovery
            jitterMax: SCAN_JITTER_CONFIG.primaryScan.maxMs,
            runParser: true,
            logPrefix: '[DISCOVERY SCAN]'
          });
        }
      }
      console.log('[DISCOVERY SCAN] Discovery pass complete.');
      return; // Discovery scan is a distinct job, so return after it's done.
    }

    let targetRow = await getNextEventWithActiveListing(env.DB, ACTIVE_VENUE_SET);

    if (!targetRow) {
      console.log('[MARKET ENGINE] No future Skybox exposures require scanning. Sweeping general future queue.');
      targetRow = await getNextUpcomingEvent(env.DB, ACTIVE_VENUE_SET);
    }

    if (!targetRow) {
      console.log('[MARKET ENGINE] No active future performances found inside D1 tables. Sleeping loop.');
      return;
    }

    // Run the cleanup job for past events during the primary scan cycle.
    if (scheduleMode === 'primary_scan') {
      await cleanupPastEvents(env.DB);
    }

    await executeScanForTarget(targetRow, env, ctx, {
      now,
      jitterMin: SCAN_JITTER_CONFIG.primaryScan.minMs,
      jitterMax: SCAN_JITTER_CONFIG.primaryScan.maxMs,
      runParser: true,
      logPrefix: '[MARKET ENGINE]'
    });
  } catch (err) {
    console.error('[SCHEDULED ERROR]', err);
    await trackWorkerLog(env, ctx, 'error', 'Scheduled handler failed', { scheduleMode, error: String(err) });
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    if (url.pathname === '/monitoring/targets' || url.pathname === '/targets') {
      return new Response(JSON.stringify({
        generated_at: new Date().toISOString(),
        listing_enabled: isSkyboxListingEnabled(env),
        monitoring_only: !isSkyboxListingEnabled(env),
        targets: MONITORED_TARGETS,
        venue_smoke_matrix: buildVenueAdapterSmokeReport(),
        venue_adapters: Object.values(ACTIVE_VENUE_ADAPTERS),
        telemetry: buildOperationalTelemetrySnapshot(new Date(), env)
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'GET' && url.pathname === '/logs/recent') {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      await ensureWorkerLogsTable(env);
      const logs = await getRecentWorkerLogs(env, limit);
      return new Response(JSON.stringify({ logs }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        service: 'Ticket Agent',
        status: 'active',
        listing_enabled: isSkyboxListingEnabled(env),
        monitoring_only: !isSkyboxListingEnabled(env),
        monitored_targets: MONITORED_TARGETS.map(({ id, name, state_code, security_tier }) => ({ id, name, state_code, security_tier })),
        venue_smoke_matrix: buildVenueAdapterSmokeReport(),
        venue_adapters: Object.values(ACTIVE_VENUE_ADAPTERS),
        telemetry: buildOperationalTelemetrySnapshot(new Date(), env)
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/webhook/validate') {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      await trackWorkerLog(env, ctx, 'info', 'Inbound Skybox Checkout Action captured', {
        method: request.method,
        endpoint: '/webhook/validate'
      });

      const listingGateEnabled = isSkyboxListingEnabled(env);
      if (!listingGateEnabled) {
        console.log('[WEBHOOK GATEKEEPER] Skybox listing is disabled in monitoring-only mode. Validation will not approve any listing.');
        await trackWorkerLog(env, ctx, 'info', 'Skybox listing disabled; rejecting approval request.', { listingGateEnabled });
        return new Response(JSON.stringify({
          status: 'MONITOR_ONLY',
          reason: 'Skybox listing is disabled. Monitoring and validation are active, but no external listing approval is allowed.'
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let orderPayload;
      try {
        orderPayload = await request.json();
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid JSON format' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      if (orderPayload && orderPayload.human_review === true) {
        const notification = buildHumanReviewNotification(orderPayload);
        return new Response(JSON.stringify({
          status: 'HUMAN_REVIEW_REQUIRED',
          monitoringOnly: true,
          details: notification.details,
          coverage: notification.coverage
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const incomingListingId = orderPayload.skybox_listing_id;
      const targetRow = await getListingForValidation(env.DB, incomingListingId, ACTIVE_VENUE_SET);

      if (!targetRow) {
        console.log(`[WEBHOOK GATEKEEPER] Target mismatch or show has already taken place for listing: ${incomingListingId}. Auto-rejecting.`);
        return new Response(JSON.stringify({ status: 'REJECTED', reason: 'Listing reference missing or show has already taken place' }), {
          status: 410,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Parse showtime from DB (ISO 8601 UTC) and format for local venue timezone for display
      const printableShowtime = new Date(targetRow.showtime).toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });

      const venueTimezone = inferVenueTimeZone(targetRow.venue_name, null, targetRow.timezone_name);
      if (!isMonitoringWindowActive(new Date(), venueTimezone)) {
        await trackWorkerLog(env, ctx, 'warn', `Outside active business window for ${targetRow.venue_name}`, {
          listingId: incomingListingId,
          venue: targetRow.venue_name,
          showName: targetRow.show_name
        });
        return new Response(JSON.stringify({ status: 'REJECTED', reason: 'Monitoring outside active business window' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`[LIVE VERIFICATION] Freezing sale for active future performance: ${targetRow.show_name}`);
      console.log(`[LIVE VERIFICATION] Showtime Focus:  ${printableShowtime}`);
      console.log(`[LIVE VERIFICATION] Seat Location:   Section ${targetRow.section_label} -> Row ${targetRow.row_label} -> ${targetRow.seat_label}`);

      let checkPayload;
      try {
        checkPayload = await executeSecureFetch(env, targetRow.event_url, targetRow);
      } catch (err) {
        return new Response(JSON.stringify({ status: 'HOLD', reason: 'Primary market timeout' }), { status: 504, headers: { 'Content-Type': 'application/json' } });
      }

      const htmlBody = checkPayload.text || '';
      const isNonSuccessResponse = checkPayload.status < 200 || checkPayload.status >= 300;
      await trackWorkerLog(env, ctx, isNonSuccessResponse ? 'warn' : 'info', 'Primary market page fetched for verification', {
        listingId: incomingListingId,
        venue: targetRow.venue_name,
        showName: targetRow.show_name,
        section: targetRow.section_label,
        row: targetRow.row_label,
        seat: targetRow.seat_label,
        url: targetRow.event_url,
        responseStatus: checkPayload.status,
        routedVia: checkPayload.routedVia,
        route: 'webhook_validate',
        ...(isNonSuccessResponse ? { bodySnippet: htmlBody.slice(0, 500) } : {})
      });
      const timestampIsoString = new Date().toISOString();
      const currentSnapshotHash = computeStringHash(htmlBody);

      const adapter = ACTIVE_VENUE_ADAPTERS[targetRow.venue_id];
      const strategyFn = adapter && STRATEGY_REGISTRY[adapter.parseStrategy];
      const inventory = await (strategyFn ? strategyFn(targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog) : Promise.resolve([]));
      const seatAtLocation = inventory.find(item => isSpecificSeatMatch(item, {
        section: targetRow.section_label,
        row: targetRow.row_label,
        seat: targetRow.seat_label
      }));
      const isSeatGoneOnPrimaryWeb = !seatAtLocation;

      if (isSeatGoneOnPrimaryWeb) {
        await trackWorkerLog(env, ctx, 'warn', 'Ghost sale attempt caught; target seat missing on primary page', {
          listingId: incomingListingId,
          venue: targetRow.venue_name,
          showName: targetRow.show_name,
          section: targetRow.section_label,
          row: targetRow.row_label,
          seat: targetRow.seat_label
        });
        await updateListingState(env.DB, targetRow.listing_row_id, "SOLD_OUT", timestampIsoString);
        await updateEventScanResult(env.DB, targetRow.event_id, currentSnapshotHash, timestampIsoString);

        if (env.NOTIFICATION_OUTBOUND_URL) {
          const rawMsg = `🛑 SPECIFIC SEAT LOCATION EXPOSURE NEUTRALIZED 🛑
Venue: ${targetRow.venue_name}
Show: ${targetRow.show_name}
Date: ${printableShowtime}
Target: Section ${targetRow.section_label} | Row ${targetRow.row_label} | ${targetRow.seat_label}
Listing ID: ${incomingListingId}

Outcome: Transaction blocked automatically before a ghost sale collision could occur.`;
          ctx.waitUntil(fetch(env.NOTIFICATION_OUTBOUND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: rawMsg })
          }));
        }

        return new Response(JSON.stringify({ status: 'REJECTED', reason: 'Specific seat location inventory depleted on primary site' }), {
          status: 410,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const priceParityOk = isPriceParityMatch(seatAtLocation, { priceCents: targetRow.price_cents });

      if (!priceParityOk) {
        await trackWorkerLog(env, ctx, 'warn', 'Price parity failed; seat present but live price no longer matches listing', {
          listingId: incomingListingId,
          venue: targetRow.venue_name,
          showName: targetRow.show_name,
          section: targetRow.section_label,
          row: targetRow.row_label,
          seat: targetRow.seat_label,
          listedPriceCents: targetRow.price_cents,
          livePriceCents: seatAtLocation.priceCents
        });
        await updateEventScanResult(env.DB, targetRow.event_id, currentSnapshotHash, timestampIsoString);

        return new Response(JSON.stringify({ status: 'REJECTED', reason: 'Seat is present but live price no longer matches the listed price' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const equivalentCoverage = evaluateEquivalentInventoryCoverage({
        venueId: targetRow.venue_id,
        eventId: targetRow.event_id,
        section: targetRow.section_label,
        priceLevel: seatAtLocation.priceLevel,
        seatQuality: seatAtLocation.seatQuality,
        quantity: 1
      }, inventory);

      if (!equivalentCoverage.meetsRequirement) {
        await trackWorkerLog(env, ctx, 'warn', '3X equivalent-inventory confidence buffer not met; holding listing', {
          listingId: incomingListingId,
          venue: targetRow.venue_name,
          showName: targetRow.show_name,
          section: targetRow.section_label,
          equivalentInventoryCount: equivalentCoverage.equivalentInventoryCount,
          requiredMinimum: equivalentCoverage.requiredMinimum
        });
        await updateEventScanResult(env.DB, targetRow.event_id, currentSnapshotHash, timestampIsoString);

        return new Response(JSON.stringify({
          status: 'HOLD',
          reason: 'Equivalent inventory does not yet meet the required 3X confidence buffer',
          coverage: equivalentCoverage
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await trackWorkerLog(env, ctx, 'info', 'Seat, price, and 3X confidence buffer all confirmed live; approving sale', {
        listingId: incomingListingId,
        venue: targetRow.venue_name,
        showName: targetRow.show_name,
        section: targetRow.section_label,
        row: targetRow.row_label,
        seat: targetRow.seat_label,
        equivalentInventoryCount: equivalentCoverage.equivalentInventoryCount,
        requiredMinimum: equivalentCoverage.requiredMinimum
      });
      await updateEventScanResult(env.DB, targetRow.event_id, currentSnapshotHash, timestampIsoString);

      return new Response(JSON.stringify({ status: 'APPROVED', message: 'Specific location allocation verified. Clear.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Granular Timestamp Gatekeeper Active. POST endpoints listening on /webhook/validate');
  },

  async scheduled(event, env, ctx) {
    // Local wrangler dev testing only: trigger via
    //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-primary-scan"
    //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-listing-watch"
    // Real Cloudflare cron always sends one of the actual configured cron strings, never these
    // sentinels, so this override is inert in production.
    const forcedMode =
      event?.cron === 'test-primary-scan' ? 'primary_scan' :
      event?.cron === 'test-listing-watch' ? 'listing_watch' :
      event?.cron === 'test-discovery-scan' ? 'discovery_scan' :
      undefined;
    await runScheduledCycle(env, ctx, forcedMode ? { forcedMode } : {});
  },
};
