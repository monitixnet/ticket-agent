import { VENUE_PARSERS } from './venue-rules.js';
import { upsertDiscoveredEvents, getDiscoveryJobState, setDiscoveryJobState, clearDiscoveryJobState, getDiscoveryProductionSchedule, setDiscoveryProductionSchedule, markDiscoveredSoldOutEvents, recordDiscoveryBatchMetric, claimDiscoveryJobLease, releaseDiscoveryJobLease } from './database/queries.js';
import { delayExecution, normalizeExternalId, randomBetween } from './utils.js';
import { isMonitoringWindowActive } from './venue-logic.js';

const DISCOVERY_OUTCOMES = ['on_sale', 'sold_out', 'future_sale', 'past', 'not_on_sale', 'free_no_tickets', 'settings_unavailable', 'unknown', 'error'];
const UNKNOWN_OUTCOME_SAMPLE_LIMIT = 10;
const DISCOVERY_EXTERNAL_REQUEST_BUDGET = 45;
const DISCOVERY_RECHECK_MS = {
  on_sale: 6 * 60 * 60 * 1000,
  sold_out: 60 * 60 * 1000,
  settings_unavailable: 60 * 60 * 1000,
  unknown: 60 * 60 * 1000,
  error: 30 * 60 * 1000,
};

function emptyDiscoveryOutcomeCounts() {
  return Object.fromEntries(DISCOVERY_OUTCOMES.map(outcome => [outcome, 0]));
}

export function isProductionDueForDiscovery(production, schedule, nowMs) {
  const record = schedule?.[production.id];
  if (!record) return true;
  if (record.nextCheckAt === null) return false; // recorded permanent exclusion
  const nextCheckMs = Date.parse(record.nextCheckAt || '');
  return !Number.isFinite(nextCheckMs) || nextCheckMs <= nowMs;
}

function scheduleProductionRecheck(schedule, production, outcome, checkedAtMs, buyButton = {}) {
  let nextCheckAt = null;
  if (outcome === 'future_sale') {
    const saleStartMs = Date.parse(buyButton?.MOSStartDate || '');
    nextCheckAt = Number.isFinite(saleStartMs) && saleStartMs > checkedAtMs
      ? new Date(saleStartMs).toISOString()
      : new Date(checkedAtMs + (24 * 60 * 60 * 1000)).toISOString();
  } else if (Object.hasOwn(DISCOVERY_RECHECK_MS, outcome)) {
    nextCheckAt = new Date(checkedAtMs + DISCOVERY_RECHECK_MS[outcome]).toISOString();
  }
  const subItemStatusCounts = (Array.isArray(buyButton?.SubItems) ? buyButton.SubItems : [])
    .reduce((counts, item) => {
      const status = String(item?.Status || 'missing');
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
  schedule[production.id] = {
    title: production.title,
    outcome,
    lastCheckedAt: new Date(checkedAtMs).toISOString(),
    nextCheckAt,
    overallStatus: buyButton?.Status || null,
    saleStartAt: buyButton?.MOSStartDate || null,
    subItemStatusCounts,
  };
}

export function classifyDiscoveryOutcome(button, onSalePerformanceIds, now = new Date()) {
  if (onSalePerformanceIds.size > 0) return 'on_sale';
  const maxDate = Date.parse(button?.MaxDate || button?.MOSEndDate || '');
  if (Number.isFinite(maxDate) && maxDate < now.getTime()) return 'past';
  const status = String(button?.Status || '').toLowerCase();
  const subItems = Array.isArray(button?.SubItems) ? button.SubItems : [];
  // A production can contain both expired PastSale performances and upcoming
  // SoldOut performances.  Only the latter describes its current drop state.
  // Keep untimestamped items: without a date we must not discard a status.
  const currentSubItems = subItems.filter(item => {
    const ticks = Number(item?.Ticks);
    return !Number.isFinite(ticks) || ticks >= now.getTime();
  });
  if (status === 'pastsale') return 'past';
  if (status === 'soldout' || (currentSubItems.length && currentSubItems.every(item => String(item.Status).toLowerCase() === 'soldout'))) return 'sold_out';
  if (status === 'freenotixs') return 'free_no_tickets';
  const saleStart = Date.parse(button?.MOSStartDate || '');
  if (Number.isFinite(saleStart) && saleStart > now.getTime()) return 'future_sale';
  if (status === 'notonsale' || status === 'offsale') return 'not_on_sale';
  return 'unknown';
}

export function getCurrentSoldOutPerformances(button, now = new Date()) {
  return (Array.isArray(button?.SubItems) ? button.SubItems : [])
    .filter(item => String(item?.Status || '').toLowerCase() === 'soldout')
    .filter(item => {
      const ticks = Number(item?.Ticks);
      return Number.isFinite(ticks) && ticks >= now.getTime();
    });
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

const EXPLICIT_HALL_FIELD_NAMES = new Set([
  'hall', 'hallname', 'venuehall', 'venue_hall', 'facility', 'facilityname', 'facility_name', 'facilitysettings',
  'locationname', 'location_name', 'performancelocation', 'performancevenue'
]);

function extractHallFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const directHall = firstNonEmptyString([
    record.venueHall, record.hallName, record.hall, record.facilityName, record.locationName
  ]);
  if (directHall) return directHall;

  for (const [key, nestedValue] of Object.entries(record)) {
    if (!EXPLICIT_HALL_FIELD_NAMES.has(String(key).toLowerCase())) continue;
    if (typeof nestedValue === 'string' && nestedValue.trim()) return nestedValue.trim();
    if (nestedValue && typeof nestedValue === 'object') {
      const nestedHall = firstNonEmptyString([nestedValue.hallName, nestedValue.facilityName, nestedValue.locationName, nestedValue.name, nestedValue.description]);
      if (nestedHall) return nestedHall;
    }
  }
  return null;
}

// Tessitura/SeatMe payloads vary by venue and version. Prefer the performance
// record because one production can play multiple halls; use facility settings
// only as a fallback and leave the value null when the API does not identify it.
export function resolveVenueHall(performance, settingsData) {
  return extractHallFromRecord(performance)
    || extractHallFromRecord(settingsData)
    || extractHallFromRecord(settingsData?.facilitySettings)
    || null;
}

// SCFTA's public calendar template renders the hall with hit.Venue[0]. Keep
// this source-specific rule separate from the more conservative SeatMe parser:
// a generic `venue` field elsewhere must not be mistaken for a hall.
export function resolveCalendarVenueHall(calendarHit) {
  const venues = Array.isArray(calendarHit?.Venue) ? calendarHit.Venue : [calendarHit?.Venue];
  return firstNonEmptyString(venues);
}

function isDiscoveryHallAllowed(adapter, hallName) {
  const configured = Array.isArray(adapter?.discoveryAllowedHalls)
    ? adapter.discoveryAllowedHalls
    : ['Segerstrom Hall'];
  const allowed = new Set(configured.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
  return allowed.has(String(hallName || '').trim().toLowerCase());
}

function getObjectFieldNames(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().slice(0, 40)
    : [];
}

function logDiscoveryEndpointShape(env, endpoint, payload, context = {}) {
  if (env?.DISCOVERY_ENDPOINT_DIAGNOSTICS !== 'true') return;
  const records = Array.isArray(payload) ? payload : [payload];
  const samples = records.slice(0, 3).map(record => {
    const fieldNames = getObjectFieldNames(record);
    const hallCandidates = Object.fromEntries(Object.entries(record || {})
      .filter(([key, value]) => /hall|venue|facility|location/i.test(key) && (typeof value === 'string' || typeof value === 'number'))
      .slice(0, 12));
    return { fieldNames, hallCandidates };
  });
  // Diagnostics are opt-in and deliberately bounded: enough data to map the
  // real field names and values without logging a full 100-record page.
  console.log(`[DISCOVERY DIAGNOSTIC] ${endpoint} response sample`, {
    ...context,
    recordCount: records.length,
    samples,
    rawRecordSamples: records.slice(0, 3)
  });
}

function buildUnknownOutcomeSample(productionId, title, button, responseStatus) {
  const subItemStatusCounts = (Array.isArray(button?.SubItems) ? button.SubItems : [])
    .reduce((counts, item) => {
      const status = String(item?.Status || 'missing');
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
  return {
    productionId,
    title,
    overallStatus: button?.Status || null,
    responseStatus: responseStatus ?? null,
    subItemStatusCounts
  };
}

function buildDiscoverySummaryMessage(adapterName, jobState, insertedCount, discoveredCount, runtimeMs) {
  const processed = jobState.processedProductions ?? jobState.processedIds?.length ?? 0;
  const remaining = jobState.remainingProductions ?? jobState.productionQueue?.length ?? 0;
  const total = jobState.totalProductions ?? Math.max(processed + remaining, 0);
  const complete = Boolean(jobState.complete);

  return [
    `Discovery summary - ${adapterName}`,
    `status: ${complete ? 'COMPLETE' : 'IN_PROGRESS'}`,
    `processed: ${processed}`,
    `remaining: ${remaining}`,
    `total: ${total}`,
    `new events: ${insertedCount}`,
    `discovered this batch: ${discoveredCount}`,
    `runtime_ms: ${runtimeMs ?? 0}`,
    `last_updated: ${jobState.lastUpdatedAt || new Date().toISOString()}`,
  ].join('\n');
}

function sendDiscoveryStatusToTelegram(env, ctx, adapterName, jobState, insertedCount, discoveredCount, runtimeMs) {
  const url = env.NOTIFICATION_OUTBOUND_URL;
  if (!url) return;
  const message = buildDiscoverySummaryMessage(adapterName, jobState, insertedCount, discoveredCount, runtimeMs);
  const promise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `\`\`\`\n${message}\n\`\`\`` })
  }).catch(err => console.error(`[TELEGRAM DISCOVERY SUMMARY FAILED] ${err.message}`));
  ctx?.waitUntil?.(promise);
}

function shouldSendDiscoveryStatusNotification(env, complete = false) {
  const flag = (env.DISCOVERY_SUMMARY_NOTIFICATIONS || '').toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return complete || env.ENABLE_DEBUG_NOTIFICATIONS === 'true';
}

export async function singleStepParseStrategy(targetRow, htmlBody, env, ctx, executeSecureFetch, _trackWorkerLog) {
  const parser = VENUE_PARSERS[targetRow.venue_id];
  // TODO: For venues using this strategy, investigate network traffic to find a dedicated inventory API endpoint.
  if (parser) {
    return parser(htmlBody, targetRow.venue_id);
  }
  return [];
}

/**
 * A multi-step inventory-checking strategy for Segerstrom Center.
 * This function is designed for an "Inventory Job" that targets a specific event.
 * It performs a three-step API "drill-down" to get full seat and price information.
 */
export async function segerstromDrillDownStrategy(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, _executeApiFetch) {
  const performanceId = new URL(targetRow.event_url).searchParams.get(adapter.performanceIdParam || 'id');

  if (!performanceId) {
    trackWorkerLog(env, ctx, 'error', `[PARSER - Segerstrom] Could not extract performanceId from event_url: ${targetRow.event_url}`);
    return [];
  }

  try {
    // Step 1: Get performance settings, which includes the mapping of sectionGroupId to section names.
    const settingsUrl = adapter.settingsApiUrlPattern?.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching performance settings from: ${settingsUrl}`); // Keep logging for visibility
    const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET', apiRequest: true });
    const settingsData = JSON.parse(settingsPayload.text || '{}');
    const sectionNameMap = (settingsData?.facilitySettings?.sectionGroupings || []).reduce((map, group) => {
      map[group.sectionGroupId] = group.description;
      return map;
    }, {});

    // Step 2: Get pricing information for all zones.
    const priceApiUrl = adapter.priceApiUrlPattern?.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching zone pricing from: ${priceApiUrl}`); // Keep logging for visibility
    const pricePayload = await executeSecureFetch(env, priceApiUrl, targetRow, { method: 'GET', apiRequest: true });
    const priceData = JSON.parse(pricePayload.text || '[]');
    const zonePriceMap = priceData.reduce((map, zone) => {
      if (zone.prices?.[0]) {
        map[zone.zoneId] = zone.prices[0].price;
      }
      return map;
    }, {});

    // Step 3: Get section availability.
    const sectionAvailabilityUrl = adapter.inventoryApiUrlPattern?.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching section availability from: ${sectionAvailabilityUrl}`); // Keep logging for visibility
    const sectionPayload = await executeSecureFetch(env, sectionAvailabilityUrl, targetRow, { method: 'GET', apiRequest: true });
    const sectionGroups = JSON.parse(sectionPayload.text || '[]');

    const allSeatData = [];

    if (adapter.seatInfoApiUrlPattern) {
      // Step 4: For each section group, get the detailed seat info in parallel.
      const seatInfoPromises = sectionGroups.map(group => {
        if (group.sectionGroupId) {
          const seatInfoUrl = adapter.seatInfoApiUrlPattern?.replace('{performanceId}', performanceId)?.replace('{groupId}', group.sectionGroupId);
          console.log(`[PARSER] Fetching detailed seat info from: ${seatInfoUrl}`); // Keep logging for visibility
          return executeSecureFetch(env, seatInfoUrl, targetRow, { method: 'GET', apiRequest: true }).then(payload => ({ ...JSON.parse(payload.text || '{}'), sectionGroupName: sectionNameMap[group.sectionGroupId] || group.sectionGroupName }));
        }
        return Promise.resolve(null); // Return a resolved promise for groups without ID
      });
      allSeatData.push(...(await Promise.all(seatInfoPromises)).filter(Boolean));
    }

    // Step 5: Pass the combined seat and price data to the final parser
    const finalPayload = { seats: allSeatData, prices: zonePriceMap };
    const parser = VENUE_PARSERS[targetRow.venue_id];
    return parser(JSON.stringify(finalPayload), targetRow.venue_id)
      .map(item => ({ ...item, eventId: String(targetRow.event_id || performanceId) }));
  } catch (err) {
    console.error(`[PARSER - ${adapter.venueName}] Failed during API fetch for performanceId ${performanceId}: ${err.message}`);
    throw err;
  }
}

/**
 * A multi-level discovery strategy for Segerstrom Center.
 * This function is designed for a "Discovery Job". It scans the main calendar page,
 * finds all purchasable shows, and then uses the settings API to discover all
 * individual performances for each show.
 */
export async function calendarPageDiscoveryStrategy(targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter) {
  console.log(`[PARSER] Calendar page discovery strategy initiated for venue ${targetRow.venue_id}.`);
  console.log(`[PARSER] Discovering all purchasable shows on calendar page for ${adapter.venueName}.`);
  console.log(htmlBody);
  // 1. Find all high-level show "card" blocks on the page.
  // This regex correctly captures the entire card-wrap element.
  const showCardRegex = /<div class="card-wrap cell[^"]*">([\s\S]*?<\/div>\s*<\/div>)/gi;
  const showCards = [...htmlBody.matchAll(showCardRegex)];

  if (showCards.length === 0) {
    trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] No show cards found on calendar page.`, {
      venueId: targetRow.venue_id,
      htmlBodySnippet: htmlBody.slice(0, 2000) // Increased snippet size for better debugging
    });
    return [];
  }
  
  const allDiscoveredEvents = [];
  const processedProductionIds = new Set();

  // 2. For each card, check for a "Buy Now" button and extract the ticketing URL.
  for (const card of showCards) {
    const cardHtml = card[1]; // The content inside the card-wrap div
    const isSoldOut = /<span class="sold-out(?! hide)">/i.test(cardHtml);
    const buyLinkMatch = cardHtml.match(/<a\s+[^>]*class="[^"]*buy-tickets[^"]*"[^>]*href=(["'])([^"']+)\1/i);

    if (buyLinkMatch && !isSoldOut) {
      const ticketingUrl = new URL(buyLinkMatch[2], targetRow.event_url).toString();
      const performanceId = new URL(ticketingUrl).searchParams.get('id');
      
      if (performanceId && !processedProductionIds.has(performanceId)) {
        processedProductionIds.add(performanceId);
        
        const settingsUrl = adapter.settingsApiUrlPattern?.replace('{performanceId}', performanceId);
        console.log(`[PARSER] Found performanceId ${performanceId}. Fetching all showtimes from: ${settingsUrl}`);
        const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET', apiRequest: true });
        const settingsData = JSON.parse(settingsPayload.text || '{}');
        
        if (settingsData.additionalPerformances) {
          for (const p of settingsData.additionalPerformances) {
            allDiscoveredEvents.push({
              showName: p.description,
              showtime: p.performanceDate?.replace('T', ' '),
              eventId: p.performanceId,
              venueId: targetRow.venue_id,
              venueHall: resolveVenueHall(p, settingsData),
              eventDetailUrl: adapter.ticketingUrlTemplate?.replace('{performanceId}', p.performanceId)
            });
          }
        }
      }
    }
  }

  console.log(`[PARSER] Discovery complete. Found ${allDiscoveredEvents.length} total events.`);
  await upsertDiscoveredEvents(env.DB, allDiscoveredEvents);
  return [];
}

/**
 * A targeted, API-based discovery strategy for Segerstrom that uses a Production Season ID.
 * This is the most robust method, bypassing HTML scraping and dead APIs entirely.
 */
async function segerstromProductionDiscoveryStrategyImpl(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch, options = {}) {
  console.log(`[PARSER] Segerstrom API-driven discovery strategy initiated for venue ${targetRow.venue_id}.`);

  const JOB_KEY = `segerstrom_discovery_job`;
  const singleProduction = options.singleProduction || null;
  const requestBudget = { remaining: DISCOVERY_EXTERNAL_REQUEST_BUDGET };
  let initialQueueSize = 0;
  let jobState = singleProduction ? null : await getDiscoveryJobState(env.DB, JOB_KEY);
  const productionSchedule = singleProduction ? {} : await getDiscoveryProductionSchedule(env.DB, targetRow.venue_id);

  // Start only when there is no saved job. An existing job with an empty queue
  // must reach the completion branch below so it can log completion and clear
  // its checkpoint instead of silently restarting discovery.
  if (singleProduction) {
    const productionId = normalizeExternalId(singleProduction.id);
    if (!productionId) throw new Error('single production requires a valid production ID.');
    jobState = {
      productionQueue: [{ id: productionId, title: String(singleProduction.title || `Production ${productionId}`), calendarVenueHall: singleProduction.venueHall || null }],
      processedIds: [], totalEventsDiscovered: 0, totalProductions: 1,
      processedProductions: 0, remainingProductions: 1, complete: false,
      lastUpdatedAt: new Date().toISOString(), productionOutcomeCounts: emptyDiscoveryOutcomeCounts(),
      unknownOutcomeSamples: [], runCount: 0,
    };
    initialQueueSize = 1;
    console.log(`[SINGLE PRODUCTION DISCOVERY] Running production ${productionId} without reading or advancing ${JOB_KEY}.`);
  } else if (!jobState) {
    console.log(`[PARSER] No active discovery job found. Starting a new one.`);
    const { algoliaAppId, algoliaApiKey, algoliaIndexName } = adapter;
    const algoliaUrl = `https://${algoliaAppId}-dsn.algolia.net/1/indexes/${algoliaIndexName}/query`;
    const headers = { 'Content-Type': 'application/json', 'X-Algolia-Application-Id': algoliaAppId, 'X-Algolia-API-Key': algoliaApiKey };
    const maxPages = Math.max(1, Math.min(Number(env.DISCOVERY_MAX_PAGES) || 100, 100));
    const catalogProductions = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages && page < maxPages) {
      const algoliaPayload = { params: `hitsPerPage=100&page=${page}&filters=ExcludeFromCalendar:false AND ItemType:Production` };
      const algoliaResponse = await executeApiFetch(algoliaUrl, {
        method: 'POST',
        body: JSON.stringify(algoliaPayload),
        headers,
        retries: 1,
        requestBudget
      });
      const searchResults = JSON.parse(algoliaResponse.text || '{}');
      if (!Array.isArray(searchResults.hits)) {
        trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Algolia query failed or returned no hits.`, { page, responseStatus: algoliaResponse.status });
        return [];
      }

      logDiscoveryEndpointShape(env, 'algolia_calendar', searchResults.hits, { page, responseStatus: algoliaResponse.status });

      catalogProductions.push(...searchResults.hits.map(hit => ({
        id: normalizeExternalId(hit.TessituraId),
        title: hit.Title,
        calendarVenueHall: resolveCalendarVenueHall(hit)
      })).filter(p => p.id));
      totalPages = Math.max(1, Number(searchResults.nbPages) || 1);
      page += 1;
    }

    if (page < totalPages) {
      trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Discovery stopped at configured page limit.`, { maxPages, totalPages });
    }
    const nowMs = Date.now();
    const allowedCatalogProductions = catalogProductions.filter(production => isDiscoveryHallAllowed(adapter, production.calendarVenueHall));
    const excludedHallCount = catalogProductions.length - allowedCatalogProductions.length;
    const productionQueue = allowedCatalogProductions.filter(production => isProductionDueForDiscovery(production, productionSchedule, nowMs));
    const deferredProductionCount = allowedCatalogProductions.length - productionQueue.length;
    jobState = {
      productionQueue,
      processedIds: [],
      totalEventsDiscovered: 0,
      totalProductions: productionQueue.length,
      processedProductions: 0,
      remainingProductions: productionQueue.length,
      complete: false,
      lastUpdatedAt: new Date().toISOString(),
      productionOutcomeCounts: emptyDiscoveryOutcomeCounts(),
      unknownOutcomeSamples: [],
      runCount: 0,
      catalogProductionCount: catalogProductions.length,
      deferredProductionCount,
    };
    initialQueueSize = productionQueue.length;
    console.log(`[PARSER] Created new discovery job with ${productionQueue.length} due productions; deferred ${deferredProductionCount} recently classified production(s); excluded ${excludedHallCount} production(s) outside the enabled hall allowlist from a ${catalogProductions.length}-production catalog.`);
  } else {
    initialQueueSize = (jobState.productionQueue?.length || 0) + (jobState.processedIds?.length || 0);
    jobState.totalProductions = jobState.totalProductions || initialQueueSize;
    jobState.processedProductions = jobState.processedIds?.length || 0;
    jobState.remainingProductions = jobState.productionQueue.length;
    jobState.complete = Boolean(jobState.complete) || jobState.productionQueue.length === 0;
    jobState.productionOutcomeCounts = { ...emptyDiscoveryOutcomeCounts(), ...(jobState.productionOutcomeCounts || {}) };
    jobState.unknownOutcomeSamples = Array.isArray(jobState.unknownOutcomeSamples)
      ? jobState.unknownOutcomeSamples.slice(0, UNKNOWN_OUTCOME_SAMPLE_LIMIT)
      : [];
    jobState.runCount = Number(jobState.runCount) || 0;
    console.log(`[PARSER] Resuming discovery job with ${jobState.productionQueue.length} productions remaining.`);
  }

  // Process a polite, bounded chunk per scheduled invocation. This remains
  // sequential within the batch to avoid bursts against the venue.
  // Native-only production discovery needs room for BuyButton + settings calls
  // for every on-sale production, so never let an adapter request an unsafe 30+
  // production invocation.
  const BATCH_SIZE = singleProduction ? 1 : Math.max(1, Math.min(Number(adapter.discoveryBatchSize ?? env.DISCOVERY_BATCH_SIZE) || 18, 18));
  const totalRemainingBeforeBatch = jobState.productionQueue.length + (jobState.processedIds?.length || 0);
  const batchToProcess = jobState.productionQueue.splice(0, BATCH_SIZE);

  if (!batchToProcess.length) {
    jobState.processedProductions = jobState.processedIds?.length || 0;
    jobState.remainingProductions = jobState.productionQueue.length;
    jobState.complete = true;
    jobState.lastUpdatedAt = new Date().toISOString();
    console.log(`[PARSER] Discovery job complete. All productions processed. totalCompleted=${jobState.processedProductions}, totalRemaining=0, totalQueued=${jobState.productionQueue.length}, totalKnown=${jobState.totalProductions || jobState.processedProductions}, totalRuns=${jobState.runCount || 0}`);
    trackWorkerLog(env, ctx, 'info', `[PARSER - ${adapter.venueName}] Discovery job finished. A total of ${jobState.totalEventsDiscovered} events were discovered.`, {
      finalEventCount: jobState.totalEventsDiscovered,
      totalCompleted: jobState.processedProductions,
      totalRemaining: 0,
      totalQueued: jobState.productionQueue.length,
      totalKnown: jobState.totalProductions || jobState.processedProductions,
      complete: true,
    });
    if (shouldSendDiscoveryStatusNotification(env, true)) {
      sendDiscoveryStatusToTelegram(env, ctx, adapter.venueName, jobState, 0, 0, 0);
    }
    await setDiscoveryJobState(env.DB, JOB_KEY, jobState);
    await clearDiscoveryJobState(env.DB, JOB_KEY);
    return [];
  }

  const jobRunNumber = jobState.runCount + 1;
  const estimatedInitialRuns = Math.ceil((jobState.totalProductions || totalRemainingBeforeBatch) / BATCH_SIZE);
  console.log(`[PARSER] Discovery progress: run=${jobRunNumber}/${estimatedInitialRuns}, completed=${jobState.processedIds?.length || 0}, remainingInQueue=${jobState.productionQueue.length}, batchSize=${BATCH_SIZE}, totalKnown=${totalRemainingBeforeBatch}, complete=${jobState.complete || false}`);

  const allDiscoveredEvents = [];
  const soldOutPerformanceIds = [];
  const processedThisRun = [];
  const batchStartedAt = Date.now();
  const batchStartedAtIso = new Date(batchStartedAt).toISOString();
  let failedProductionCount = 0;
  const batchOutcomeCounts = emptyDiscoveryOutcomeCounts();
  const unknownOutcomeSamplesInRun = [];
  console.log(`[PARSER] Processing a batch of ${batchToProcess.length} productions.`);
  for (let batchIndex = 0; batchIndex < batchToProcess.length; batchIndex++) {
    if (!isMonitoringWindowActive(new Date(), adapter.timezoneName, adapter.businessHours)) {
      const deferredProductions = batchToProcess.slice(batchIndex);
      jobState.productionQueue.unshift(...deferredProductions);
      console.log(`[PARSER] Curfew reached for ${adapter.venueName}; checkpointing ${deferredProductions.length} unprocessed production(s) for the next allowed window.`);
      break;
    }

    const productionToProcess = batchToProcess[batchIndex];
    const { id: productionSeasonId, title: productionTitle, calendarVenueHall } = productionToProcess;
    let productionOutcome = 'unknown';
    let buyButton = {};
    const currentItemNumber = (jobState.processedIds?.length || 0) + 1;
    console.log(`\n[PARSER] Processing production ${currentItemNumber} of ${initialQueueSize}: "${productionTitle}" (ID: ${productionSeasonId})`);

    try {
      const buttonApiBody = new URLSearchParams({
        ItemId: productionSeasonId,
        ItemType: 'ProductionSeason',
        OnlyFirstAvail: 'false',
        ShouldUseOgMos: 'false',
        KeepPromos: 'false'
      }).toString();
      console.log(`[PARSER] Checking for on-sale status via BuyButton API for production ID: ${productionSeasonId}`);
      const buttonResponse = await executeSecureFetch(env, adapter.buyButtonApiUrl, targetRow, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: buttonApiBody,
        requestBudget
      });

      console.log(`[PARSER] BuyButton response`, {
        productionId: productionSeasonId,
        title: productionTitle,
        responseStatus: buttonResponse?.status
      });

      if (!buttonResponse) {
        throw new Error('BuyButton returned no response object.');
      }

      if (buttonResponse?.text && typeof buttonResponse.text === 'string') {
        try {
          buyButton = JSON.parse(buttonResponse.text);
        } catch (e) {
          trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Failed to parse BuyButton API response.`, { productionId: productionSeasonId, error: e.message, responseText: buttonResponse.text.slice(0, 200) });
          // button remains {} and will be skipped gracefully
        }
      }
      logDiscoveryEndpointShape(env, 'buy_button', buyButton, { productionId: productionSeasonId, responseStatus: buttonResponse.status });
      logDiscoveryEndpointShape(env, 'buy_button_subitems', buyButton?.SubItems || [], { productionId: productionSeasonId });

      const onSalePerformanceIdList = [...new Set(
        (buyButton?.SubItems || [])
          .filter(item => item.Status === 'OnSale' && Number(item.TicketCount) > 0)
          .map(item => normalizeExternalId(item.ItemId))
      )];
      const onSalePerformanceIds = new Set(onSalePerformanceIdList);
      productionOutcome = classifyDiscoveryOutcome(buyButton, onSalePerformanceIds);
      const currentSoldOutPerformances = getCurrentSoldOutPerformances(buyButton);
      for (const performance of currentSoldOutPerformances) {
        const performanceId = normalizeExternalId(performance.ItemId);
        const showtimeMs = Number(performance.Ticks);
        if (!performanceId || !Number.isFinite(showtimeMs)) continue;
        allDiscoveredEvents.push({
          showName: productionTitle,
          showtime: new Date(showtimeMs).toISOString(),
          eventId: performanceId,
          venueId: targetRow.venue_id,
          venueHall: calendarVenueHall,
          eventDetailUrl: adapter.ticketingUrlTemplate?.replace('{performanceId}', performanceId)
        });
        soldOutPerformanceIds.push(performanceId);
      }
      if (productionOutcome === 'unknown') {
        const sample = buildUnknownOutcomeSample(productionSeasonId, productionTitle, buyButton, buttonResponse.status);
        unknownOutcomeSamplesInRun.push(sample);
        if (jobState.unknownOutcomeSamples.length < UNKNOWN_OUTCOME_SAMPLE_LIMIT) {
          jobState.unknownOutcomeSamples.push(sample);
        }
        console.warn(`[PARSER] Unclassified discovery outcome for production ${productionSeasonId} ("${productionTitle}").`, sample);
      }
      
      if (onSalePerformanceIdList.length) {
        let settingsPayload = null;
        let representativePerformanceId = null;
        for (const performanceId of onSalePerformanceIdList) {
          const settingsUrl = adapter.settingsApiUrlPattern?.replace('{performanceId}', performanceId);
          if (!settingsUrl) throw new Error('settingsApiUrlPattern is not configured in the adapter.');

          console.log(`[PARSER] Fetching settings for production "${productionTitle}" via performanceId: ${performanceId}`);
          const candidatePayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET', apiRequest: true, requestBudget });
          if (candidatePayload.status >= 200 && candidatePayload.status < 300) {
            settingsPayload = candidatePayload;
            representativePerformanceId = performanceId;
            break;
          }
          if (candidatePayload.status !== 404) {
            throw new Error(`Settings API returned HTTP ${candidatePayload.status}.`);
          }
          console.warn(`[PARSER] Settings API returned 404 for performanceId ${performanceId}; trying another on-sale performance if available.`);
        }

        if (!settingsPayload) {
          productionOutcome = 'settings_unavailable';
          trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] On-sale production has no resolvable settings performance.`, {
            productionId: productionSeasonId,
            onSalePerformanceIds: onSalePerformanceIdList
          });
        } else {
        const settingsData = JSON.parse(settingsPayload.text || '{}');
        const additionalPerformances = Array.isArray(settingsData.additionalPerformances)
          ? settingsData.additionalPerformances
          : [];
        logDiscoveryEndpointShape(env, 'seatme_settings', settingsData, { productionId: productionSeasonId, responseStatus: settingsPayload.status });
        logDiscoveryEndpointShape(env, 'seatme_settings_performances', additionalPerformances, { productionId: productionSeasonId });
        const performanceHalls = additionalPerformances
          .map(performance => calendarVenueHall || resolveVenueHall(performance, settingsData));
        console.log(`[PARSER] Settings response summary`, {
          productionId: productionSeasonId,
          responseStatus: settingsPayload.status,
          routedVia: settingsPayload.routedVia,
          additionalPerformanceCount: additionalPerformances.length,
          onSalePerformanceCount: onSalePerformanceIds.size,
          venueHalls: [...new Set(performanceHalls.filter(Boolean))],
          performancesMissingVenueHall: performanceHalls.filter(hall => !hall).length
        });
        const unresolvedPerformanceSamples = additionalPerformances
          .filter((performance, index) => !performanceHalls[index])
          .slice(0, 3)
          .map(performance => ({
            performanceId: normalizeExternalId(performance?.performanceId || performance?.id),
            fieldNames: getObjectFieldNames(performance)
          }));
        if (unresolvedPerformanceSamples.length) {
          console.warn('[PARSER] Discovery could not resolve a venue hall from the calendar or settings payload.', {
            productionId: productionSeasonId,
            settingsFieldNames: getObjectFieldNames(settingsData),
            unresolvedPerformanceSamples
          });
        }

        if (additionalPerformances.length) {
          for (const p of additionalPerformances) {
            if (p.performanceId && p.performanceDate && onSalePerformanceIds.has(normalizeExternalId(p.performanceId))) {
              allDiscoveredEvents.push({
                showName: p.description || `Performance ${p.performanceId}`,
                showtime: p.performanceDate.replace('T', ' '),
                eventId: normalizeExternalId(p.performanceId),
                venueId: targetRow.venue_id,
                venueHall: calendarVenueHall || resolveVenueHall(p, settingsData),
                eventDetailUrl: adapter.ticketingUrlTemplate?.replace('{performanceId}', p.performanceId)
              });
            }
          }
        }
        }
      } else {
        // Enhance logging to summarize the statuses of sub-items if they exist.
        let subItemSummary = 'no sub-items found';
        if (buyButton?.SubItems?.length > 0) {
          const statusCounts = buyButton.SubItems.reduce((acc, item) => {
            acc[item.Status] = (acc[item.Status] || 0) + 1;
            return acc;
          }, {});
          subItemSummary = `sub-item statuses: ${JSON.stringify(statusCounts)}`;
        }
        console.log(`[PARSER] Skipping production ${productionSeasonId} ("${productionTitle}") because its overall status is "${buyButton.Status}" (HTTP: ${buttonResponse.status}) and no on-sale performances were found (${subItemSummary}).`);
      }
    } catch (err) {
      if (err?.code === 'SUBREQUEST_BUDGET_EXHAUSTED') {
        const deferredProductions = batchToProcess.slice(batchIndex);
        jobState.productionQueue.unshift(...deferredProductions);
        console.warn(`[PARSER] External subrequest budget reached (${DISCOVERY_EXTERNAL_REQUEST_BUDGET}); checkpointing ${deferredProductions.length} production(s) for the next invocation.`);
        break;
      }
      failedProductionCount += 1;
      productionOutcome = 'error';
      console.error(`[PARSER - ${adapter.venueName}] Production ${productionSeasonId} failed: ${err.message}`);
      trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Unhandled error processing production hit.`, { productionId: productionSeasonId, title: productionTitle, error: err.message });
    }
    batchOutcomeCounts[productionOutcome] += 1;
    jobState.productionOutcomeCounts = { ...emptyDiscoveryOutcomeCounts(), ...(jobState.productionOutcomeCounts || {}) };
    jobState.productionOutcomeCounts[productionOutcome] += 1;
    jobState.processedIds.push(productionSeasonId);
    processedThisRun.push(productionSeasonId);
    if (!singleProduction) scheduleProductionRecheck(productionSchedule, productionToProcess, productionOutcome, Date.now(), buyButton);
  }

  // Persist events before checkpointing the queue. If persistence fails, the
  // batch will safely be retried on the next run instead of being lost.
  const upsertResult = await upsertDiscoveredEvents(env.DB, allDiscoveredEvents);
  const soldOutEventsEnrolled = await markDiscoveredSoldOutEvents(env.DB, soldOutPerformanceIds, new Date().toISOString());
  jobState.totalEventsDiscovered = (jobState.totalEventsDiscovered || 0) + (upsertResult.inserted || 0);
  jobState.processedProductions = jobState.processedIds.length;
  jobState.remainingProductions = jobState.productionQueue.length;
  jobState.totalProductions = jobState.totalProductions || initialQueueSize;
  jobState.runCount = jobRunNumber;
  jobState.complete = jobState.productionQueue.length === 0;
  jobState.lastUpdatedAt = new Date().toISOString();
  if (!singleProduction) await setDiscoveryJobState(env.DB, JOB_KEY, jobState);
  if (!singleProduction) await setDiscoveryProductionSchedule(env.DB, targetRow.venue_id, productionSchedule);

  const batchDurationMs = Date.now() - batchStartedAt;
  const batchCompletedAtIso = new Date().toISOString();
  const averageMsPerProduction = processedThisRun.length
    ? Math.round(batchDurationMs / processedThisRun.length)
    : 0;
  const estimatedRunsRemaining = Math.ceil(jobState.productionQueue.length / BATCH_SIZE);
  console.log(`[PARSER] Discovery batch metrics`, {
    processedProductions: processedThisRun.length,
    discoveredEvents: allDiscoveredEvents.length,
    insertedEvents: upsertResult.inserted,
    soldOutEventsEnrolled,
    durationMs: batchDurationMs,
    averageMsPerProduction,
    outcomes: batchOutcomeCounts,
    unknownOutcomeSamples: unknownOutcomeSamplesInRun,
    jobRunNumber,
    estimatedRunsRemaining
  });

  if (singleProduction) {
    return {
      status: 'completed',
      productionId: processedThisRun[0] || normalizeExternalId(singleProduction.id),
      title: singleProduction.title || null,
      outcome: Object.entries(batchOutcomeCounts).find(([, count]) => count > 0)?.[0] || 'unknown',
      discoveredEvents: allDiscoveredEvents,
      insertedEvents: upsertResult.inserted || 0,
      updatedEvents: upsertResult.updated || 0,
      failedProductionCount,
      durationMs: batchDurationMs,
    };
  }

  await recordDiscoveryBatchMetric(env.DB, {
    id: `discovery:${targetRow.venue_id}:${batchStartedAt}:${crypto.randomUUID()}`,
    venueId: targetRow.venue_id,
    startedAt: batchStartedAtIso,
    completedAt: batchCompletedAtIso,
    durationMs: batchDurationMs,
    processedProductionCount: processedThisRun.length,
    discoveredEventCount: allDiscoveredEvents.length,
    insertedEventCount: upsertResult.inserted || 0,
    failedProductionCount,
    remainingProductionCount: jobState.productionQueue.length,
    totalProductionCount: initialQueueSize,
    outcomeCounts: batchOutcomeCounts,
    jobRunNumber,
    estimatedRunsRemaining
  });

  trackWorkerLog(env, ctx, 'info', `[PARSER - ${adapter.venueName}] Discovery run finished. Found ${upsertResult.inserted} new events.`, {
    venueId: targetRow.venue_id,
    strategy: 'segerstromProductionDiscovery',
    processedProductionsInRun: processedThisRun,
    newEventsInRun: upsertResult.inserted,
    discoveredEventsInRun: allDiscoveredEvents.length,
    processedProductionCount: processedThisRun.length,
    durationMs: batchDurationMs,
    averageMsPerProduction,
    failedProductionCount,
    totalEventsDiscoveredInJob: jobState.totalEventsDiscovered,
    productionsRemaining: jobState.productionQueue.length,
    complete: jobState.productionQueue.length === 0,
    totalProductions: jobState.totalProductions || initialQueueSize,
    processedProductions: jobState.processedProductions,
    remainingProductions: jobState.productionQueue.length,
    lastUpdatedAt: jobState.lastUpdatedAt,
    outcomeCountsInRun: batchOutcomeCounts,
    outcomeCountsInJob: jobState.productionOutcomeCounts,
    unknownOutcomeSamplesInRun,
    unknownOutcomeSamplesInJob: jobState.unknownOutcomeSamples,
    jobRunNumber,
    totalJobRuns: jobState.runCount,
    estimatedRunsRemaining,
  });
  if (shouldSendDiscoveryStatusNotification(env, jobState.productionQueue.length === 0)) {
    sendDiscoveryStatusToTelegram(env, ctx, adapter.venueName, jobState, upsertResult.inserted || 0, allDiscoveredEvents.length, batchDurationMs);
  }
  if (jobState.complete) {
    console.log(`[PARSER] Discovery job complete. All ${jobState.processedProductions} productions processed in ${jobState.runCount} run(s); ${jobState.totalEventsDiscovered} new events discovered.`, {
      outcomes: jobState.productionOutcomeCounts,
      unknownOutcomeSamples: jobState.unknownOutcomeSamples
    });
    await clearDiscoveryJobState(env.DB, JOB_KEY);
  }
  return [];
}

export async function segerstromProductionDiscoveryStrategy(targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch) {
  const jobKey = 'segerstrom_discovery_job';
  const leaseOwner = crypto.randomUUID();
  const now = new Date();
  // Discovery runs every five minutes. The lease is deliberately slightly
  // shorter so a terminated invocation recovers on the next cron, while a
  // healthy bounded batch cannot be processed concurrently.
  const leaseExpiresAt = new Date(now.getTime() + (4 * 60 * 1000)).toISOString();
  const claimed = await claimDiscoveryJobLease(env.DB, jobKey, leaseOwner, leaseExpiresAt, now.toISOString());
  if (!claimed) {
    console.log(`[PARSER] Discovery job ${jobKey} is already leased; skipping overlapping invocation.`);
    return [];
  }

  try {
    return await segerstromProductionDiscoveryStrategyImpl(
      targetRow, htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch
    );
  } finally {
    try {
      await releaseDiscoveryJobLease(env.DB, jobKey, leaseOwner);
    } catch (error) {
      console.error(`[PARSER] Failed to release discovery lease: ${error.message}`);
    }
  }
}

// Uses the same production-processing path as queued discovery, but never
// creates, leases, advances, or clears the paginated discovery checkpoint.
export async function segerstromSingleProductionDiscovery(targetRow, production, env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch) {
  return segerstromProductionDiscoveryStrategyImpl(
    targetRow, '', env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch,
    { singleProduction: production }
  );
}

/**
 * An API-first discovery strategy that queries the venue's Algolia search index directly.
 * This is more robust and efficient than parsing HTML.
 */
export async function algoliaDiscoveryStrategy(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch) {
  console.log(`[PARSER] Algolia API discovery strategy initiated for venue ${targetRow.venue_id}.`);

  // Start with configured values, but attempt to discover them dynamically.
  let { algoliaAppId, algoliaApiKey, algoliaIndexName } = adapter;

  try {
    // Step 1: Fetch the main calendar page to find dynamic settings from `window.settings`.
    // This makes the strategy resilient to future credential changes.
    console.log(`[PARSER] Fetching calendar page to discover dynamic Algolia credentials.`);
    const pagePayload = await executeSecureFetch(env, adapter.urlPattern, targetRow, { method: 'GET' });
    const pageHtml = pagePayload.text || '';

    if (pagePayload.status === 200) {
      const settingsMatch = pageHtml.match(/window\.settings\s*=\s*({[\s\S]*?});/);
      if (settingsMatch?.[1]) {
        try {
          const dynamicSettings = JSON.parse(settingsMatch[1]);
          if (dynamicSettings.appid && dynamicSettings.apikey && dynamicSettings.index) {
            console.log(`[PARSER] Dynamically discovered Algolia credentials. Overriding venue config.`);
            algoliaAppId = dynamicSettings.appid;
            algoliaApiKey = dynamicSettings.apikey;
            algoliaIndexName = dynamicSettings.index;
          }
        } catch (e) {
          trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Failed to parse window.settings JSON.`, { error: e.message });
        }
      } else {
        trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Could not find window.settings object on page. Falling back to configured credentials.`);
      }
    } else {
      trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Failed to fetch calendar page (${pagePayload.status}). Falling back to configured credentials.`);
    }

    // Step 2: Proceed with the Algolia API query using the best available credentials.
    const algoliaUrl = `https://${algoliaAppId}-dsn.algolia.net/1/indexes/${algoliaIndexName}/query`;
    const algoliaPayload = { params: 'hitsPerPage=100&filters=ExcludeFromCalendar:false AND ItemType:Production' };

    // This is a direct, server-to-server API call. It does not need to go through the ZenRows proxy.
    const response = await executeApiFetch(algoliaUrl, { method: 'POST', body: JSON.stringify(algoliaPayload), headers: { 'Content-Type': 'application/json', 'X-Algolia-Application-Id': algoliaAppId, 'X-Algolia-API-Key': algoliaApiKey } });
    const searchResults = JSON.parse(response.text || '{}');
    const allDiscoveredEvents = [];

    if (searchResults.hits) {
      for (const hit of searchResults.hits) {
        // The most reliable flow: use KenticoUrl to get the detail page,
        // scrape the initial performance ID from that page, then use the settings API.
        if (hit.KenticoUrl) {
          const eventDetailUrl = new URL(hit.KenticoUrl, adapter.urlPattern).toString();
          // We must use the secure browser fetcher here to ensure JS executes and we get the ID.
          const detailPagePayload = await executeSecureFetch(env, eventDetailUrl, targetRow, { method: 'GET' });
          const detailPageHtml = detailPagePayload.text || '';

          // Find the production ID (which serves as the initial performance ID) from the detail page's HTML.
          const perfIdMatch = detailPageHtml.match(/data-productionid=(["'])(\d+)\1/);
          if (perfIdMatch?.[2]) {
            const initialPerformanceId = perfIdMatch[2];
            const settingsUrl = adapter.settingsApiUrlPattern?.replace('{performanceId}', initialPerformanceId);
            console.log(`[PARSER] Found initial performanceId ${initialPerformanceId} for "${hit.Title}". Fetching all showtimes from: ${settingsUrl}`);
            
            // This is a direct API call, so we use executeApiFetch.
            try {
              const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET', apiRequest: true });
              const settingsData = JSON.parse(settingsPayload.text || '{}');

              if (settingsData.additionalPerformances) {
                for (const p of settingsData.additionalPerformances) {
                  // Add guards to ensure the performance has a valid ID and date before processing.
                  if (p.performanceId && p.performanceDate) {
                    allDiscoveredEvents.push({
                      showName: p.description,
                      showtime: p.performanceDate?.replace('T', ' '),
                      eventId: p.performanceId,
                      venueId: targetRow.venue_id,
                      venueHall: resolveVenueHall(p, settingsData),
                      eventDetailUrl: adapter.ticketingUrlTemplate?.replace('{performanceId}', p.performanceId)
                    });
                  }
                }
              }
            } catch (apiErr) {
              trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Failed to fetch settings API for performanceId ${initialPerformanceId}.`, { error: apiErr.message });
            }
          }
        }
      }
    }

    await upsertDiscoveredEvents(env.DB, allDiscoveredEvents);
    return [];
  } catch (err) {
    trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Algolia discovery strategy failed: ${err.message}. Attempting fallback to calendar page scraping.`, {
      error: String(err)
    });

    // If the primary API strategy fails, fall back to the more brittle HTML scraping strategy
    // as a resilience measure. The htmlBody was already fetched by the main worker loop.
    return calendarPageDiscoveryStrategy(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter);
  }
}

export const STRATEGY_REGISTRY = {
  'singleStep': singleStepParseStrategy,
  'calendarPageDiscovery': calendarPageDiscoveryStrategy,
  'segerstromDrillDown': segerstromDrillDownStrategy,
  'segerstromProductionDiscovery': segerstromProductionDiscoveryStrategy,
  'algoliaDiscovery': algoliaDiscoveryStrategy,
};
