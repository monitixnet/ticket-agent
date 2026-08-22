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
  recordInventoryEndpointTelemetry,
  getDueDropWatchEvents,
  getStaleCriticalDropWatchEvents,
  getDropWatchHealthAlertState,
  setDropWatchHealthAlertState,
  clearDropWatchHealthAlertState,
  recordInventoryAvailabilityObservation,
  recordInventoryCandidateObservation,
  getPendingInventoryDropAlerts,
  getPendingInventoryCandidateAlerts,
  markInventoryDropAlertDelivered,
  markInventoryDropAlertFailed,
  markInventoryCandidateAlertDelivered,
  markInventoryCandidateAlertFailed,
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
  formatVenueLocalTime,
  getScheduleModeForCronDate,
  isSkyboxListingEnabled,
  isBlockLikeStatus,
  computeBackoffDelayMs,
  isVenueValidationResponse
} from './venue-logic.js';
import { STRATEGY_REGISTRY, segerstromSingleProductionDiscovery, formatJobDuration } from './strategies.js';
import { FETCH_PROVIDERS } from './fetch-providers.js';
import { computeStringHash, delayExecution, randomBetween, computeJitteredDelay, buildWorkerLogId, timingSafeEqual } from './utils.js';
import { getVenueAdapter, buildPublicVenueSummary } from './database/venue-runtime-config.js';
import { calculateCandidateCheckoutAmounts } from './checkout-fees.js';
import {
  runEphemeralSessionBootstrap,
  runEphemeralBootstrapThenTarget,
  isSessionRedirectResponse,
  loadVenueSessionCookieHeader,
  mergeCookieHeaders,
  saveVenueSessionCookieHeader,
  sessionRequestHeaders
} from './session-manager.js';
export { buildServerIssuedCookieHeader } from './session-manager.js';

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
  // `null` is the persisted representation of an unbounded rule. Do not
  // coerce it with Number(null), which would silently turn it into a $0 cap.
  if (maxPriceCents === null || maxPriceCents === undefined || maxPriceCents === '') return inventory;
  if (!Number.isFinite(Number(maxPriceCents))) return [];
  const limit = Number(maxPriceCents);
  return inventory.filter(item => item?.priceCents != null && Number.isFinite(Number(item.priceCents))
    && Number(item.priceCents) <= limit);
}

export function normalizeDropPriceCapCents(value) {
  // D1 represents an unbounded rule as NULL. Preserve that rather than
  // allowing JavaScript's Number(null) coercion to create a $0 ceiling.
  if (value === null || value === undefined || value === '') return null;
  const cents = Number(value);
  return Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : null;
}

function buildPublicAdapterSummaries(adapters = []) {
  return adapters.map(buildPublicVenueSummary);
}

// One deployment is one venue/tenant. This prevents a venue's cron or provider
// budget from accidentally operating on every active D1 venue.
async function getWorkerScopedAdapters(env) {
  const venueId = String(env?.WORKER_VENUE_ID || '').trim();
  if (!venueId) {
    console.error('[CONFIG] WORKER_VENUE_ID is required; this Worker will not load any venue.');
    return [];
  }
  const adapter = await getVenueAdapter(env.DB, env, venueId);
  if (!adapter) console.error(`[CONFIG] WORKER_VENUE_ID=${venueId} is not an active, valid venue adapter.`);
  return adapter ? [adapter] : [];
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
export function buildNotificationRequest(url, message) {
  const endpoint = new URL(url);
  const isTelegramSendMessage = endpoint.hostname === 'api.telegram.org'
    && /\/bot[^/]+\/sendMessage$/i.test(endpoint.pathname);
  if (isTelegramSendMessage) {
    const chatId = endpoint.searchParams.get('chat_id');
    if (!chatId) throw new Error('Telegram notification URL must include chat_id.');
    endpoint.searchParams.delete('chat_id');
    endpoint.searchParams.delete('text');
    return {
      url: endpoint.toString(),
      body: JSON.stringify({ chat_id: chatId, text: message })
    };
  }
  return {
    url,
    body: JSON.stringify({ content: `\`\`\`\n${message}\n\`\`\`` })
  };
}

async function postNotification(url, message) {
  const request = buildNotificationRequest(url, message);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: request.body
  });
  if (!response.ok) throw new Error(`notification endpoint returned HTTP ${response.status}`);
}

function sendTelegramNotification(env, ctx, message, channel = 'debug') {
  const url = channel === 'critical'
    ? env.CRITICAL_NOTIFICATION_OUTBOUND_URL
    : env.NOTIFICATION_OUTBOUND_URL;

  // Only send if an appropriate URL is configured.
  if (url) {
    const promise = postNotification(url, message)
      .catch(err => console.error(`[TELEGRAM NOTIFY FAILED] ${err.message}`));
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
  await postNotification(url, message);
}

function formatCurrency(cents) {
  return Number.isFinite(Number(cents)) ? `$${(Number(cents) / 100).toFixed(2)}` : 'price unavailable';
}

// Event times from Tessitura are a mix of ISO instants and venue-local D1
// timestamps. Preserve a timezone-less value as the venue's wall-clock time;
// convert an ISO instant into the venue timezone. Telegram should never expose
// raw database timestamps to an operator.
export function formatAlertDateTime(value, timeZone = 'America/Los_Angeles') {
  const raw = String(value || '').trim();
  if (!raw) return 'time unavailable';
  const options = {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  };
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasExplicitZone) {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone, timeZoneName: 'short' }).format(date);
    }
  }
  const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!parts) return raw;
  const wallClock = new Date(Date.UTC(
    Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5])
  ));
  const display = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(wallClock);
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(wallClock).find(part => part.type === 'timeZoneName')?.value;
  return zoneName ? `${display} ${zoneName}` : display;
}

export function formatAvailabilityPriority(adapter, observation = {}) {
  const policy = adapter?.availabilityPriorityPolicy || {};
  if (!(policy.enabled === true || policy.enabled === 1)) return null;
  const availableBps = Number(observation.availablePercentageBasisPoints);
  if (!Number.isFinite(availableBps) || availableBps < 0 || availableBps > 10_000) return null;
  const criticalMax = Number(policy.criticalMaxAvailableBasisPoints);
  if (!Number.isFinite(criticalMax) || availableBps > criticalMax) return null;
  const formatPercent = basisPoints => {
    const percent = basisPoints / 100;
    return Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, '');
  };
  const soldOutBps = 10_000 - availableBps;
  return `CRITICAL — ${formatPercent(soldOutBps)}% SOLD OUT (${formatPercent(availableBps)}% available)`;
}

export function buildDropAlertMessage(payload = {}) {
  const maxPriceCents = normalizeDropPriceCapCents(payload.maxPriceCents);
  const priceRule = maxPriceCents !== null
    ? `Price rule: $${(maxPriceCents / 100).toFixed(2)} or less`
    : 'Price rule: any available price';
  const priceRange = payload.lowestQualifyingPriceCents == null
    ? 'No qualifying price found'
    : `${formatCurrency(payload.lowestQualifyingPriceCents)}–${formatCurrency(payload.highestQualifyingPriceCents)}`;
  const sectionSummary = (payload.sectionSummaries || [])
    .slice(0, 4)
    .map(section => `${section.section}: ${section.availableSeats}`)
    .join(' | ') || 'No section summary available';
  const seatSamples = (payload.eligibleSeatSamples || [])
    .slice(0, 4)
    .map(seat => `${seat.section}, Row ${seat.row}, Seat ${seat.seat} (${formatCurrency(seat.priceCents)})`)
    .join('\n') || 'No individual eligible-seat sample available';
  const candidateSamples = (payload.eligibleCandidateBlocks || [])
    .slice(0, 3)
    .map(candidate => `Qty ${candidate.targetQuantity}: ${candidate.section}, Row ${candidate.row}, Seats ${candidate.startSeat}–${candidate.endSeat} (${formatCurrency(candidate.priceCents)})`)
    .join('\n');
  return [
    '🚨 TICKET DROP DETECTED',
    `Venue: ${payload.venueName}`,
    `Hall: ${payload.venueHall || 'unresolved'}`,
    `Show: ${payload.showName}`,
    `Performance: ${formatAlertDateTime(payload.showtime, payload.timezoneName)}`,
    ...(payload.availabilityPriority ? [`Priority: ${payload.availabilityPriority}`] : []),
    `Event ID: ${payload.eventId}`,
    `Eligible seats detected: ${payload.availableItemCount} (${priceRange})`,
    priceRule,
    `Sections: ${sectionSummary}`,
    `Eligible-seat sample:\n${seatSamples}`,
    ...(candidateSamples ? [`Buffered candidate blocks:\n${candidateSamples}`] : []),
    `Observed: ${formatAlertDateTime(payload.observedAt, payload.timezoneName)}`,
    `Buy: ${payload.eventUrl || 'direct URL unavailable'}`,
    'Possible opportunity only—verify live availability and resale economics before buying.'
  ].join('\n');
}

export function buildCandidateAlertMessage(payload = {}) {
  const candidates = (payload.candidates || []).slice(0, 3);
  const candidateLines = candidates.map(candidate => {
    const amounts = calculateCandidateCheckoutAmounts(
      candidate.priceCents, candidate.targetQuantity, payload.checkoutFeeRule
    );
    const priceDetail = amounts
      ? `${formatCurrency(amounts.unitPriceCents)} + ${formatCurrency(amounts.feePerTicketCents)} fee = ${formatCurrency(amounts.allInPerTicketCents)} each; ${formatCurrency(amounts.allInTotalCents)} all-in total`
      : formatCurrency(candidate.priceCents);
    return `Qty ${candidate.targetQuantity}: ${candidate.section}, Row ${candidate.row}, Seats ${candidate.startSeat}–${candidate.endSeat} (${priceDetail})`;
  }).join('\n') || 'No qualified target block available';
  return [
    '🎟️ QUALIFIED INVENTORY CANDIDATE',
    `Venue: ${payload.venueName}`,
    `Hall: ${payload.venueHall || 'unresolved'}`,
    `Show: ${payload.showName}`,
    `Performance: ${formatAlertDateTime(payload.showtime, payload.timezoneName)}`,
    ...(payload.availabilityPriority ? [`Priority: ${payload.availabilityPriority}`] : []),
    `Candidates:\n${candidateLines}`,
    `Observed: ${formatAlertDateTime(payload.observedAt, payload.timezoneName)}`,
    `Buy: ${payload.eventUrl || 'direct URL unavailable'}`,
    'Possible opportunity only—verify live availability and resale economics before buying.'
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

async function deliverPendingCandidateAlerts(env, limit = 10) {
  const alerts = await getPendingInventoryCandidateAlerts(env.DB, limit);
  for (const alert of alerts) {
    let payload = {};
    try { payload = JSON.parse(alert.payload_json || '{}'); } catch { payload = {}; }
    try {
      await postNotification(env.NOTIFICATION_OUTBOUND_URL, buildCandidateAlertMessage(payload));
      await markInventoryCandidateAlertDelivered(env.DB, alert.id, new Date().toISOString());
      console.log(`[CANDIDATE ALERT] Delivered for event ${alert.event_id}.`);
    } catch (error) {
      const attempt = Number(alert.attempt_count || 0) + 1;
      const retryMs = Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempt, 5)));
      await markInventoryCandidateAlertFailed(env.DB, alert.id, error.message,
        new Date(Date.now() + retryMs).toISOString());
      console.error(`[CANDIDATE ALERT] Delivery failed for event ${alert.event_id}: ${error.message}`);
    }
  }
  return alerts.length;
}

export function buildStaleDropWatchAlertMessage(adapter, staleEvents, staleAfterMinutes, observedAt) {
  const byShow = new Map();
  for (const event of staleEvents) {
    const showName = event.show_name || 'Unknown show';
    const group = byShow.get(showName) || { count: 0, oldest: event.last_observed_at || 'never' };
    group.count += 1;
    if (!group.oldest || group.oldest === 'never' || (event.last_observed_at && event.last_observed_at < group.oldest)) {
      group.oldest = event.last_observed_at || 'never';
    }
    byShow.set(showName, group);
  }
  const details = [...byShow.entries()]
    .map(([showName, group]) => `${showName}: ${group.count} performance(s), oldest scan ${group.oldest === 'never'
      ? 'never' : formatAlertDateTime(group.oldest, adapter.timezoneName)}`)
    .join('\n');
  return [
    '⚠️ CRITICAL DROP WATCH STALE',
    `Venue: ${adapter.venueName}`,
    `No successful inventory observation within ${staleAfterMinutes} minutes:`,
    details,
    `Observed: ${formatAlertDateTime(observedAt, adapter.timezoneName)}`,
    'Action: Check Worker logs and venue access before relying on drop alerts.'
  ].join('\n');
}

async function auditCriticalDropWatchHealth(adapter, env, ctx, now) {
  const criticalIntervalMinutes = Number(adapter.dropWatchIntervalsMinutes?.critical) || 5;
  const staleAfterMinutes = criticalIntervalMinutes * 2;
  const staleEvents = await getStaleCriticalDropWatchEvents(env.DB, adapter.venueId, staleAfterMinutes);
  if (!staleEvents.length) {
    await clearDropWatchHealthAlertState(env.DB, adapter.venueId);
    console.log('[DROP WATCH HEALTH] Critical watches are current.', { venueId: adapter.venueId, staleAfterMinutes });
    return { staleCount: 0, alerted: false };
  }

  const state = await getDropWatchHealthAlertState(env.DB, adapter.venueId);
  const lastNotifiedMs = Date.parse(state?.lastNotifiedAt || '');
  const throttleMs = 30 * 60 * 1000;
  const shouldAlert = !Number.isFinite(lastNotifiedMs) || (now.getTime() - lastNotifiedMs) >= throttleMs;
  const context = {
    venueId: adapter.venueId,
    staleAfterMinutes,
    staleCount: staleEvents.length,
    staleEventIds: staleEvents.map(event => event.event_id),
    shows: [...new Set(staleEvents.map(event => event.show_name))]
  };
  await trackWorkerLog(env, ctx, 'error', 'Critical drop-watch freshness violation', context);
  console.error('[DROP WATCH HEALTH] Critical watches are stale.', context);
  if (shouldAlert) {
    try {
      await deliverCriticalNotification(env, buildStaleDropWatchAlertMessage(
        adapter, staleEvents, staleAfterMinutes, now.toISOString()
      ));
      await setDropWatchHealthAlertState(env.DB, adapter.venueId, {
        lastNotifiedAt: now.toISOString(), staleEventIds: staleEvents.map(event => event.event_id)
      });
    } catch (error) {
      // Observability must never prevent the recovery scan that can repair the
      // stale condition. Leave the throttle state untouched so the next pass
      // retries notification delivery.
      console.error(`[DROP WATCH HEALTH] Stale-watch alert delivery failed: ${error.message}`);
      await trackWorkerLog(env, ctx, 'error', 'Critical drop-watch stale alert delivery failed', {
        ...context, error: error.message
      });
    }
  }
  return { staleCount: staleEvents.length, alerted: shouldAlert };
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
      consumeExternalRequestBudget(options.requestBudget, `API ${method} ${url}`);
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
      if (err?.code === 'SUBREQUEST_BUDGET_EXHAUSTED') throw err;
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
  // Native is the fail-closed default. Venue-specific approved pools are
  // supplied from the D1 adapter; missing deployment variables never revive a
  // paid proxy or browser provider.
  const configuredPool = fetchOptions.providerPool;
  const providerPool = (Array.isArray(configuredPool) ? configuredPool : String(configuredPool || 'native').split(','))
    .map(provider => String(provider).trim()).filter(Boolean);

  let lastResult = null;

  for (const providerName of providerPool) {
    const provider = FETCH_PROVIDERS[providerName];
    if (!provider) {
      console.warn(`[PROVIDER POOL] Invalid provider specified in pool: ${providerName}. Skipping.`);
      continue;
    }

    try {
      consumeExternalRequestBudget(fetchOptions.requestBudget, `${providerName} ${method} ${targetUrlString}`);
      const requestStartedAt = Date.now();
      const result = await provider(env, targetUrlString, targetRow, fetchOptions);
      if (typeof fetchOptions.onFetchResult === 'function') {
        await fetchOptions.onFetchResult(result, Date.now() - requestStartedAt);
      }
      lastResult = result;

      // SeatMe sometimes returns its human-validation HTML with a 200 status.
      // It is neither inventory nor a recoverable parser error: stop this
      // venue cleanly so a later invocation can resume from its checkpoint.
      if (isVenueValidationResponse(result)) {
        const error = new Error(`Venue validation challenge received from ${targetUrlString}.`);
        error.code = 'VENUE_VALIDATION_CHALLENGE';
        error.endpointUrl = targetUrlString;
        error.provider = providerName;
        throw error;
      }

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
      if (err?.code === 'SUBREQUEST_BUDGET_EXHAUSTED') throw err;
      if (err?.code === 'VENUE_VALIDATION_CHALLENGE') throw err;
      console.error(`[PROVIDER POOL] Provider ${providerName} threw an exception: ${err.message}. Attempting next provider.`);
      lastResult = { status: 500, text: err.message, routedVia: providerName };
    }
  }

  // If all providers in the pool failed, return the last known result.
  console.error(`[PROVIDER POOL] All fetch providers failed. Returning last known result.`);
  return lastResult || { status: 503, text: 'All fetch providers in the pool failed.', routedVia: 'provider_pool' };
}

function consumeExternalRequestBudget(requestBudget, requestLabel) {
  if (!requestBudget) return;
  if (!Number.isFinite(requestBudget.remaining) || requestBudget.remaining < 1) {
    const error = new Error(`External subrequest budget exhausted before ${requestLabel}.`);
    error.code = 'SUBREQUEST_BUDGET_EXHAUSTED';
    throw error;
  }
  requestBudget.remaining -= 1;
}

export function isSubrequestBudgetExhaustion(error) {
  return error?.code === 'SUBREQUEST_BUDGET_EXHAUSTED'
    || /subrequest budget exhausted/i.test(String(error?.message || error || ''));
}

export function isVenueValidationChallenge(error) {
  return error?.code === 'VENUE_VALIDATION_CHALLENGE';
}

// The bounded session smoke test retains only cookies issued during the same
// Worker invocation. It never accepts a client cookie, emits values in a
// response/log, or persists state. Cookie retention beyond this test requires
// a separately reviewed encrypted session store.
async function executeScanForTarget(targetRow, env, ctx, options = {}) {
  const scanStartedAtMs = Date.now();
  const { now, jitterMin, jitterMax, runParser, logPrefix = '[SCAN]', adapter: suppliedAdapter, skipJitter = false } = options;
  const adapter = suppliedAdapter || await getVenueAdapter(env.DB, env, targetRow.venue_id);
  if (!adapter) {
    console.warn(`${logPrefix} Skipping ${targetRow.show_name}; venue ${targetRow.venue_id} has no valid active adapter.`);
    return { status: 'skipped', reason: 'invalid_adapter' };
  }

  const isDiscovery = logPrefix === '[DISCOVERY SCAN]';
  if (!isDiscovery) {
    const hallPolicy = targetRow.venue_hall_id
      ? await getHallInventoryPolicy(env.DB, targetRow.venue_hall_id)
      : null;
    if (!hallPolicy?.inventoryEnabled) {
      console.log(`${logPrefix} Skipping ${targetRow.show_name}; ${targetRow.venue_hall || 'unclassified hall'} is discovery-only.`);
      return { status: 'skipped', reason: 'hall_inventory_disabled' };
    }
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

    const rawSecureFetchForScan = (fetchEnv, url, row, fetchOptions = {}) => executeSecureFetch(fetchEnv, url, row, {
      ...fetchOptions,
      providerPool: fetchOptions.providerPool || (fetchOptions.apiRequest ? adapter.apiFetchProviderPool : adapter.fetchProviderPool),
      requestBudget: fetchOptions.requestBudget || options.requestBudget,
      // Endpoint rows are intentionally opt-in diagnostics. Redirect handling
      // itself is always enabled, but normal production scans do not write one
      // D1 row per HTTP response unless debug telemetry is explicitly enabled.
      onFetchResult: adapter.debugTelemetryEnabled && !isDiscovery && fetchOptions.inventoryEndpoint
        ? async (result, durationMs) => {
          const isRedirect = Number(result?.status) >= 300 && Number(result?.status) < 400;
          const contentType = result?.contentType || null;
          const isJsonContent = !contentType || /(?:application|text)\/json/i.test(contentType);
          const isValidationChallenge = isVenueValidationResponse(result);
          await recordInventoryEndpointTelemetry(env.DB, {
            id: buildWorkerLogId(), eventId: targetRow.event_id, venueId: targetRow.venue_id,
            inventoryJobId: options.inventoryJobId, endpointType: fetchOptions.inventoryEndpoint,
            provider: result?.routedVia, httpStatus: result?.status, contentType,
            redirectDetected: isRedirect,
            outcome: isValidationChallenge ? 'venue_validation_challenge'
              : (isRedirect ? 'redirect'
              : (!isJsonContent ? 'unexpected_content_type'
                : (Number(result?.status) >= 200 && Number(result?.status) < 300 ? 'success' : 'http_error'))),
            durationMs
          });
        }
        : fetchOptions.onFetchResult
    });
    const apiProviderPool = Array.isArray(adapter.apiFetchProviderPool) ? adapter.apiFetchProviderPool : [];
    const sessionBootstrapEnabled = adapter.sessionBootstrapEnabled === true
      && apiProviderPool.length === 1
      && apiProviderPool[0] === 'native';
    const sessionTtlMs = Math.max(60_000, Number(adapter.sessionTtlMinutes) || 15) * 60_000;
    let sessionCookieHeader = sessionBootstrapEnabled
      ? await loadVenueSessionCookieHeader(env.DB, env, targetRow.venue_id)
      : '';
    const persistSessionCookies = async result => {
      const issuedHeader = mergeCookieHeaders(result?.setCookies ? result.setCookies.map(cookie => String(cookie).split(';', 1)[0]).join('; ') : '');
      if (!issuedHeader) return;
      sessionCookieHeader = mergeCookieHeaders(sessionCookieHeader, issuedHeader);
      await saveVenueSessionCookieHeader(env.DB, env, targetRow.venue_id, sessionCookieHeader, sessionTtlMs);
    };
    const secureFetchForScan = async (fetchEnv, url, row, fetchOptions = {}) => {
      const managesSession = sessionBootstrapEnabled
        && fetchOptions.apiRequest === true
        && url.startsWith('https://seatme.scfta.org/api/');
      if (!managesSession) return rawSecureFetchForScan(fetchEnv, url, row, fetchOptions);

      const requestHeaders = {
        ...sessionRequestHeaders(),
        ...(fetchOptions.headers || {}),
        ...(sessionCookieHeader ? { Cookie: sessionCookieHeader } : {})
      };
      const initial = await rawSecureFetchForScan(fetchEnv, url, row, { ...fetchOptions, headers: requestHeaders });
      await persistSessionCookies(initial);
      if (!isSessionRedirectResponse(initial)) return initial;

      const cartBootstrapUrl = `https://www.scfta.org/cart/updatecart?returnurl=${encodeURIComponent(url)}`;
      const bootstrap = await rawSecureFetchForScan(fetchEnv, cartBootstrapUrl, row, {
        method: 'GET', providerPool: ['native'], redirect: 'manual', headers: sessionRequestHeaders()
      });
      await persistSessionCookies(bootstrap);
      if (!sessionCookieHeader) return initial;

      console.log(`[VENUE SESSION] Refreshed ${targetRow.venue_id} session after SeatMe redirect; retrying endpoint once.`);
      const retry = await rawSecureFetchForScan(fetchEnv, url, row, {
        ...fetchOptions,
        headers: { ...sessionRequestHeaders(), ...(fetchOptions.headers || {}), Cookie: sessionCookieHeader }
      });
      await persistSessionCookies(retry);
      return retry;
    };
    const inventory = await effectiveStrategy(targetRow, htmlBody, env, ctx, secureFetchForScan, trackWorkerLog, adapter, boundApiFetch);
    const scanDurationMs = Date.now() - scanStartedAtMs;
    const availabilityMetadata = inventory?.scanMetadata || null;
    const availabilityOnly = Boolean(availabilityMetadata?.availabilityOnly);
    let inventoryCandidates = [];
    let inventoryCandidatePolicy = availabilityOnly
      ? 'not_applied_availability_only'
      : 'not_applied_position_policy_not_not_applicable';
    let confirmedDropDetected = false;
    console.log(`[PARSER] Parser for ${targetRow.venue_id} found ${inventory.length} item(s).`);

    if (!isDiscovery) {
      const timestampIsoString = new Date().toISOString();
      const snapshotHash = availabilityOnly
        ? computeStringHash(availabilityMetadata.availabilityFingerprint || JSON.stringify(inventory))
        : computeStringHash(JSON.stringify(inventory));
      const scanId = buildWorkerLogId();
      try {
        const targetQuantities = Array.isArray(options.targetQuantities)
          ? [...new Set(options.targetQuantities.map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 10))]
          : (Number.isInteger(Number(options.targetQuantity)) && Number(options.targetQuantity) > 0 ? [Number(options.targetQuantity)] : []);
        const hallPolicy = targetRow.venue_hall_id
          ? await getHallInventoryPolicy(env.DB, targetRow.venue_hall_id)
          : null;
        const canUseNotApplicableRowPolicy = !availabilityOnly && isNotApplicableRowPolicy(hallPolicy);
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
        // The section-availability endpoint is the authoritative event-level
        // count. Deep parsing can intentionally omit unmapped seats, so it
        // must never change the availability ratio or sold-out state.
        const observedAvailableItemCount = Number.isFinite(Number(availabilityMetadata?.availableItemCount))
          ? Math.max(0, Number(availabilityMetadata.availableItemCount))
          : inventory.length;
        const persistedSnapshot = await persistInventoryCandidates(env.DB, {
          scanId,
          eventId: targetRow.event_id,
          venueId: targetRow.venue_id,
          scanSource: availabilityOnly
            ? 'availability_poll'
            : (options.scanSource || (logPrefix === '[SINGLE EVENT INVENTORY]' ? 'single_event_inventory' : 'scheduled_inventory')),
          scannedAt: timestampIsoString,
          snapshotHash,
          availableItemCount: observedAvailableItemCount,
          inventoryJobId: options.inventoryJobId || null,
          durationMs: scanDurationMs,
          candidates
        });
        let dropObservation = null;
        let candidateObservation = null;
        let availabilityPriority = null;
        {
          const maxPriceCents = normalizeDropPriceCapCents(targetRow.drop_watch_max_price_cents);
          const qualifyingInventory = availabilityOnly ? [] : filterInventoryForDropPriceRule(inventory, maxPriceCents);
          const qualifyingPrices = qualifyingInventory
            .map(item => Number(item.priceCents))
            .filter(Number.isFinite);
          const eligibleCandidateBlocks = candidates.filter(candidate => maxPriceCents == null
            || (Number.isFinite(Number(candidate.priceCents)) && Number(candidate.priceCents) <= maxPriceCents));
          const mappedCapacitySeatCount = Number(targetRow.mapped_capacity_seat_count);
          const availablePercentageBasisPoints = Number.isInteger(mappedCapacitySeatCount) && mappedCapacitySeatCount > 0
            ? Math.min(10_000, Math.round((observedAvailableItemCount * 10_000) / mappedCapacitySeatCount))
            : null;
          availabilityPriority = formatAvailabilityPriority(adapter, { availablePercentageBasisPoints });
          const dropPayload = {
            eventId: targetRow.event_id,
            venueName: targetRow.venue_name,
            venueHall: targetRow.venue_hall,
            timezoneName: targetRow.timezone_name,
            showName: targetRow.show_name,
            showtime: targetRow.showtime,
            eventUrl: targetRow.event_url,
            availableItemCount: qualifyingInventory.length,
            observedAvailableItemCount,
            maxPriceCents,
            lowestQualifyingPriceCents: qualifyingPrices.length ? Math.min(...qualifyingPrices) : null,
            highestQualifyingPriceCents: qualifyingPrices.length ? Math.max(...qualifyingPrices) : null,
            sectionSummaries: summarizeAvailableSeatsBySection(qualifyingInventory),
            eligibleSeatSamples: qualifyingInventory
              .slice()
              .sort((left, right) => Number(left.priceCents) - Number(right.priceCents))
              .slice(0, 4)
              .map(item => ({ section: item.section, row: item.row, seat: item.seat, priceCents: item.priceCents })),
            eligibleCandidateBlocks: eligibleCandidateBlocks.slice(0, 3),
            availabilityPriority,
            observedAt: timestampIsoString
          };
          dropObservation = await recordInventoryAvailabilityObservation(env.DB, {
            eventId: targetRow.event_id,
            scanId,
            alertId: `${scanId}:sold-out-drop`,
            // An availability-only poll is possible only after an available
            // baseline with an identical fingerprint. Preserve that state
            // instead of incorrectly treating its empty detail list as sold out.
            availableItemCount: observedAvailableItemCount,
            alertEligibleItemCount: qualifyingInventory.length,
            capacitySeatCount: targetRow.mapped_capacity_seat_count,
            observedAt: timestampIsoString,
            availabilityFingerprint: availabilityMetadata?.availabilityFingerprint || null,
            deepScanAt: availabilityOnly ? null : timestampIsoString,
            alertPayload: dropPayload
          });
          confirmedDropDetected = dropObservation.dropDetected;
          console.log('[INVENTORY STATE] Availability recorded', {
            eventId: targetRow.event_id,
            showName: targetRow.show_name,
            availabilityState: dropObservation.availabilityState,
            availableItemCount: observedAvailableItemCount,
            observedAvailableItemCount,
            mappedCapacitySeatCount: targetRow.mapped_capacity_seat_count || null,
            availablePercentageBasisPoints: dropObservation.availablePercentageBasisPoints,
            maxPriceCents,
            dropDetected: dropObservation.dropDetected
          });
        }
        if (!availabilityOnly) {
          const candidateDigest = candidates
            .slice()
            .sort((left, right) => Number(left.priceCents) - Number(right.priceCents)
              || Number(left.targetQuantity) - Number(right.targetQuantity)
              || String(left.section).localeCompare(String(right.section))
              || String(left.row).localeCompare(String(right.row))
              || Number(left.startSeat) - Number(right.startSeat))
            .slice(0, 3)
            .map(candidate => ({
              targetQuantity: candidate.targetQuantity,
              section: candidate.section,
              row: candidate.row,
              startSeat: candidate.startSeat,
              endSeat: candidate.endSeat,
              priceCents: candidate.priceCents,
              priceLevel: candidate.priceLevel,
              seatQuality: candidate.seatQuality
            }));
          candidateObservation = await recordInventoryCandidateObservation(env.DB, {
            eventId: targetRow.event_id,
            scanId,
            alertId: `${scanId}:candidate`,
            candidateFingerprint: candidateDigest.length ? computeStringHash(JSON.stringify(candidateDigest)) : '',
            observedAt: timestampIsoString,
            alertPayload: {
              venueName: targetRow.venue_name,
              venueHall: targetRow.venue_hall,
              timezoneName: targetRow.timezone_name,
              showName: targetRow.show_name,
              showtime: targetRow.showtime,
              eventUrl: targetRow.event_url,
              candidates: candidateDigest,
              checkoutFeeRule: adapter.checkoutFeeRule,
              availabilityPriority,
              observedAt: timestampIsoString
            }
          });
          if (candidateObservation.candidateDetected) await deliverPendingCandidateAlerts(env, 1);
        }
        const logSummary = buildInventorySnapshotLogSummary(inventory);
        console.log('[D1 INVENTORY] Snapshot saved', {
          scanId,
          eventId: targetRow.event_id,
          venueId: targetRow.venue_id,
          scanSource: availabilityOnly
            ? 'availability_poll'
            : (options.scanSource || (logPrefix === '[SINGLE EVENT INVENTORY]' ? 'single_event_inventory' : 'scheduled_inventory')),
          scannedAt: timestampIsoString,
          snapshotHash,
          durationMs: scanDurationMs,
          availableSeatRowsObserved: inventory.length,
          availabilityOnly,
          availabilityFingerprintHash: availabilityMetadata?.availabilityFingerprint
            ? computeStringHash(availabilityMetadata.availabilityFingerprint)
            : null,
          availabilitySeatCount: observedAvailableItemCount,
          targetQuantities,
          requiredBufferBlockCount: adapter.inventoryBufferBlockCount,
          savedCandidateBlocks: persistedSnapshot.candidateCount,
          candidatePolicy: inventoryCandidatePolicy,
          sections: logSummary.sections,
          sampleObservedSeats: logSummary.sampleSavedSeats,
          sampleSavedCandidates: candidates.slice(0, 3),
          dropDetected: dropObservation?.dropDetected || false,
          candidateAlertDetected: candidateObservation?.candidateDetected || false
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
      if (!availabilityOnly) await updateEventScanResult(env.DB, targetRow.event_id, snapshotHash, timestampIsoString);
      console.log(`${logPrefix} Inventory scan succeeded: ${targetRow.show_name} (${targetRow.showtime}), ${inventory.length} item(s) parsed in ${scanDurationMs}ms${availabilityOnly ? ' (availability-only poll)' : ''}.`);
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
    if (isVenueValidationChallenge(err)) {
      const consecutiveBlocks = (backoffState?.consecutiveBlocks || 0) + 1;
      const delayMs = computeBackoffDelayMs(consecutiveBlocks, adapter);
      const backoffUntil = new Date(now.getTime() + delayMs).toISOString();
      await setVenueBackoffState(env.DB, targetRow.venue_id, {
        consecutiveBlocks,
        backoffUntil,
        lastStatus: 421,
        reason: 'venue_validation_challenge',
        endpointUrl: err.endpointUrl || null,
        detectedAt: new Date().toISOString()
      });
      const message = `[VENUE VALIDATION] ${targetRow.venue_name || targetRow.venue_id} returned a human-validation page. Inventory is paused until ${backoffUntil}.\nShow: ${targetRow.show_name}\nEvent: ${targetRow.event_id}\nEndpoint: ${err.endpointUrl || 'unknown'}`;
      console.warn(`${logPrefix} ${message}`);
      await trackWorkerLog(env, ctx, 'warn', 'Venue validation challenge; inventory checkpoint preserved', {
        venueId: targetRow.venue_id,
        eventId: targetRow.event_id,
        endpointUrl: err.endpointUrl || null,
        backoffUntil,
        consecutiveBlocks
      });
      // Exactly one alert is sent when the challenge is first detected. The
      // persisted backoff prevents later events/invocations from sending it.
      sendTelegramNotification(env, ctx, message, 'critical');
      return { status: 'deferred', reason: 'venue_validation_challenge', durationMs: Date.now() - scanStartedAtMs };
    }
    if (isSubrequestBudgetExhaustion(err)) {
      // This is an intentional, bounded yield rather than a failed SeatMe
      // request. The all-events runner puts the event back at the front of
      // its leased queue and retries it with a fresh invocation budget.
      console.log(`${logPrefix} Request budget reached while scanning ${targetRow.event_id}; deferring this event to the next invocation.`);
      return { status: 'deferred', reason: 'subrequest_budget_exhausted' };
    }
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
  // Attempt as many events as are cheap enough to fit inside the shared
  // request/time budget. `inventoryMaxEventsPerRun` is only a guardrail for
  // pathological all-skip runs; it is deliberately not a fixed batch size.
  const batchLimit = Math.min(adapter.inventoryMaxEventsPerRun, remainingEventIds.length);
  // Cloudflare permits 50 subrequests per invocation. Keep one request in
  // reserve and share the budget across every event in this batch.
  const requestBudget = { limit: adapter.inventoryExternalRequestBudget, remaining: adapter.inventoryExternalRequestBudget };
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const productionTimings = new Map();

  while (attempted < batchLimit && remainingEventIds.length && Date.now() < deadlineMs) {
    if (requestBudget.remaining < 1) {
      console.log(`[ALL EVENTS INVENTORY] External request budget reached; checkpointing ${remainingEventIds.length} unstarted event(s).`);
      break;
    }
    if (!isMonitoringWindowActive(new Date(), adapter.timezoneName, adapter.businessHours)) {
      const context = {
        scheduleMode: 'inventory_scan', venueId: adapter.venueId,
        timezone: adapter.timezoneName,
        localTime: formatVenueLocalTime(new Date(), adapter.timezoneName),
        businessHours: adapter.businessHours,
        reason: 'outside_monitoring_window',
        jobId: job.id, remainingEventCount: remainingEventIds.length
      };
      console.log('[SCHEDULER] Curfew active; inventory job checkpoint left untouched.', context);
      await trackWorkerLog(env, ctx, 'info', 'Curfew active; no inventory event started', context);
      break;
    }
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
      targetQuantities: adapter.inventoryTargetQuantities, requestBudget
    });
    if (result.status === 'deferred' && ['subrequest_budget_exhausted', 'venue_validation_challenge'].includes(result.reason)) {
      // The scan may have spent part of the budget before discovering that it
      // cannot finish safely. Put this event back at the front so it gets a
      // complete fresh attempt next invocation; never burn through the rest
      // of the queue as artificial failures.
      remainingEventIds.unshift(eventId);
      attempted -= 1;
      const reason = result.reason === 'venue_validation_challenge' ? 'Venue validation challenge' : 'Budget reached';
      console.log(`[ALL EVENTS INVENTORY] ${reason} while scanning ${eventId}; event requeued for the next invocation.`);
      break;
    }
    if (result.status === 'skipped' && result.reason === 'venue_backoff') {
      // Preserve the queue during the cooldown. Treating every queued event
      // as a skip would incorrectly complete the job without scanning it.
      remainingEventIds.unshift(eventId);
      attempted -= 1;
      console.log(`[ALL EVENTS INVENTORY] Venue backoff is active; job checkpoint preserved for ${eventId}.`);
      break;
    }
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
    const jobElapsedMs = batchCompletedAt.getTime() - new Date(job.started_at).getTime();
    console.log('[INVENTORY JOB TIMER] Complete', {
      venueId: adapter.venueId,
      jobId: job.id,
      batchCount: batchNumber,
      elapsedMs: jobElapsedMs,
      elapsed: formatJobDuration(jobElapsedMs)
    });
    console.log(`[ALL EVENTS INVENTORY] Job complete: ${job.total_event_count} events in ${batchNumber} batch(es), ${batchCompletedAt.getTime() - new Date(job.started_at).getTime()}ms total.`, {
      completed: completedEventCount, failed: failedEventCount, skipped: skippedEventCount,
      productions: Object.fromEntries(productionTimings)
    });
  } else {
    await checkpointInventoryJob(env.DB, checkpoint);
    const jobElapsedMs = batchCompletedAt.getTime() - new Date(job.started_at).getTime();
    console.log('[INVENTORY JOB TIMER] Progress', {
      venueId: adapter.venueId,
      jobId: job.id,
      batchNumber,
      elapsedMs: jobElapsedMs,
      elapsed: formatJobDuration(jobElapsedMs),
      completedEventCount,
      totalEventCount: job.total_event_count,
      remainingEventCount: remainingEventIds.length
    });
    console.log('[ALL EVENTS INVENTORY] Batch checkpointed', {
      jobId: job.id, batchNumber, attempted, completed, failed, skipped,
      remaining: remainingEventIds.length, durationMs: batchCompletedAt.getTime() - batchStartedAt.getTime(),
      externalRequestsUsed: requestBudget.limit - requestBudget.remaining,
      externalRequestsRemaining: requestBudget.remaining,
      inventoryMaxEventsPerRun: adapter.inventoryMaxEventsPerRun,
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
    adapter.dropWatchIntervalsMinutes, adapter.availabilityPriorityPolicy);
  if (!targets.length) return { attempted: 0, completed: 0, failed: 0 };

  console.log(`[DROP WATCH] ${adapter.venueName}: scanning ${targets.length} due performance(s).`, {
    priorities: targets.reduce((counts, target) => {
      const priority = target.drop_watch_priority || 'medium';
      counts[priority] = (counts[priority] || 0) + 1;
      return counts;
    }, {})
  });
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
    if ((result.status === 'deferred' && result.reason === 'venue_validation_challenge')
      || (result.status === 'skipped' && result.reason === 'venue_backoff')) {
      console.log('[DROP WATCH] Venue recovery cooldown active; remaining drop targets will resume later.');
      break;
    }
    if (result.status === 'completed') completed += 1;
    else failed += 1;
    if (result.dropDetected) await deliverPendingDropAlerts(env, 5);
  }
  console.log('[DROP WATCH] Priority pass complete', { attempted: targets.length, completed, failed });
  return { attempted: targets.length, completed, failed };
}

export async function runScheduledCycle(env, ctx, options = {}) {
  const now = options.now || new Date();
  const scheduleMode = options.forcedMode || getScheduleModeForCronDate(now);

  try {
    console.log('====================================================');
    console.log(`[MARKET ENGINE] USA Multi-Venue Priority Engine Cycle Woken Up [${scheduleMode}]`);
    console.log('====================================================');

    const activeAdapters = await getWorkerScopedAdapters(env);
    // Scheduled work is prohibited outside each venue's local monitoring
    // window. Log the intentional no-op before any job, cleanup, lease, or
    // external request is started.
    const runnableAdapters = [];
    for (const adapter of activeAdapters) {
      if (scheduleMode !== 'idle' && !isMonitoringWindowActive(now, adapter.timezoneName, adapter.businessHours)) {
        const context = {
          scheduleMode, venueId: adapter.venueId, timezone: adapter.timezoneName,
          localTime: formatVenueLocalTime(now, adapter.timezoneName),
          businessHours: adapter.businessHours, reason: 'outside_monitoring_window'
        };
        console.log('[SCHEDULER] Curfew active; no work started.', context);
        await trackWorkerLog(env, ctx, 'info', 'Curfew active; scheduled work not started', context);
        continue;
      }
      runnableAdapters.push(adapter);
    }
    if (scheduleMode !== 'idle' && !runnableAdapters.length) return;
    const activeVenueIds = runnableAdapters.map(adapter => adapter.venueId);

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
        // Cron cadence already spaces Worker work. Do not burn the bounded
        // invocation lifetime on a randomized sleep.
        skipJitter: true,
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
      for (const adapter of runnableAdapters) {
        await auditCriticalDropWatchHealth(adapter, env, ctx, now);
        await deliverPendingDropAlerts(env, 20);
        await deliverPendingCandidateAlerts(env, 10);
        await runDropWatchForVenue(adapter, env, ctx, now);
      }
      return;
    }

    // Handle Discovery Scans
    if (scheduleMode === 'discovery_scan') {
      await trackWorkerLog(env, ctx, 'info', 'Discovery scan pass started', { scheduleMode });
      console.log('[DISCOVERY SCAN] Initiating discovery for all active venues.');

      for (const adapter of runnableAdapters) {
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
            // Discovery is checkpointed; start its bounded batch immediately.
            skipJitter: true,
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
    for (const adapter of runnableAdapters) await runInventoryJobForVenue(adapter, env, ctx, now);
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
      const adapters = await getWorkerScopedAdapters(env);
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

    if (request.method === 'POST' && url.pathname === '/discovery/single-production') {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON format' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const productionId = String(payload?.production_id || '').trim();
      const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
      if (!/^\d{1,20}$/.test(productionId)) {
        return new Response(JSON.stringify({ error: 'production_id must be a numeric Tessitura production ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const [adapter] = await getWorkerScopedAdapters(env);
      if (!adapter) {
        return new Response(JSON.stringify({ error: 'No valid Worker venue binding is configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      if (adapter.discoveryStrategy !== 'segerstromProductionDiscovery') {
        return new Response(JSON.stringify({ error: 'Single-production discovery is not implemented for this venue adapter' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
      }
      if (!isMonitoringWindowActive(new Date(), adapter.timezoneName, adapter.businessHours)) {
        return new Response(JSON.stringify({ error: 'Outside the venue monitoring window' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }

      const targetRow = {
        venue_id: adapter.venueId,
        venue_name: adapter.venueName,
        timezone_name: adapter.timezoneName,
        security_tier: adapter.securityTier,
        event_url: adapter.urlPattern,
        show_name: title || `Production ${productionId}`,
        event_id: `single-discovery:${productionId}`,
      };
      console.log(`[SINGLE PRODUCTION DISCOVERY] Running ${targetRow.show_name} (production ${productionId}).`);
      const result = await segerstromSingleProductionDiscovery(
        targetRow,
        { id: productionId, title: title || targetRow.show_name },
        env,
        ctx,
        executeSecureFetch,
        trackWorkerLog,
        adapter,
        (apiUrl, options) => executeApiFetch(apiUrl, {
          ...options,
          debugLog: (message, level) => debugLogAndNotify(env, ctx, message, level)
        })
      );
      return new Response(JSON.stringify({
        mode: 'single_production_discovery',
        venue_id: adapter.venueId,
        ...result,
      }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Proves whether SeatMe issues enough state during an ordinary first GET
    // for a same-invocation retry to return inventory. This is intentionally
    // not a scheduler path and does not persist or disclose cookie values.
    if (request.method === 'POST' && url.pathname === '/operations/session-smoke-test') {
      if (!isRequestAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      let payload;
      try { payload = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON format' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const eventId = String(payload?.event_id || '').trim();
      const bootstrapMode = String(payload?.bootstrap || 'availability').trim().toLowerCase();
      if (!/^\d{1,20}$/.test(eventId)) {
        return new Response(JSON.stringify({ error: 'event_id must be a numeric Tessitura performance ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!['availability', 'settings', 'cart'].includes(bootstrapMode)) {
        return new Response(JSON.stringify({ error: 'bootstrap must be availability, settings, or cart' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const [adapter] = await getWorkerScopedAdapters(env);
      if (!adapter?.inventoryApiUrlPattern?.includes('{performanceId}')) {
        return new Response(JSON.stringify({ error: 'This session smoke test is not implemented for the configured venue adapter' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
      }
      const endpointUrl = adapter.inventoryApiUrlPattern.replace('{performanceId}', encodeURIComponent(eventId));
      const settingsUrl = adapter.settingsApiUrlPattern?.replace('{performanceId}', encodeURIComponent(eventId));
      const cartBootstrapUrl = `https://www.scfta.org/cart/updatecart?returnurl=${encodeURIComponent(endpointUrl)}`;
      // Mirror the safe, non-secret parts of the user's successful Postman
      // request. Host and Connection remain runtime-managed by Workers.
      const ordinaryHeaders = {
        'User-Agent': 'PostmanRuntime/7.43.0',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Postman-Token': crypto.randomUUID()
      };
      try {
        const requestAvailability = requestHeaders => executeSecureFetch(env, endpointUrl, {
          venue_id: adapter.venueId,
          event_id: eventId
        }, {
          method: 'GET',
          providerPool: ['native'],
          headers: { ...ordinaryHeaders, ...requestHeaders }
        });
        const bootstrapUrl = bootstrapMode === 'settings' ? settingsUrl
          : (bootstrapMode === 'cart' ? cartBootstrapUrl : null);
        const sessionResult = bootstrapUrl
          ? await runEphemeralBootstrapThenTarget({
            bootstrapRequest: () => executeSecureFetch(env, bootstrapUrl, {
              venue_id: adapter.venueId,
              event_id: eventId
            }, {
              method: 'GET',
              providerPool: ['native'],
              headers: ordinaryHeaders,
              redirect: bootstrapMode === 'cart' ? 'manual' : 'follow'
            }),
            targetRequest: requestAvailability
          })
          : await runEphemeralSessionBootstrap({
          request: requestHeaders => executeSecureFetch(env, endpointUrl, {
            venue_id: adapter.venueId,
            event_id: eventId
          }, {
            method: 'GET',
            providerPool: ['native'],
            headers: { ...ordinaryHeaders, ...requestHeaders }
          })
          });
        return new Response(JSON.stringify({
          mode: 'ephemeral_session_smoke_test', bootstrap: bootstrapMode, event_id: eventId, endpoint: endpointUrl,
          ...sessionResult
        }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({
          mode: 'ephemeral_session_smoke_test', event_id: eventId,
          resultKind: isVenueValidationChallenge(error) ? 'venue_validation_challenge' : 'request_failed',
          error: error.message
        }, null, 2), { status: isVenueValidationChallenge(error) ? 409 : 502, headers: { 'Content-Type': 'application/json' } });
      }
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
      const activeVenueIds = (await getWorkerScopedAdapters(env)).map(adapter => adapter.venueId);
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
      const adapters = await getWorkerScopedAdapters(env);
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
      const activeVenueIds = (await getWorkerScopedAdapters(env)).map(adapter => adapter.venueId);
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
    const productionCronModes = {
      '*/5 * * * *': 'drop_watch',
      '7,17,27,37,47,57 * * * *': 'inventory_scan',
      '12,32,52 * * * *': 'listing_watch',
      '3 * * * *': 'discovery_scan'
    };
    const forcedMode =
      productionCronModes[event?.cron] ||
      (event?.cron === 'test-drop-watch' ? 'drop_watch' :
      (event?.cron === 'test-inventory-scan' || event?.cron === 'test-primary-scan') ? 'inventory_scan' :
      event?.cron === 'test-listing-watch' ? 'listing_watch' :
      event?.cron === 'test-discovery-scan' ? 'discovery_scan' :
      undefined);
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
