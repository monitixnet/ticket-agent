import { VENUE_PARSERS } from './venue-rules.js';
import { upsertDiscoveredEvents, getDiscoveryJobState, setDiscoveryJobState, clearDiscoveryJobState } from './database/queries.js';
import { ACTIVE_VENUE_ADAPTERS } from './venue-config.js';
import { delayExecution, randomBetween } from './utils.js';

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
    const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET' });
    const settingsData = JSON.parse(settingsPayload.text || '{}');
    const sectionNameMap = (settingsData?.facilitySettings?.sectionGroupings || []).reduce((map, group) => {
      map[group.sectionGroupId] = group.description;
      return map;
    }, {});

    // Step 2: Get pricing information for all zones.
    const priceApiUrl = adapter.priceApiUrlPattern?.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching zone pricing from: ${priceApiUrl}`); // Keep logging for visibility
    const pricePayload = await executeSecureFetch(env, priceApiUrl, targetRow, { method: 'GET' });
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
    const sectionPayload = await executeSecureFetch(env, sectionAvailabilityUrl, targetRow, { method: 'GET' });
    const sectionGroups = JSON.parse(sectionPayload.text || '[]');

    const allSeatData = [];

    if (adapter.seatInfoApiUrlPattern) {
      // Step 4: For each section group, get the detailed seat info in parallel.
      const seatInfoPromises = sectionGroups.map(group => {
        if (group.sectionGroupId) {
          const seatInfoUrl = adapter.seatInfoApiUrlPattern?.replace('{performanceId}', performanceId)?.replace('{groupId}', group.sectionGroupId);
          console.log(`[PARSER] Fetching detailed seat info from: ${seatInfoUrl}`); // Keep logging for visibility
          return executeSecureFetch(env, seatInfoUrl, targetRow, { method: 'GET' }).then(payload => ({ ...JSON.parse(payload.text || '{}'), sectionGroupName: sectionNameMap[group.sectionGroupId] || group.sectionGroupName }));
        }
        return Promise.resolve(null); // Return a resolved promise for groups without ID
      });
      allSeatData.push(...(await Promise.all(seatInfoPromises)).filter(Boolean));
    }

    // Step 5: Pass the combined seat and price data to the final parser
    const finalPayload = { seats: allSeatData, prices: zonePriceMap };
    const parser = VENUE_PARSERS[targetRow.venue_id];
    return parser(JSON.stringify(finalPayload), targetRow.venue_id);
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
        const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET' });
        const settingsData = JSON.parse(settingsPayload.text || '{}');
        
        if (settingsData.additionalPerformances) {
          for (const p of settingsData.additionalPerformances) {
            allDiscoveredEvents.push({
              showName: p.description,
              showtime: p.performanceDate?.replace('T', ' '),
              eventId: p.performanceId,
              venueId: targetRow.venue_id,
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
export async function segerstromProductionDiscoveryStrategy(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter, executeApiFetch) {
  console.log(`[PARSER] Segerstrom API-driven discovery strategy initiated for venue ${targetRow.venue_id}.`);
  console.log(`[PARSER] Adapter object received: ${JSON.stringify(adapter)}`); // NEW DEBUG LOG

  const JOB_KEY = `segerstrom_discovery_job`;
  let initialQueueSize = 0;
  let jobState = await getDiscoveryJobState(env.DB, JOB_KEY);

  // If no job is in progress, start a new one by fetching all production IDs from Algolia.
  if (!jobState || !jobState.productionQueue?.length) {
    console.log(`[PARSER] No active discovery job found. Starting a new one.`);
    const { algoliaAppId, algoliaApiKey, algoliaIndexName } = adapter;
    const algoliaUrl = `https://${algoliaAppId}-dsn.algolia.net/1/indexes/${algoliaIndexName}/query`;
    const algoliaPayload = { params: 'hitsPerPage=100&filters=ExcludeFromCalendar:false AND ItemType:Production' };
    const algoliaResponse = await executeApiFetch(algoliaUrl, {
      method: 'POST',
      body: JSON.stringify(algoliaPayload),
      headers: { 'Content-Type': 'application/json', 'X-Algolia-Application-Id': algoliaAppId, 'X-Algolia-API-Key': algoliaApiKey }
    });

    const searchResults = JSON.parse(algoliaResponse.text || '{}');
    if (!searchResults.hits) {
      trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Algolia query failed or returned no hits.`, { response: searchResults });
      return [];
    }

    const productionQueue = searchResults.hits.map(hit => ({ id: hit.TessituraId, title: hit.Title })).filter(p => p.id);
    jobState = { productionQueue, processedIds: [], totalEventsDiscovered: 0 };
    initialQueueSize = productionQueue.length;
    console.log(`[PARSER] Created new discovery job with ${productionQueue.length} productions.`);
  } else {
    initialQueueSize = (jobState.productionQueue?.length || 0) + (jobState.processedIds?.length || 0);
    console.log(`[PARSER] Resuming discovery job with ${jobState.productionQueue.length} productions remaining.`);
  }

  const BATCH_SIZE = 20; // A more aggressive batch size to accelerate discovery.
  const batchToProcess = jobState.productionQueue.splice(0, BATCH_SIZE);

  if (!batchToProcess.length) {
    console.log(`[PARSER] Discovery job complete. All productions processed.`);
    trackWorkerLog(env, ctx, 'info', `[PARSER - ${adapter.venueName}] Discovery job finished. A total of ${jobState.totalEventsDiscovered} events were discovered.`, {
      finalEventCount: jobState.totalEventsDiscovered,
    });
    await clearDiscoveryJobState(env.DB, JOB_KEY);
    return [];
  }

  const allDiscoveredEvents = [];
  console.log(`[PARSER] Processing a batch of ${batchToProcess.length} productions.`);
  debugger;
  for (const productionToProcess of batchToProcess) {
    const { id: productionSeasonId, title: productionTitle } = productionToProcess;
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
        body: buttonApiBody
      });

      console.log(`[SEGerstrom DEBUG] BuyButton raw response`, {
        productionId: productionSeasonId,
        title: productionTitle,
        responseType: typeof buttonResponse,
        responseStatus: buttonResponse?.status,
        responseKeys: buttonResponse ? Object.keys(buttonResponse) : [],
        textLength: typeof buttonResponse?.text === 'string'
          ? buttonResponse.text.length
          : null,
        textPreview: typeof buttonResponse?.text === 'string'
          ? buttonResponse.text.slice(0, 1000)
          : null,
      });

      let button = {};

      if (!buttonResponse) {
        throw new Error('BuyButton returned no response object.');
      }

      if (buttonResponse?.text && typeof buttonResponse.text === 'string') {
        try {
          button = JSON.parse(buttonResponse.text);
        } catch (e) {
          trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] Failed to parse BuyButton API response.`, { productionId: productionSeasonId, error: e.message, responseText: buttonResponse.text.slice(0, 200) });
          // button remains {} and will be skipped gracefully
        }
      }

      const firstOnSaleSubItem = button?.SubItems?.find(si => si.Status === 'OnSale' && si.TicketCount !== 0);
      
      if (firstOnSaleSubItem) {
        const representativePerformanceId = firstOnSaleSubItem.ItemId.toString();
        const settingsUrl = adapter.settingsApiUrlPattern?.replace('{performanceId}', representativePerformanceId);
        if (!settingsUrl) throw new Error('settingsApiUrlPattern is not configured in the adapter.');

        console.log(`[PARSER] Fetching settings for production "${productionTitle}" via performanceId: ${representativePerformanceId}`);
        const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET' });
        const settingsData = JSON.parse(settingsPayload.text || '{}');

        if (settingsData.additionalPerformances) {
          for (const p of settingsData.additionalPerformances) {
            if (p.hasAvailability && p.performanceId && p.performanceDate) {
              allDiscoveredEvents.push({
                showName: p.description || `Performance ${p.performanceId}`,
                showtime: p.performanceDate.replace('T', ' '),
                eventId: p.performanceId,
                venueId: targetRow.venue_id,
                eventDetailUrl: adapter.ticketingUrlTemplate?.replace('{performanceId}', p.performanceId)
              });
            }
          }
        }
      } else {
        // Enhance logging to summarize the statuses of sub-items if they exist.
        let subItemSummary = 'no sub-items found';
        if (button?.SubItems?.length > 0) {
          const statusCounts = button.SubItems.reduce((acc, item) => {
            acc[item.Status] = (acc[item.Status] || 0) + 1;
            return acc;
          }, {});
          subItemSummary = `sub-item statuses: ${JSON.stringify(statusCounts)}`;
        }
        console.log(`[PARSER] Skipping production ${productionSeasonId} ("${productionTitle}") because its overall status is "${button.Status}" (HTTP: ${buttonResponse.status}) and no on-sale performances were found (${subItemSummary}).`);
      }
    } catch (err) {
      trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Unhandled error processing production hit.`, { productionId: productionSeasonId, title: productionTitle, error: err.message });
    }
    jobState.processedIds.push(productionSeasonId);
  }

  // Update the job state before finishing.
  await setDiscoveryJobState(env.DB, JOB_KEY, jobState);
  const upsertResult = await upsertDiscoveredEvents(env.DB, allDiscoveredEvents);
  jobState.totalEventsDiscovered = (jobState.totalEventsDiscovered || 0) + (upsertResult.inserted || 0);
  await setDiscoveryJobState(env.DB, JOB_KEY, jobState);

  trackWorkerLog(env, ctx, 'info', `[PARSER - ${adapter.venueName}] Discovery run finished. Found ${upsertResult.inserted} new events.`, {
    venueId: targetRow.venue_id,
    strategy: 'segerstromProductionDiscovery',
    processedProductionsInRun: batchToProcess.map(p => p.id),
    newEventsInRun: upsertResult.inserted,
    totalEventsDiscoveredInJob: jobState.totalEventsDiscovered,
    productionsRemaining: jobState.productionQueue.length,
  });
  return [];
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
              const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow, { method: 'GET' });
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