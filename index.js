export { normalizeInventoryItem, normalizePriceLevel, normalizeSeatQuality, normalizeSectionLabel, normalizeRowLabel, normalizeSeatLabel } from './venue-rules.js';
import { isSpecificSeatMatch, isPriceParityMatch, evaluateEquivalentInventoryCoverage, findContiguousSeatBlocks, findSegerstromBufferedCandidates, isNotApplicableRowPolicy } from './venue-rules.js';
import {
  persistWorkerLog as dbPersistWorkerLog,
  getRecentWorkerLogs,
  getNextEventWithActiveListing,
  getNextUpcomingEvent,
  getUpcomingEventById,
  updateEventScanResult,
  persistInventoryCandidates,
  getDueDropWatchEvents,
  recordInventoryAvailabilityObservation,
  getPendingInventoryDropAlerts,
  markInventoryDropAlertDelivered,
  markInventoryDropAlertFailed,
  getHallRowOrdering,
  getHallInventoryPolicy,
  getUpcomingInventoryEvents,
  getInventoryJob,
  createInventoryJob,
  claimInventoryJobLease,
  checkpointInventoryJob,
  completeInventoryJob,
  recordInventoryJobBatchMetric,
  getListingForValidation,
  updateListingState,
  getVenueBackoffState,
  setVenueBackoffState,
  clearVenueBackoffState,
  cleanupPastEvents,
  cleanupOldWorkerLogs,
} from './database/queries.js';
import { SCAN_JITTER_CONFIG } from './global-config.js';
import {
  buildVenueAdapterSmokeReport,
  buildOperationalTelemetrySnapshot,
  inferVenueTimeZone,
  isMonitoringWindowActive,
  getScheduleModeForCronDate,
  isSkyboxListingEnabled,
  isBlockLikeStatus,
  computeBackoffDelayMs
} from './venue-logic.js';
import { STRATEGY_REGISTRY } from './strategies.js';
import { FETCH_PROVIDERS } from './fetch-providers.js';
import { computeStringHash, delayExecution, randomBetween, computeJitteredDelay, buildWorkerLogId, timingSafeEqual } from './utils.js';
import { getActiveVenueAdapters, getVenueAdapter, buildPublicVenueSummary } from './database/venue-runtime-config.js';

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

// A configured cap is fail-closed: a seat with no numeric price cannot qualify
// for a price-bounded drop alert.
export function filterInventoryForDropPriceRule(inventory = [], maxPriceCents = null) {
  if (!Number.isFinite(Number(maxPriceCents))) return inventory;
  const limit = Number(maxPriceCents);
  return inventory.filter(item => item?.priceCents != null && Number.isFinite(Number(item.priceCents))
    && Number(item.priceCents) <= limit);
}

function buildPublicAdapterSummaries(adapters = []) {
  return adapters.map(buildPublicVenueSummary);
}

function summarizeEquivalentInventoryPools(venueId, eventId, inventory, quantity, includeSeatSamples = false) {
  const representatives = new Map();
  for (const item of inventory) {
    if (!item?.available) continue;
    const key = [item.section, item.priceLevel, item.seatQuality]
      .map(value => String(value || '').trim().toLowerCase())
      .join('|');
    if (!representatives.has(key)) representatives.set(key, item);
  }
  return [...representatives.values()].map(item => {
    const coverage = evaluateEquivalentInventoryCoverage({
      venueId,
      eventId,
      section: item.section,
      priceLevel: item.priceLevel,
      seatQuality: item.seatQuality,
      quantity
    }, inventory);
    const contiguousBlocks = findContiguousSeatBlocks({
      venueId, eventId, section: item.section, priceLevel: item.priceLevel,
      seatQuality: item.seatQuality, quantity
    }, inventory);
    return {
      section: item.section,
      priceLevel: item.priceLevel,
      priceCents: item.priceCents,
      price: Number.isFinite(Number(item.priceCents)) ? (Number(item.priceCents) / 100).toFixed(2) : null,
      seatQuality: item.seatQuality,
      equivalentInventoryCount: coverage.equivalentInventoryCount,
      requiredMinimum: coverage.requiredMinimum,
      contiguousBlockCount: contiguousBlocks.length,
      requiredContiguousBlockCount: 3,
      meetsRequirement: contiguousBlocks.length >= 3,
      ...(includeSeatSamples ? {
        contiguousBlocks: contiguousBlocks.slice(0, 20).map(block => ({
          row: block.row,
          startSeat: block.startSeat,
          endSeat: block.endSeat,
          seats: block.seats.map(seat => seat.seat)
        })),
        contiguousBlocksTruncated: contiguousBlocks.length > 20
      } : {})
    };
  }).sort((a, b) => b.equivalentInventoryCount - a.equivalentInventoryCount);
}

function summarizeAvailableSeatsBySection(inventory = []) {
  const sections = new Map();
  for (const item of inventory) {
    if (!item?.available) continue;
    const section = String(item.section || 'Unknown').trim() || 'Unknown';
    const summary = sections.get(section) || { section, availableSeats: 0, priceLevels: new Set() };
    summary.availableSeats += Number(item.quantity || 1);
    summary.priceLevels.add(`${item.priceLevel}|${item.seatQuality}`);
    sections.set(section, summary);
  }
  return [...sections.values()]
    .map(({ section, availableSeats, priceLevels }) => ({ section, availableSeats, priceLevelCount: priceLevels.size }))
    .sort((a, b) => b.availableSeats - a.availableSeats);
}

// Console output mirrors the durable snapshot shape while remaining readable
// for large halls. Detailed rows remain queryable in D1 by scan ID.
function buildInventorySnapshotLogSummary(inventory = []) {
  const bySection = new Map();
  for (const rawItem of inventory) {
    const item = rawItem || {};
    const section = String(item.section || 'Unknown').trim() || 'Unknown';
    const summary = bySection.get(section) || {
      section,
      savedSeatRows: 0,
      availableSeats: 0,
      pricePools: new Set()
    };
    summary.savedSeatRows += 1;
    summary.availableSeats += Number(item.quantity) || 1;
    summary.pricePools.add([
      item.priceLevel ?? 'unknown',
      item.seatQuality ?? 'unknown',
      item.priceCents ?? 'unknown'
    ].join('|'));
    bySection.set(section, summary);
  }
  return {
    sections: [...bySection.values()]
      .map(({ section, savedSeatRows, availableSeats, pricePools }) => ({
        section, savedSeatRows, availableSeats, pricePoolCount: pricePools.size
      }))
      .sort((a, b) => b.availableSeats - a.availableSeats),
    sampleSavedSeats: inventory.slice(0, 5).map(item => ({
      section: item.section,
      row: item.row,
      seat: item.seat,
      priceCents: item.priceCents ?? null,
      priceLevel: item.priceLevel ?? null,
      seatQuality: item.seatQuality ?? null,
      quantity: item.quantity ?? 1,
      available: item.available !== false
    }))
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

/**
 * Logs a message and sends a notification, but only if the debug flag is enabled.
 * @param {object} env - The worker environment.
 * @param {object} ctx - The execution context.
 * @param {string} message - The message to log and send.
 * @param {string} level - The log level ('info', 'warn', 'error').
 * @param {string} channel - The notification channel ('debug', 'critical').
*/
function debugLogAndNotify(env, ctx, message, level = 'info') {
  if (env.ENABLE_DEBUG_NOTIFICATIONS === 'true') {
    level === 'warn' ? console.warn(message) : console.log(message);
    sendTelegramNotification(env, ctx, message);
  }
}


/**
 * Sends a message to the configured Telegram notification URL.
 * This is a "fire-and-forget" operation that does not block execution.
 * @param {object} env - The worker environment.
 * @param {object} ctx - The execution context.
 * @param {string} message - The message to send.
 * @param {string} channel - The notification channel ('debug' or 'critical').
 */
function sendTelegramNotification(env, ctx, message, channel = 'debug') {
  const url = channel === 'critical'
    ? env.CRITICAL_NOTIFICATION_OUTBOUND_URL
    : env.NOTIFICATION_OUTBOUND_URL;

  // Only send if an appropriate URL is configured.
  if (url) {
    const promise = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `\`\`\`\n${message}\n\`\`\`` }) // Format as a code block for readability
    }).catch(err => console.error(`[TELEGRAM NOTIFY FAILED] ${err.message}`));
    // Use waitUntil to allow the fetch to complete in the background.
    ctx?.waitUntil(promise);
  }
}

async function deliverCriticalNotification(env, message) {
  // A dedicated critical endpoint is preferred, but an already-configured
  // operational notification channel is a safe production fallback. Alerts
  // remain durable in D1 if neither endpoint exists.
  const url = env.CRITICAL_NOTIFICATION_OUTBOUND_URL || env.NOTIFICATION_OUTBOUND_URL;
  if (!url) throw new Error('No critical or default notification endpoint is configured');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `\`\`\`\n${message}\n\`\`\`` })
  });
  if (!response.ok) throw new Error(`notification endpoint returned HTTP ${response.status}`);
}

function buildDropAlertMessage(payload = {}) {
  const priceRule = Number.isFinite(Number(payload.maxPriceCents))
    ? `Price rule: $${(Number(payload.maxPriceCents) / 100).toFixed(2)} or less`
    : 'Price rule: any available price';
  return [
    '🚨 TICKET DROP DETECTED',
    `Venue: ${payload.venueName}`,
    `Show: ${payload.showName}`,
    `Performance: ${payload.showtime}`,
    `Available seats detected: ${payload.availableItemCount}`,
    priceRule,
    `Observed: ${payload.observedAt}`,
    `Buy: ${payload.eventUrl || 'direct URL unavailable'}`,
    'Rule: previously confirmed sold out → availability now detected.'
  ].join('\n');
}

async function deliverPendingDropAlerts(env, limit = 20) {
  const alerts = await getPendingInventoryDropAlerts(env.DB, limit);
  for (const alert of alerts) {
    let payload = {};
    try { payload = JSON.parse(alert.payload_json || '{}'); } catch { payload = {}; }
    try {
      await deliverCriticalNotification(env, buildDropAlertMessage(payload));
      await markInventoryDropAlertDelivered(env.DB, alert.id, new Date().toISOString());
      console.log(`[DROP WATCH] Alert delivered for event ${alert.event_id}.`);
    } catch (error) {
      const attempt = Number(alert.attempt_count || 0) + 1;
      const retryMs = Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempt, 5)));
      await markInventoryDropAlertFailed(env.DB, alert.id, error.message,
        new Date(Date.now() + retryMs).toISOString());
      console.error(`[DROP WATCH] Alert delivery failed for event ${alert.event_id}: ${error.message}`);
    }
  }
  return alerts.length;
}

function isRequestAuthorized(request, env) {
  const expected = env.WEBHOOK_SHARED_SECRET;
  if (!expected) return false;
  const provided = request.headers.get('X-Webhook-Secret') || '';
  return timingSafeEqual(provided, expected);
}

async function executeApiFetch(url, options = {}) {
  const { method = 'GET', headers = {}, body = null, retries = 3, initialBackoff = 2000, debugLog } = options;
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; TicketAgent/1.0; +https://skybox.com)',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const finalHeaders = { ...defaultHeaders, ...headers };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Add a newline for visual separation in logs between attempts.
      const attemptMsg = `\n[API FETCH] Attempt ${attempt}/${retries} for -> ${url}`;
      if (debugLog) debugLog(attemptMsg, 'info');

      if (method === 'POST' && body) {
        const bodyMsg = `[API FETCH] Request Body: ${body}`;
        if (debugLog) debugLog(bodyMsg, 'info');
      }
      const res = await fetch(url, { method, headers: finalHeaders, body });

      // For transient server errors, we should retry with backoff.
      if (res.status >= 500 && res.status <= 504) {
        const backoffMs = initialBackoff * Math.pow(2, attempt - 1) + randomBetween(500, 1500);
        const errorMsg = `[API FETCH] Received server error (${res.status}). Retrying in ${backoffMs}ms...`;
        if (debugLog) debugLog(errorMsg, 'warn');
        if (attempt < retries) await delayExecution(backoffMs);
        continue; // Move to the next retry attempt
      }

      // For any other status, we return the result immediately.
      const responseText = await res.text();
      const snippet = responseText.slice(0, 400);
      const responseMsg = responseText.length > 400 ? `[API FETCH] Response Body Snippet: ${snippet}...\n` : `[API FETCH] Response Body: ${snippet}\n`;
      if (debugLog) debugLog(responseMsg, 'info');

      return { text: responseText, status: res.status, routedVia: 'apiFetchProvider' };

    } catch (err) {
      console.error(`[API FETCH] Network error on attempt ${attempt}: ${err.message}`);
      if (attempt < retries) {
        const backoffMs = initialBackoff * Math.pow(2, attempt - 1) + randomBetween(500, 1500);
        const retryMsg = `[API FETCH] Retrying after network error in ${backoffMs}ms...`;
        if (debugLog) debugLog(retryMsg, 'warn');
        await delayExecution(backoffMs);
      } else {
        // If all retries fail, throw the error to be handled by the calling strategy.
        throw new Error(`API fetch failed for ${url} after ${retries} attempts: ${err.message}`);
      }
    }
  }

  // This part is reached only if all retries resulted in a 5xx error.
  const errorMessage = `API fetch failed for ${url} after ${retries} attempts due to persistent server errors.`;
  console.error(`[API FETCH] ${errorMessage}`);
  return { text: errorMessage, status: 503, routedVia: 'apiFetchProvider' };
}

async function executeSecureFetch(env, targetUrlString, targetRow, fetchOptions = {}) {
  const method = fetchOptions.method || 'GET';
  let providerPool = ['native']; // Default to native fetch for low-security targets

  if (targetRow?.security_tier === 'high') {
    // For high-security targets, intelligently select the provider type.
    if (method === 'POST' || fetchOptions.apiRequest === true) {
      // API calls use a dedicated, configurable provider pool.
      // Defaults to the API proxy with a native fetch fallback.
      providerPool = (env.API_FETCH_PROVIDER_POOL || 'zenrows_api,native').split(',').map(p => p.trim()).filter(Boolean);
    } else {
      // Web page scrapes use the browser rendering provider.
      providerPool = (env.FETCH_PROVIDER_POOL || 'zenrows_browser,native').split(',').map(p => p.trim()).filter(Boolean);
    }
  }

  let lastResult = null;

  for (const providerName of providerPool) {
    const provider = FETCH_PROVIDERS[providerName];
    if (!provider) {
      console.warn(`[PROVIDER POOL] Invalid provider specified in pool: ${providerName}. Skipping.`);
      continue;
    }

    try {
      const result = await provider(env, targetUrlString, targetRow, fetchOptions);
      lastResult = result;

      // A proxy error must not prevent the configured fallback provider from
      // attempting the request. Target responses such as NotOnSale are still
      // normal 2xx responses and return immediately.
      if (result.status < 200 || result.status >= 300) {
        console.log(`[PROVIDER POOL] Provider ${providerName} returned HTTP ${result.status}. Attempting next provider.`);
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
  const scanStartedAtMs = Date.now();
  const { now, jitterMin, jitterMax, runParser, logPrefix = '[SCAN]', adapter: suppliedAdapter, skipJitter = false } = options;
  const adapter = suppliedAdapter || await getVenueAdapter(env.DB, env, targetRow.venue_id);
  if (!adapter) {
    console.warn(`${logPrefix} Skipping ${targetRow.show_name}; venue ${targetRow.venue_id} has no valid active adapter.`);
    return { status: 'skipped', reason: 'invalid_adapter' };
  }

  const venueTimezone = inferVenueTimeZone(targetRow.venue_name, null, targetRow.timezone_name);
  if (!isMonitoringWindowActive(now, venueTimezone, adapter.businessHours)) {
    console.log(`${logPrefix} Skipping ${targetRow.show_name}; outside active business window (${venueTimezone}).`);
    return { status: 'skipped', reason: 'outside_business_window' };
  }

  const backoffState = await getVenueBackoffState(env.DB, targetRow.venue_id);
  if (backoffState?.backoffUntil && new Date(backoffState.backoffUntil) > now) {
    console.log(`${logPrefix} Skipping ${targetRow.show_name}; venue ${targetRow.venue_id} is backing off until ${backoffState.backoffUntil} after repeated blocking/rate-limit responses.`);
    await trackWorkerLog(env, ctx, 'warn', 'Scan skipped due to active backoff window', {
      venueId: targetRow.venue_id,
      backoffUntil: backoffState.backoffUntil,
      consecutiveBlocks: backoffState.consecutiveBlocks
    });
    return { status: 'skipped', reason: 'venue_backoff' };
  }

  if (!skipJitter) {
    const jitterMs = computeJitteredDelay(jitterMin, jitterMax);
    console.log(`${logPrefix} Applying randomized delay before fetch: ${jitterMs}ms`);
    await delayExecution(jitterMs);
  }

  try {
    const isDiscovery = logPrefix === '[DISCOVERY SCAN]';
    const urlToScan = isDiscovery ? adapter.urlPattern : targetRow.event_url;
    const strategyName = isDiscovery ? adapter.discoveryStrategy : adapter.inventoryStrategy;
    const effectiveStrategy = strategyName ? STRATEGY_REGISTRY[strategyName] : null;

    if (typeof effectiveStrategy !== 'function') {
      await trackWorkerLog(env, ctx, 'warn', `No valid parse strategy found for venue in the current mode.`, {
        venueId: targetRow.venue_id,
        isDiscovery,
        strategyName: strategyName || 'not_configured'
      });
      return { status: 'skipped', reason: 'missing_strategy' };
    }

    let htmlBody = '';
    // Only perform an initial page fetch if the selected strategy is HTML-based.
    // API-based strategies will handle their own fetching using executeApiFetch.
    if (strategyName === 'calendarPageDiscovery' || strategyName === 'singleStep') {
      const checkPayload = await executeSecureFetch(env, urlToScan, targetRow, { method: 'GET' }); // Initial fetch is always GET
      htmlBody = checkPayload.text || '';

      if (checkPayload.status < 200 || checkPayload.status >= 300) {
        const bodySnippet = htmlBody.slice(0, 500);
        console.warn(`${logPrefix} Non-success response (${checkPayload.status}) fetching ${urlToScan} via ${checkPayload.routedVia}.`);
        await trackWorkerLog(env, ctx, 'warn', 'Non-success response fetching event page', { url: urlToScan, status: checkPayload.status, routedVia: checkPayload.routedVia, bodySnippet });
      }

      if (isBlockLikeStatus(checkPayload.status)) {
        const consecutiveBlocks = (backoffState?.consecutiveBlocks || 0) + 1;
        const delayMs = computeBackoffDelayMs(consecutiveBlocks, adapter);
        const backoffUntil = new Date(now.getTime() + delayMs).toISOString();
        await setVenueBackoffState(env.DB, targetRow.venue_id, { consecutiveBlocks, backoffUntil, lastStatus: checkPayload.status });
        console.warn(`${logPrefix} Received blocking-like response (${checkPayload.status}) for ${targetRow.venue_id}; backing off until ${backoffUntil}.`);
        await trackWorkerLog(env, ctx, 'warn', 'Venue returned blocking/rate-limit response; backing off', { venueId: targetRow.venue_id, status: checkPayload.status, consecutiveBlocks, backoffUntil });
        return { status: 'skipped', reason: 'venue_blocked' };
      }
    }

    if (backoffState?.consecutiveBlocks) {
      await clearVenueBackoffState(env.DB, targetRow.venue_id);
    }

    if (!runParser) {
      return { status: 'completed', inventoryCount: 0 };
    }

    const boundDebugLog = (message, level) => debugLogAndNotify(env, ctx, message, level);
    const boundApiFetch = (url, opts) => executeApiFetch(url, { ...opts, debugLog: boundDebugLog });

    const inventory = await effectiveStrategy(targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, boundApiFetch);
    const scanDurationMs = Date.now() - scanStartedAtMs;
    let inventoryCandidates = [];
    let inventoryCandidatePolicy = 'not_applied_position_policy_not_not_applicable';
    let confirmedDropDetected = false;
    console.log(`[PARSER] Parser for ${targetRow.venue_id} found ${inventory.length} item(s).`);

    if (!isDiscovery) {
      const timestampIsoString = new Date().toISOString();
      const snapshotHash = computeStringHash(JSON.stringify(inventory));
      const scanId = buildWorkerLogId();
      try {
        const targetQuantities = Array.isArray(options.targetQuantities)
          ? [...new Set(options.targetQuantities.map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 10))]
          : (Number.isInteger(Number(options.targetQuantity)) && Number(options.targetQuantity) > 0 ? [Number(options.targetQuantity)] : []);
        const hallPolicy = targetRow.venue_hall_id
          ? await getHallInventoryPolicy(env.DB, targetRow.venue_hall_id)
          : null;
        const canUseNotApplicableRowPolicy = isNotApplicableRowPolicy(hallPolicy);
        if (canUseNotApplicableRowPolicy) inventoryCandidatePolicy = 'not_applicable_same_or_forward_row';
        const rowOrdering = canUseNotApplicableRowPolicy
          ? await getHallRowOrdering(env.DB, targetRow.venue_hall_id)
          : [];
        const candidates = canUseNotApplicableRowPolicy
          ? targetQuantities.flatMap(quantity => findSegerstromBufferedCandidates(
            inventory, quantity, rowOrdering, adapter.inventoryBufferBlockCount
          ))
          : [];
        inventoryCandidates = candidates;
        const persistedSnapshot = await persistInventoryCandidates(env.DB, {
          scanId,
          eventId: targetRow.event_id,
          venueId: targetRow.venue_id,
          scanSource: options.scanSource || (logPrefix === '[SINGLE EVENT INVENTORY]' ? 'single_event_inventory' : 'scheduled_inventory'),
          scannedAt: timestampIsoString,
          snapshotHash,
          availableItemCount: inventory.length,
          inventoryJobId: options.inventoryJobId || null,
          durationMs: scanDurationMs,
          candidates
        });
        let dropObservation = null;
        {
          const maxPriceCents = Number.isFinite(Number(targetRow.drop_watch_max_price_cents))
            ? Number(targetRow.drop_watch_max_price_cents)
            : null;
          const qualifyingInventory = filterInventoryForDropPriceRule(inventory, maxPriceCents);
          const dropPayload = {
            eventId: targetRow.event_id,
            venueName: targetRow.venue_name,
            showName: targetRow.show_name,
            showtime: targetRow.showtime,
            eventUrl: targetRow.event_url,
            availableItemCount: qualifyingInventory.length,
            observedAvailableItemCount: inventory.length,
            maxPriceCents,
            observedAt: timestampIsoString
          };
          dropObservation = await recordInventoryAvailabilityObservation(env.DB, {
            eventId: targetRow.event_id,
            scanId,
            alertId: `${scanId}:sold-out-drop`,
            availableItemCount: qualifyingInventory.length,
            observedAt: timestampIsoString,
            alertPayload: dropPayload
          });
          confirmedDropDetected = dropObservation.dropDetected;
          console.log('[DROP WATCH] Availability state recorded', {
            eventId: targetRow.event_id,
            showName: targetRow.show_name,
            availabilityState: dropObservation.availabilityState,
            availableItemCount: qualifyingInventory.length,
            observedAvailableItemCount: inventory.length,
            maxPriceCents,
            dropDetected: dropObservation.dropDetected
          });
        }
        const logSummary = buildInventorySnapshotLogSummary(inventory);
        console.log('[D1 INVENTORY] Snapshot saved', {
          scanId,
          eventId: targetRow.event_id,
          venueId: targetRow.venue_id,
          scanSource: options.scanSource || (logPrefix === '[SINGLE EVENT INVENTORY]' ? 'single_event_inventory' : 'scheduled_inventory'),
          scannedAt: timestampIsoString,
          snapshotHash,
          durationMs: scanDurationMs,
          availableSeatRowsObserved: inventory.length,
          targetQuantities,
          requiredBufferBlockCount: adapter.inventoryBufferBlockCount,
          savedCandidateBlocks: persistedSnapshot.candidateCount,
          candidatePolicy: inventoryCandidatePolicy,
          sections: logSummary.sections,
          sampleObservedSeats: logSummary.sampleSavedSeats,
          sampleSavedCandidates: candidates.slice(0, 3),
          dropDetected: dropObservation?.dropDetected || false
        });
      } catch (snapshotError) {
        // A successful live scan must not be turned into a false parser failure
        // solely because optional historical storage is temporarily unavailable.
        console.error(`${logPrefix} Inventory snapshot could not be saved to D1: ${snapshotError.message}`);
        await trackWorkerLog(env, ctx, 'error', 'Inventory snapshot persistence failed', {
          eventId: targetRow.event_id,
          venueId: targetRow.venue_id,
          error: String(snapshotError)
        });
      }
      await updateEventScanResult(env.DB, targetRow.event_id, snapshotHash, timestampIsoString);
      console.log(`${logPrefix} Inventory scan succeeded: ${targetRow.show_name} (${targetRow.showtime}), ${inventory.length} item(s) parsed in ${scanDurationMs}ms.`);
    }

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

          const notificationMsg = `✅ QUALIFYING INVENTORY FOUND (MONITOR ONLY) ✅
Venue: ${targetRow.venue_name}
Show: ${targetRow.show_name}
Showtime: ${targetRow.showtime}
Target: Section ${targetRow.section_label} | Row ${targetRow.row_label} | ${targetRow.seat_label}
Listing ID: ${targetRow.skybox_listing_id}
Equivalent Inventory: ${equivalentCoverage.equivalentInventoryCount}/${equivalentCoverage.requiredMinimum} (3X buffer met)

Outcome: Seat, price, and confidence buffer all confirmed live. No action taken — outbound listing approval is disabled.`;
          sendTelegramNotification(env, ctx, notificationMsg, 'critical');
        }
      }
    }

    return {
      status: 'completed', inventoryCount: inventory.length, inventory, inventoryCandidates,
      requiredBufferBlockCount: adapter.inventoryBufferBlockCount,
      candidatePolicy: inventoryCandidatePolicy,
      dropDetected: confirmedDropDetected,
      durationMs: scanDurationMs
    };
  } catch (err) {
    console.log(`${logPrefix} Background trace failed: ${err.message}`);
    await trackWorkerLog(env, ctx, 'error', 'Scan execution failed', { error: String(err), eventId: targetRow.event_id });
    return { status: 'failed', reason: err.message };
  }
}

async function runInventoryJobForVenue(adapter, env, ctx, now) {
  let job = await getInventoryJob(env.DB, adapter.venueId);
  if (!job) {
    const eligibleEvents = await getUpcomingInventoryEvents(env.DB, adapter.venueId);
    if (!eligibleEvents.length) {
      console.log(`[ALL EVENTS INVENTORY] ${adapter.venueName}: no upcoming events to scan.`);
      return;
    }
    try {
      job = await createInventoryJob(env.DB, {
        id: buildWorkerLogId(), venueId: adapter.venueId,
        remainingEventIds: eligibleEvents.map(event => event.event_id), startedAt: now.toISOString()
      });
      console.log(`[ALL EVENTS INVENTORY] Created job ${job.id}: ${job.total_event_count} upcoming event(s).`);
    } catch (error) {
      // Another cron may have created the venue job first; use it instead.
      job = await getInventoryJob(env.DB, adapter.venueId);
      if (!job) throw error;
    }
  }

  const leaseOwner = buildWorkerLogId();
  const batchStartedAt = new Date();
  const deadlineMs = Date.now() + adapter.inventoryMaxRunDurationMs;
  const leaseExpiresAt = new Date(deadlineMs + 30000).toISOString();
  const claimed = await claimInventoryJobLease(env.DB, job.id, leaseOwner, leaseExpiresAt, batchStartedAt.toISOString());
  if (!claimed) {
    console.log(`[ALL EVENTS INVENTORY] Job ${job.id} is leased by another invocation; skipping.`);
    return;
  }

  const remainingEventIds = JSON.parse(job.remaining_event_ids_json || '[]');
  const eventById = new Map((await getUpcomingInventoryEvents(env.DB, adapter.venueId))
    .map(event => [event.event_id, event]));
  const batchLimit = Math.min(adapter.inventoryBatchSize, remainingEventIds.length);
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const productionTimings = new Map();

  while (attempted < batchLimit && remainingEventIds.length && Date.now() < deadlineMs) {
    const eventId = remainingEventIds.shift();
    const targetRow = eventById.get(eventId);
    attempted += 1;
    if (!targetRow) {
      skipped += 1;
      continue;
    }
    const result = await executeScanForTarget(targetRow, env, ctx, {
      now: new Date(), skipJitter: true, runParser: true,
      logPrefix: '[ALL EVENTS INVENTORY]', adapter,
      inventoryJobId: job.id, scanSource: 'all_events_inventory',
      targetQuantities: adapter.inventoryTargetQuantities
    });
    if (result.status === 'completed') completed += 1;
    else if (result.status === 'skipped') skipped += 1;
    else failed += 1;
    if (result.dropDetected) await deliverPendingDropAlerts(env, 5);
    const production = productionTimings.get(targetRow.show_name) || { events: 0, durationMs: 0 };
    production.events += 1;
    production.durationMs += Number(result.durationMs) || 0;
    productionTimings.set(targetRow.show_name, production);
  }

  const completedEventCount = Number(job.completed_event_count) + completed;
  const failedEventCount = Number(job.failed_event_count) + failed;
  const skippedEventCount = Number(job.skipped_event_count) + skipped;
  const batchNumber = Number(job.batch_count) + 1;
  const batchCompletedAt = new Date();
  const checkpoint = {
    id: job.id, leaseOwner, remainingEventIds,
    completedEventCount, failedEventCount, skippedEventCount, batchCount: batchNumber,
    lastError: failed ? `${failed} event scan(s) failed in batch ${batchNumber}` : null,
    updatedAt: batchCompletedAt.toISOString()
  };
  await recordInventoryJobBatchMetric(env.DB, {
    id: buildWorkerLogId(), jobId: job.id, venueId: adapter.venueId, batchNumber,
    startedAt: batchStartedAt.toISOString(), completedAt: batchCompletedAt.toISOString(),
    durationMs: batchCompletedAt.getTime() - batchStartedAt.getTime(), attemptedEventCount: attempted,
    completedEventCount: completed, failedEventCount: failed, skippedEventCount: skipped,
    remainingEventCount: remainingEventIds.length
  });
  if (!remainingEventIds.length) {
    await completeInventoryJob(env.DB, { ...checkpoint, completedAt: batchCompletedAt.toISOString() });
    console.log(`[ALL EVENTS INVENTORY] Job complete: ${job.total_event_count} events in ${batchNumber} batch(es), ${batchCompletedAt.getTime() - new Date(job.started_at).getTime()}ms total.`, {
      completed: completedEventCount, failed: failedEventCount, skipped: skippedEventCount,
      productions: Object.fromEntries(productionTimings)
    });
  } else {
    await checkpointInventoryJob(env.DB, checkpoint);
    console.log('[ALL EVENTS INVENTORY] Batch checkpointed', {
      jobId: job.id, batchNumber, attempted, completed, failed, skipped,
      remaining: remainingEventIds.length, durationMs: batchCompletedAt.getTime() - batchStartedAt.getTime(),
      productions: Object.fromEntries(productionTimings)
    });
  }
}

// Drop watches run ahead of the broad inventory sweep. They use precisely the
// same parser and snapshot writer, but their state machine is intentionally
// simpler: zero parsed available seats is sold_out; any later positive count is
// an alertable drop. Candidate blocks and resale buffer rules do not apply.
async function runDropWatchForVenue(adapter, env, ctx, now) {
  const targets = await getDueDropWatchEvents(env.DB, adapter.venueId, adapter.dropWatchBatchSize,
    adapter.automaticSoldOutIntervalMinutes);
  if (!targets.length) return { attempted: 0, completed: 0, failed: 0 };

  console.log(`[DROP WATCH] ${adapter.venueName}: scanning ${targets.length} due high-priority performance(s).`);
  let completed = 0;
  let failed = 0;
  for (const targetRow of targets) {
    const result = await executeScanForTarget(targetRow, env, ctx, {
      now: new Date(), skipJitter: true, runParser: true,
      logPrefix: '[DROP WATCH]', adapter,
      scanSource: 'drop_watch_inventory',
      targetQuantities: adapter.inventoryTargetQuantities,
      dropWatch: true
    });
    if (result.status === 'completed') completed += 1;
    else failed += 1;
    if (result.dropDetected) await deliverPendingDropAlerts(env, 5);
  }
  console.log('[DROP WATCH] Priority pass complete', { attempted: targets.length, completed, failed });
  return { attempted: targets.length, completed, failed };
}

async function runScheduledCycle(env, ctx, options = {}) {
  const now = options.now || new Date();
  const scheduleMode = options.forcedMode || getScheduleModeForCronDate(now);

  try {
    console.log('====================================================');
    console.log(`[MARKET ENGINE] USA Multi-Venue Priority Engine Cycle Woken Up [${scheduleMode}]`);
    console.log('====================================================');

    const activeAdapters = await getActiveVenueAdapters(env.DB, env);
    const activeVenueIds = activeAdapters.map(adapter => adapter.venueId);

    if (scheduleMode === 'listing_watch') {
      await trackWorkerLog(env, ctx, 'info', 'Fast listing watcher pass started', { scheduleMode });
      console.log('[LISTING WATCHER] Fast 10-minute pass: checking active listings and stale-state exposures.');

      const targetRow = await getNextEventWithActiveListing(env.DB, activeVenueIds);
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

    if (scheduleMode === 'drop_watch') {
      await trackWorkerLog(env, ctx, 'info', 'High-priority sold-out drop-watch pass started', { scheduleMode });
      for (const adapter of activeAdapters) {
        await deliverPendingDropAlerts(env, 20);
        await runDropWatchForVenue(adapter, env, ctx, now);
      }
      return;
    }

    // Handle Discovery Scans
    if (scheduleMode === 'discovery_scan') {
      await trackWorkerLog(env, ctx, 'info', 'Discovery scan pass started', { scheduleMode });
      console.log('[DISCOVERY SCAN] Initiating discovery for all active venues.');

      for (const adapter of activeAdapters) {
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
            jitterMin: SCAN_JITTER_CONFIG.inventoryScan.minMs,
            jitterMax: SCAN_JITTER_CONFIG.inventoryScan.maxMs,
            runParser: true,
            logPrefix: '[DISCOVERY SCAN]',
            adapter
          });
        }
      }
      console.log('[DISCOVERY SCAN] Discovery pass complete.');
      return; // Discovery scan is a distinct job, so return after it's done.
    }

    // Run the cleanup job before the bounded all-events inventory batch.
    if (scheduleMode === 'inventory_scan') {
      await Promise.all([cleanupPastEvents(env.DB), cleanupOldWorkerLogs(env.DB)]);
    }
    for (const adapter of activeAdapters) await runInventoryJobForVenue(adapter, env, ctx, now);
  } catch (err) {
    console.error('[SCHEDULED ERROR]', err);
    await trackWorkerLog(env, ctx, 'error', 'Scheduled handler failed', { scheduleMode, error: String(err) });
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // Authenticated operational trigger for an immediate recovery/seed pass.
    // It intentionally exposes only existing bounded scheduler modes; callers
    // cannot supply arbitrary jobs or venue IDs.
    if (request.method === 'POST' && url.pathname === '/operations/run') {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const mode = body?.mode;
      if (!['discovery_scan', 'drop_watch', 'inventory_scan'].includes(mode)) {
        return new Response(JSON.stringify({ error: 'mode must be discovery_scan, drop_watch, or inventory_scan' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      const run = runScheduledCycle(env, ctx, { forcedMode: mode });
      ctx.waitUntil(run);
      return new Response(JSON.stringify({ accepted: true, mode, started_at: new Date().toISOString() }), {
        status: 202, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/monitoring/targets' || url.pathname === '/targets') {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      const adapters = await getActiveVenueAdapters(env.DB, env);
      return new Response(JSON.stringify({
        generated_at: new Date().toISOString(),
        listing_enabled: isSkyboxListingEnabled(env),
        monitoring_only: !isSkyboxListingEnabled(env),
        targets: adapters.map(buildPublicVenueSummary),
        venue_smoke_matrix: buildVenueAdapterSmokeReport(adapters),
        venue_adapters: buildPublicAdapterSummaries(adapters),
        telemetry: buildOperationalTelemetrySnapshot(new Date(), env, adapters)
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
      const logs = await getRecentWorkerLogs(env, limit);
      return new Response(JSON.stringify({ logs }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST' && (url.pathname === '/inventory/single-event' || url.pathname === '/inventory/test')) {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON format' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const eventId = String(payload?.event_id || '').trim();
      const target = payload?.target || null;
      const targetQuantity = Number(payload?.quantity ?? target?.quantity ?? 1);
      const includeSeatSamples = payload?.include_seat_samples === true;
      const hasValidTarget = !target || (
        ['section', 'row', 'seat'].every(field => typeof target[field] === 'string' && target[field].trim())
        && Number.isInteger(Number(target.price_cents))
        && Number(target.price_cents) >= 0
      );
      if (!eventId || eventId.length > 128) {
        return new Response(JSON.stringify({ error: 'event_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!hasValidTarget || !Number.isInteger(targetQuantity) || targetQuantity <= 0 || targetQuantity > 10) {
        return new Response(JSON.stringify({ error: 'quantity must be an integer from 1 to 10; an optional target requires section, row, seat, and price_cents' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const activeVenueIds = (await getActiveVenueAdapters(env.DB, env)).map(adapter => adapter.venueId);
      const targetRow = await getUpcomingEventById(env.DB, eventId, activeVenueIds);
      if (!targetRow) {
        return new Response(JSON.stringify({ error: 'Active upcoming event not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      console.log(`[SINGLE EVENT INVENTORY] Running ${targetRow.show_name} (event ${eventId}).`);
      const result = await executeScanForTarget(targetRow, env, ctx, {
        now: new Date(),
        jitterMin: 0,
        jitterMax: 0,
        skipJitter: true,
        runParser: true,
        logPrefix: '[SINGLE EVENT INVENTORY]',
        targetQuantity
      });
      if (result?.status !== 'completed') {
        const status = result?.status === 'skipped' ? 409 : 502;
        return new Response(JSON.stringify({
          mode: 'monitoring_only',
          event_id: eventId,
          show_name: targetRow.show_name,
          showtime: targetRow.showtime,
          ...result
        }), { status, headers: { 'Content-Type': 'application/json' } });
      }
      if (!target) {
        const coveragePools = summarizeEquivalentInventoryPools(targetRow.venue_id, eventId, result.inventory, targetQuantity, includeSeatSamples);
        const candidateBlocks = result.inventoryCandidates || [];
        const qualifyingPoolCount = new Set(candidateBlocks.map(candidate => [
          candidate.section, candidate.priceLevel, candidate.seatQuality, candidate.priceCents
        ].join('|'))).size;
        const sections = summarizeAvailableSeatsBySection(result.inventory);
        return new Response(JSON.stringify({
          mode: 'monitoring_only',
          event_id: eventId,
          show_name: targetRow.show_name,
          showtime: targetRow.showtime,
          status: 'INVENTORY_PROFILED',
          inventoryCount: result.inventoryCount,
          targetQuantity,
          requiredMinimum: targetQuantity * (1 + Number(result.requiredBufferBlockCount || 0)),
          requiredBufferBlockCount: result.requiredBufferBlockCount,
          candidatePolicy: result.candidatePolicy,
          poolCount: coveragePools.length,
          qualifyingPoolCount,
          candidateBlockCount: candidateBlocks.length,
          sections,
          pricePoints: coveragePools,
          qualifyingCandidateBlocks: candidateBlocks.slice(0, 100)
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const matchingSeat = result.inventory.find(item => isSpecificSeatMatch(item, {
        section: target.section,
        row: target.row,
        seat: target.seat
      }));
      const normalizedTarget = {
        section: target.section.trim(),
        row: target.row.trim(),
        seat: target.seat.trim(),
        priceCents: Number(target.price_cents),
        quantity: targetQuantity
      };
      if (!matchingSeat) {
        return new Response(JSON.stringify({
          mode: 'monitoring_only', event_id: eventId, show_name: targetRow.show_name, showtime: targetRow.showtime,
          status: 'REJECTED', reason: 'Target seat is not available on the primary market', target: normalizedTarget
        }), { status: 410, headers: { 'Content-Type': 'application/json' } });
      }
      if (!isPriceParityMatch(matchingSeat, normalizedTarget)) {
        return new Response(JSON.stringify({
          mode: 'monitoring_only', event_id: eventId, show_name: targetRow.show_name, showtime: targetRow.showtime,
          status: 'REJECTED', reason: 'Target seat is available but its live price does not match', target: normalizedTarget,
          livePriceCents: matchingSeat.priceCents
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      const coverage = evaluateEquivalentInventoryCoverage({
        venueId: targetRow.venue_id,
        eventId,
        section: normalizedTarget.section,
        priceLevel: matchingSeat.priceLevel,
        seatQuality: matchingSeat.seatQuality,
        quantity: targetQuantity
      }, result.inventory);
      const status = coverage.meetsRequirement ? 200 : 202;
      return new Response(JSON.stringify({
        mode: 'monitoring_only',
        event_id: eventId,
        show_name: targetRow.show_name,
        showtime: targetRow.showtime,
        status: coverage.meetsRequirement ? 'QUALIFYING' : 'HOLD',
        target: normalizedTarget,
        inventoryCount: result.inventoryCount,
        coverage
      }), { status, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/') {
      const adapters = await getActiveVenueAdapters(env.DB, env);
      return new Response(JSON.stringify({
        service: 'Ticket Agent',
        status: 'active',
        listing_enabled: isSkyboxListingEnabled(env),
        monitoring_only: !isSkyboxListingEnabled(env),
        monitored_targets: adapters.map(buildPublicVenueSummary),
        venue_smoke_matrix: buildVenueAdapterSmokeReport(adapters),
        venue_adapters: buildPublicAdapterSummaries(adapters),
        telemetry: buildOperationalTelemetrySnapshot(new Date(), env, adapters)
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
      const activeVenueIds = (await getActiveVenueAdapters(env.DB, env)).map(adapter => adapter.venueId);
      const targetRow = await getListingForValidation(env.DB, incomingListingId, activeVenueIds);

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

      const adapter = await getVenueAdapter(env.DB, env, targetRow.venue_id);
      if (!adapter) {
        return new Response(JSON.stringify({ status: 'REJECTED', reason: 'Venue adapter is not active or valid' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      const venueTimezone = inferVenueTimeZone(targetRow.venue_name, null, targetRow.timezone_name);
      if (!isMonitoringWindowActive(new Date(), venueTimezone, adapter.businessHours)) {
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

      const strategyFn = adapter && STRATEGY_REGISTRY[adapter.inventoryStrategy]; // Correctly use inventoryStrategy
      const boundDebugLog = (message, level) => debugLogAndNotify(env, ctx, message, level);
      const boundApiFetch = (url, opts) => executeApiFetch(url, { ...opts, debugLog: boundDebugLog });

      const inventory = await (strategyFn ? strategyFn(targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, boundApiFetch) : Promise.resolve([]));
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

        const notificationMsg = `🛑 SPECIFIC SEAT LOCATION EXPOSURE NEUTRALIZED 🛑
Venue: ${targetRow.venue_name}
Show: ${targetRow.show_name}
Date: ${printableShowtime}
Target: Section ${targetRow.section_label} | Row ${targetRow.row_label} | ${targetRow.seat_label}
Listing ID: ${incomingListingId}

Outcome: Transaction blocked automatically before a ghost sale collision could occur.`;
        sendTelegramNotification(env, ctx, notificationMsg, 'critical');

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
    //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-drop-watch"
    //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-inventory-scan"
    //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-listing-watch"
    // Real Cloudflare cron always sends one of the actual configured cron strings, never these
    // sentinels, so this override is inert in production.
    const forcedMode =
      event?.cron === 'test-drop-watch' ? 'drop_watch' :
      (event?.cron === 'test-inventory-scan' || event?.cron === 'test-primary-scan') ? 'inventory_scan' :
      event?.cron === 'test-listing-watch' ? 'listing_watch' :
      event?.cron === 'test-discovery-scan' ? 'discovery_scan' :
      undefined;
    const cycle = runScheduledCycle(env, ctx, forcedMode ? { forcedMode } : {});
    // Scheduled events must acknowledge promptly. The work continues under
    // waitUntil rather than holding the local cron HTTP trigger open.
    if (ctx?.waitUntil) {
      ctx.waitUntil(cycle);
      return;
    }
    await cycle;
  },
};
