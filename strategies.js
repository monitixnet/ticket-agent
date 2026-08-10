import { VENUE_PARSERS } from './venue-rules.js';
import { upsertDiscoveredEvents } from './database/queries.js';
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
export async function segerstromDrillDownStrategy(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter) {
  const performanceId = new URL(targetRow.event_url).searchParams.get(adapter.performanceIdParam || 'id');

  if (!performanceId) {
    trackWorkerLog(env, ctx, 'error', `[PARSER - Segerstrom] Could not extract performanceId from event_url: ${targetRow.event_url}`);
    return [];
  }

  try {
    // Step 1: Get performance settings, which includes the mapping of sectionGroupId to section names.
    const settingsUrl = adapter.settingsApiUrlPattern.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching performance settings from: ${settingsUrl}`);
    const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow);
    const settingsData = JSON.parse(settingsPayload.text || '{}');
    const sectionNameMap = (settingsData?.facilitySettings?.sectionGroupings || []).reduce((map, group) => {
      map[group.sectionGroupId] = group.description;
      return map;
    }, {});

    // Step 2: Get pricing information for all zones
    const priceApiUrl = adapter.priceApiUrlPattern.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching zone pricing from: ${priceApiUrl}`);
    const pricePayload = await executeSecureFetch(env, priceApiUrl, targetRow);
    const priceData = JSON.parse(pricePayload.text || '[]');
    const zonePriceMap = priceData.reduce((map, zone) => {
      if (zone.prices && zone.prices[0]) {
        map[zone.zoneId] = zone.prices[0].price;
      }
      return map;
    }, {});

    // Step 3: Get section availability
    const sectionAvailabilityUrl = adapter.inventoryApiUrlPattern.replace('{performanceId}', performanceId);
    console.log(`[PARSER] Fetching section availability from: ${sectionAvailabilityUrl}`);
    const sectionPayload = await executeSecureFetch(env, sectionAvailabilityUrl, targetRow);
    const sectionGroups = JSON.parse(sectionPayload.text || '[]');

    const allSeatData = [];

    if (adapter.seatInfoApiUrlPattern) {
      // Step 4: For each section group, get the detailed seat info
      for (const group of sectionGroups) {
        if (group.sectionGroupId) {
          const seatInfoUrl = adapter.seatInfoApiUrlPattern
            .replace('{performanceId}', performanceId)
            .replace('{groupId}', group.sectionGroupId);
          console.log(`[PARSER] Fetching detailed seat info from: ${seatInfoUrl}`);
          const seatInfoPayload = await executeSecureFetch(env, seatInfoUrl, targetRow);
          const seatInfo = JSON.parse(seatInfoPayload.text || '{}');
          allSeatData.push({ ...seatInfo, sectionGroupName: sectionNameMap[group.sectionGroupId] || group.sectionGroupName });
        }
      }
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

  const allDiscoveredEvents = [];
  // 1. Find all high-level show "card" blocks on the page.
  // This resilient regex finds each event by its top-level 'card-wrap' container.
  const showCardRegex = /<div class="card-wrap[^"]*">([\s\S]*?)<\/div>/gi;
  const showCards = [...htmlBody.matchAll(showCardRegex)];

  if (showCards.length === 0) {
    trackWorkerLog(env, ctx, 'warn', `[PARSER - ${adapter.venueName}] No show cards found on calendar page.`, {
      venueId: targetRow.venue_id,
      htmlBodySnippet: htmlBody.slice(0, 1500)
    });
    return [];
  }

  // 2. For each show card, check for a "Buy Now" button and extract the detail page URL.
  for (const card of showCards) {
    const cardHtml = card[0];
    const hasBuyNow = /class="[^"]*buy-tickets[^"]*"/i.test(cardHtml);

    if (hasBuyNow) {
      const linkMatch = cardHtml.match(/<a\s+href=(["'])([^"']+)\1/i);

      if (linkMatch && linkMatch[2]) {
        const eventDetailUrl = new URL(linkMatch[2], targetRow.event_url).toString();
        const detailPagePayload = await executeSecureFetch(env, eventDetailUrl, targetRow);
        const detailPageHtml = detailPagePayload.text || '';

        const perfIdMatch = detailPageHtml.match(/data-productionid=(["'])(\d+)\1/);
        if (perfIdMatch && perfIdMatch[2]) {
          const performanceId = perfIdMatch[2];
          // Use the settings API to get all other performances for this production
          const settingsUrl = adapter.settingsApiUrlPattern.replace('{performanceId}', performanceId);
          console.log(`[PARSER] Found performanceId ${performanceId}. Fetching all showtimes from: ${settingsUrl}`);
          const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow);
          const settingsData = JSON.parse(settingsPayload.text || '{}');

          if (settingsData.additionalPerformances) {
            for (const p of settingsData.additionalPerformances) {
              allDiscoveredEvents.push({
                showName: p.description,
                showtime: p.performanceDate.replace('T', ' '),
                eventId: p.performanceId,
                venueId: targetRow.venue_id,
                eventDetailUrl: adapter.ticketingUrlTemplate.replace('{performanceId}', p.performanceId)
              });
            }
            break; // Found all performances for this show, move to the next card
          }
        }
      }
    }
  }

  console.log(`[PARSER] Discovery complete. Found ${allDiscoveredEvents.length} total events.`);

  // The discovery strategy's job is to find events and hand them off for persistence.
  await upsertDiscoveredEvents(env.DB, allDiscoveredEvents);
  return []; // Discovery strategies return empty inventory.
}

/**
 * An API-first discovery strategy that queries the venue's Algolia search index directly.
 * This is more robust and efficient than parsing HTML.
 */
export async function algoliaDiscoveryStrategy(targetRow, _htmlBody, env, ctx, executeSecureFetch, trackWorkerLog, adapter) {
  console.log(`[PARSER] Algolia API discovery strategy initiated for venue ${targetRow.venue_id}.`);

  const { algoliaAppId, algoliaApiKey, algoliaIndexName } = adapter;

  if (!algoliaAppId || !algoliaApiKey || !algoliaIndexName) {
    trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Missing Algolia configuration in venue adapter.`);
    return [];
  }

  try {
    const algoliaUrl = `https://${algoliaAppId}-dsn.algolia.net/1/indexes/${algoliaIndexName}/query`;
    const algoliaPayload = { params: 'filters=ExcludeFromCalendar:false AND ItemType:Production&hitsPerPage=100' };

    const response = await executeSecureFetch(env, algoliaUrl, {
      ...targetRow,
      method: 'POST',
      body: JSON.stringify(algoliaPayload),
      headers: {
        'X-Algolia-Application-Id': algoliaAppId,
        'X-Algolia-API-Key': algoliaApiKey,
        'Content-Type': 'application/json'
      }
    });

    const searchResults = JSON.parse(response.text || '{}');
    const allDiscoveredEvents = [];

    if (searchResults.hits) {
      for (const hit of searchResults.hits) {
        if (hit.PurchaseUrl && hit.PurchaseUrl.includes('seatme.scfta.org')) {
          const performanceId = new URL(hit.PurchaseUrl).searchParams.get('id');
          if (performanceId) {
            const settingsUrl = adapter.settingsApiUrlPattern.replace('{performanceId}', performanceId);
            const settingsPayload = await executeSecureFetch(env, settingsUrl, targetRow);
            const settingsData = JSON.parse(settingsPayload.text || '{}');
            if (settingsData.additionalPerformances) {
              for (const p of settingsData.additionalPerformances) {
                allDiscoveredEvents.push({
                  showName: p.description,
                  showtime: p.performanceDate.replace('T', ' '),
                  eventId: p.performanceId,
                  venueId: targetRow.venue_id,
                  eventDetailUrl: adapter.ticketingUrlTemplate.replace('{performanceId}', p.performanceId)
                });
              }
            }
          }
        }
      }
    }

    await upsertDiscoveredEvents(env.DB, allDiscoveredEvents);
    return [];
  } catch (err) {
    trackWorkerLog(env, ctx, 'error', `[PARSER - ${adapter.venueName}] Algolia discovery strategy failed: ${err.message}`);
    return [];
  }
}

export const STRATEGY_REGISTRY = {
  'singleStep': singleStepParseStrategy,
  'calendarPageDiscovery': calendarPageDiscoveryStrategy,
  'segerstromDrillDown': segerstromDrillDownStrategy,
  'algoliaDiscovery': algoliaDiscoveryStrategy,
};