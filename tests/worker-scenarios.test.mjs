import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHumanReviewNotification,
  filterInventoryForDropPriceRule,
  default as worker,
} from '../index.js';
import {
  isMonitoringWindowActive,
  getScheduleModeForCronDate,
  inferVenueTimeZone,
  buildVenueAdapterSmokeReport,
  isSmokeMatrixReady,
  buildOperationalTelemetrySnapshot,
  isBlockLikeStatus,
  computeBackoffDelayMs,
  isSkyboxListingEnabled,
} from '../venue-logic.js';
import {
  parseSegerstromInventoryDocument,
  evaluateEquivalentInventoryCoverage,
  isSpecificSeatMatch,
  isPriceParityMatch,
  findContiguousSeatBlocks,
  findSegerstromBufferedCandidates,
  isNotApplicableRowPolicy,
} from '../venue-rules.js';
import {
  segerstromDrillDownStrategy,
  segerstromProductionDiscoveryStrategy,
  resolveVenueHall
} from '../strategies.js';
import {
  getNextUpcomingEvent,
  getNextEventWithActiveListing,
  getListingForValidation,
  upsertDiscoveredEvents,
} from '../database/queries.js';
import { normalizeExternalId } from '../utils.js';
import { getActiveVenueAdapters } from '../database/venue-runtime-config.js';

const WEBHOOK_SECRET = 'test-shared-secret';
const TEST_ADAPTERS = [{
  venueId: 'segerstrom_center', venueName: 'Segerstrom Center for the Arts',
  timezoneName: 'America/Los_Angeles', securityTier: 'high', active: true,
  monitoringOnly: true, listingApprovalAllowed: false, baseIntervalMs: 120000,
  maxIntervalMs: 600000, requiredInventoryFields: ['eventId'],
  smokeChecks: ['time_window']
}];

const run = async () => {
  test('business window is open for Los Angeles during active hours', () => {
    assert.equal(isMonitoringWindowActive(new Date('2026-08-03T13:00:00-07:00'), 'America/Los_Angeles'), true);
  });

  test('business window is closed before 7:30 AM local venue time', () => {
    assert.equal(isMonitoringWindowActive(new Date('2026-08-03T06:00:00-07:00'), 'America/Los_Angeles'), false);
  });

  test('equivalent coverage passes when 3X requirement is met', () => {
    const result = evaluateEquivalentInventoryCoverage({ quantity: 2 }, [{ quantity: 6 }]);
    assert.equal(result.meetsRequirement, true);
    assert.equal(result.requiredMinimum, 6);
  });

  test('equivalent coverage fails when below 3X threshold', () => {
    const result = evaluateEquivalentInventoryCoverage({ quantity: 2 }, [{ quantity: 5 }]);
    assert.equal(result.meetsRequirement, false);
    assert.equal(result.requiredMinimum, 6);
  });

  test('minimum quantity is preserved for target quantity under 3X rule', () => {
    const result = evaluateEquivalentInventoryCoverage({ quantity: 2 }, [{ quantity: 6 }]);
    assert.equal(result.targetQuantity, 2);
    assert.equal(result.equivalentInventoryCount, 6);
  });

  test('contiguous seat blocks stay in one row and do not overlap', () => {
    const inventory = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(seat => ({
      venueId: 'venue', eventId: 'event', section: 'Orchestra', row: 'A', seat,
      priceLevel: 'tier', seatQuality: 'standard', available: true
    }));
    const blocks = findContiguousSeatBlocks({
      venueId: 'venue', eventId: 'event', section: 'Orchestra', priceLevel: 'tier', seatQuality: 'standard', quantity: 2
    }, inventory);
    assert.deepEqual(blocks.map(block => block.seats.map(seat => seat.seat)), [['1', '2'], ['3', '4'], ['5', '6'], ['7', '8']]);
  });

  test('Segerstrom candidates require two same-or-forward-row buffer blocks', () => {
    const makeSeats = (row, start) => Array.from({ length: 6 }, (_, index) => ({
      venueId: 'segerstrom_center', eventId: 'event', section: 'Orchestra', row,
      seat: String(start + index), priceLevel: 'tier', seatQuality: 'standard', priceCents: 5000, available: true
    }));
    const inventory = [
      ...makeSeats('D', 1), ...makeSeats('D', 20),
      ...makeSeats('C', 1), ...makeSeats('E', 1)
    ];
    const candidates = findSegerstromBufferedCandidates(inventory, 6, [
      { section_name: 'orchestra', row_label: 'B', sort_order: 2 },
      { section_name: 'orchestra', row_label: 'C', sort_order: 3 },
      { section_name: 'orchestra', row_label: 'D', sort_order: 4 },
      { section_name: 'orchestra', row_label: 'E', sort_order: 5 }
    ]);
    const rowDTarget = candidates.find(candidate => candidate.row === 'D' && candidate.startSeat === '1');
    assert.ok(rowDTarget);
    assert.deepEqual(rowDTarget.bufferBlocks.map(block => block.row), ['D', 'C']);
    assert.equal(candidates.some(candidate => candidate.row === 'C' && candidate.bufferBlocks.some(block => block.row === 'D')), false);
    const oneBufferInventory = [
      ...makeSeats('D', 1), ...makeSeats('C', 1)
    ];
    const oneBufferCandidates = findSegerstromBufferedCandidates(oneBufferInventory, 6, [
      { section_name: 'orchestra', row_label: 'B', sort_order: 2 },
      { section_name: 'orchestra', row_label: 'C', sort_order: 3 },
      { section_name: 'orchestra', row_label: 'D', sort_order: 4 },
      { section_name: 'orchestra', row_label: 'E', sort_order: 5 }
    ], 1);
    assert.equal(oneBufferCandidates.length, 1);
    assert.equal(oneBufferCandidates[0].bufferBlocks.length, 1);

    const sameRowOnlyCandidates = findSegerstromBufferedCandidates([
      ...makeSeats('D', 1), ...makeSeats('D', 20)
    ], 6, [{ section_name: 'orchestra', row_label: 'D', sort_order: 4 }], 1);
    assert.equal(sameRowOnlyCandidates.length, 2);
    assert.deepEqual(sameRowOnlyCandidates[0].bufferBlocks[0].seats, ['20', '21', '22', '23', '24', '25']);
    assert.equal(isNotApplicableRowPolicy({
      seatPositionPolicy: 'not_applicable_row_forward_only', seatPositionZone: 'not_applicable'
    }), true);
    assert.equal(isNotApplicableRowPolicy({
      seatPositionPolicy: 'not_applicable_row_forward_only', seatPositionZone: 'center'
    }), false);
  });

  test('external numeric IDs discard only a decimal-zero suffix', () => {
    assert.equal(normalizeExternalId('31946.0'), '31946');
    assert.equal(normalizeExternalId('00123'), '00123');
    assert.equal(normalizeExternalId('section-A'), 'section-A');
  });

  test('discovery hall resolution prefers a performance-specific hall over a venue fallback', () => {
    assert.equal(resolveVenueHall(
      { venueName: 'Samueli Theater' },
      { facilitySettings: { facilityName: 'Segerstrom Hall' } }
    ), 'Samueli Theater');
    assert.equal(resolveVenueHall(
      {},
      { facilitySettings: { facilityName: 'Segerstrom Hall' } }
    ), 'Segerstrom Hall');
    assert.equal(resolveVenueHall({}, {}), null);
  });

  test('venue timezone inference uses the persisted venue timezone', () => {
    assert.equal(inferVenueTimeZone('Segerstrom Center', 'CA', 'America/Los_Angeles'), 'America/Los_Angeles');
  });

  test('inventory scan is selected at minute 9', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 9, 0));
    assert.equal(getScheduleModeForCronDate(date), 'inventory_scan');
  });

  test('drop watch is selected every five minutes', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 10, 0));
    assert.equal(getScheduleModeForCronDate(date), 'drop_watch');
  });

  test('price-bounded drop watch counts only seats at or below its cap', () => {
    const qualifying = filterInventoryForDropPriceRule([
      { priceCents: 16999 },
      { priceCents: 17000 },
      { priceCents: 17001 },
      { priceCents: null }
    ], 17000);
    assert.deepEqual(qualifying.map(item => item.priceCents), [16999, 17000]);
  });

  test('listing watcher is selected at minute 17', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 17, 0));
    assert.equal(getScheduleModeForCronDate(date), 'listing_watch');
  });

  test('discovery scan is selected at minute 3', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 3, 0));
    assert.equal(getScheduleModeForCronDate(date), 'discovery_scan');
  });

  test('monitoring-only mode blocks outbound Skybox approval requests', async () => {
    const request = new Request('https://example.com/webhook/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
      body: JSON.stringify({ skybox_listing_id: 'listing-123' }),
    });

    const response = await worker.fetch(request, { ALLOW_SKYBOX_LISTING: 'false', WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    const payload = await response.json();

    assert.equal(response.status, 202);
    assert.equal(payload.status, 'MONITOR_ONLY');
  });

  test('webhook validate rejects requests without a valid shared secret', async () => {
    const request = new Request('https://example.com/webhook/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skybox_listing_id: 'listing-123' }),
    });

    const response = await worker.fetch(request, { ALLOW_SKYBOX_LISTING: 'false', WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(response.status, 401);
  });

  test('webhook validate rejects requests with an incorrect shared secret', async () => {
    const request = new Request('https://example.com/webhook/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'wrong-secret' },
      body: JSON.stringify({ skybox_listing_id: 'listing-123' }),
    });

    const response = await worker.fetch(request, { ALLOW_SKYBOX_LISTING: 'false', WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(response.status, 401);
  });

  test('logs endpoint rejects requests without a valid shared secret', async () => {
    const request = new Request('https://example.com/logs/recent');
    const response = await worker.fetch(request, { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(response.status, 401);
  });

  test('the runtime venue adapter smoke matrix is monitoring-only', () => {
    assert.equal(isSmokeMatrixReady(TEST_ADAPTERS), true);
    assert.equal(buildVenueAdapterSmokeReport(TEST_ADAPTERS).every(entry => entry.monitoringOnly === true), true);
    assert.equal(buildVenueAdapterSmokeReport(TEST_ADAPTERS).every(entry => entry.outboundApprovalEnabled === false), true);
  });

  test('operational telemetry exposes a summary snapshot for each active venue', () => {
    const snapshot = buildOperationalTelemetrySnapshot(new Date('2026-08-03T15:00:00-07:00'), { ALLOW_SKYBOX_LISTING: 'false' }, TEST_ADAPTERS);
    assert.equal(snapshot.monitoringOnly, true);
    assert.equal(snapshot.activeVenueCount, 1);
    assert.equal(snapshot.venues.length, 1);
    assert.equal(snapshot.venues.every(entry => entry.reasonCode), true);
    assert.equal(snapshot.venues.some(entry => entry.venueId === 'segerstrom_center'), true);
    assert.equal(snapshot.venues.some(entry => entry.businessWindowOpen === true), true);
  });

  test('runtime configuration resolves credentials from Worker secrets without exposing their names', async () => {
    const fakeDb = { prepare: () => ({ all: async () => ({ results: [{
      venue_id: 'example', venue_name: 'Example', timezone_name: 'UTC', security_tier: 'low',
      config_json: JSON.stringify({ discoveryStrategy: 'singleStep', inventoryStrategy: 'singleStep', urlPattern: 'https://example.test' }),
      credential_refs_json: JSON.stringify({ apiKey: 'EXAMPLE_API_KEY' })
    }] }) }) };
    const adapters = await getActiveVenueAdapters(fakeDb, { EXAMPLE_API_KEY: 'not-disclosed' });
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].apiKey, 'not-disclosed');
    assert.equal('credential_refs_json' in adapters[0], false);
  });

  test('a valid monitoring signal generates a human-review notification payload', () => {
    const review = buildHumanReviewNotification({
      venueName: 'Segerstrom Center for the Arts',
      showName: 'Hamilton',
      eventId: 'evt-100',
      section: 'Orchestra',
      row: 'A',
      seat: '12',
      priceLevel: 'orch',
      seatQuality: 'premium',
      coverage: { targetQuantity: 2, equivalentInventoryCount: 6, requiredMinimum: 6, meetsRequirement: true }, // Mock coverage for the test
      businessWindowOpen: true,
      freshnessOk: true
    });

    assert.equal(review.action, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(review.details.includes('Hamilton'), true);
    assert.equal(review.details.includes('3X'), true);
  });

  test('Segerstrom inventory parser extracts a normalized seat snapshot from an API JSON payload', async () => {
    // This test now reflects that the parser expects a JSON string from the inventory API.
    const jsonPayload = JSON.stringify({
      seats: [{
        sectionGroupName: 'Orchestra',
        available: {
          'S_1-A-12': { row: 'A', num: '12', zone: 9050 }
        }
      }],
      prices: {
        '9050': 206.78
      }
    });

    const parsed = parseSegerstromInventoryDocument(jsonPayload, 'segerstrom_center');
    assert.equal(parsed.length, 1);
    const seat = parsed[0];

    assert.equal(seat.venueId, 'segerstrom_center');
    assert.equal(seat.section, 'Orchestra');
    assert.equal(seat.row, 'A');
    assert.equal(seat.seat, '12');
    assert.equal(seat.priceLevel, 9050);
    assert.equal(seat.priceCents, 20678);
    assert.equal(seat.available, true);
  });

  test('isSpecificSeatMatch requires section, row, seat, and availability to all agree', () => {
    const listing = { section: 'Orchestra', row: 'A', seat: '12' };
    assert.equal(isSpecificSeatMatch({ section: 'Orchestra', row: 'A', seat: '12', available: true }, listing), true);
    assert.equal(isSpecificSeatMatch({ section: 'Orchestra', row: 'A', seat: '12', available: false }, listing), false);
    assert.equal(isSpecificSeatMatch({ section: 'Balcony', row: 'A', seat: '12', available: true }, listing), false);
  });

  test('isPriceParityMatch passes only on an exact price_cents match', () => {
    const listing = { priceCents: 12500 };
    assert.equal(isPriceParityMatch({ priceCents: 12500 }, listing), true);
    assert.equal(isPriceParityMatch({ priceCents: 12501 }, listing), false);
  });

  test('isPriceParityMatch fails closed when either side is missing a price', () => {
    assert.equal(isPriceParityMatch({ priceCents: 12500 }, {}), false);
    assert.equal(isPriceParityMatch({}, { priceCents: 12500 }), false);
  });

  test('isBlockLikeStatus recognizes blocking/rate-limit responses only', () => {
    assert.equal(isBlockLikeStatus(403), true);
    assert.equal(isBlockLikeStatus(429), true);
    assert.equal(isBlockLikeStatus(503), true);
    assert.equal(isBlockLikeStatus(200), false);
    assert.equal(isBlockLikeStatus(404), false);
  });

  test('computeBackoffDelayMs grows with consecutive blocks and is capped', () => {
    const policy = { baseIntervalMs: 120000, maxIntervalMs: 600000 };
    const firstDelay = computeBackoffDelayMs(1, policy);
    const secondDelay = computeBackoffDelayMs(2, policy);
    assert.ok(secondDelay > firstDelay);
    assert.ok(computeBackoffDelayMs(20, policy) <= policy.maxIntervalMs * 6);
  });

  test('scan queries only bind the active venue set, excluding disallowed venues', async () => {
    const capturedBinds = [];
    const fakeDb = {
      prepare(sql) {
        return {
          bind(...args) {
            capturedBinds.push(args);
            return { first: async () => null };
          },
        };
      },
    };

    await getNextUpcomingEvent(fakeDb, ['segerstrom_center']);
    await getNextEventWithActiveListing(fakeDb, ['segerstrom_center']);
    await getListingForValidation(fakeDb, 'listing-123', ['segerstrom_center']);

    for (const bind of capturedBinds) {
      assert.equal(bind.includes('grand_ole_opry'), false);
      assert.equal(bind.includes('broadway_com'), false);
      assert.equal(bind.includes('broadwaydirect_com'), false);
    }
    assert.deepEqual(capturedBinds[0], ['segerstrom_center']);
  });

  test('scan queries return null instead of querying when no active venues are supplied', async () => {
    let prepareCalled = false;
    const fakeDb = { prepare() { prepareCalled = true; } };

    const result = await getNextUpcomingEvent(fakeDb, []);
    assert.equal(result, null);
    assert.equal(prepareCalled, false);
  });

  test('getNextEventWithActiveListing selects the specific listing seat/price fields alongside the event', async () => {
    let capturedSql = '';
    const fakeDb = {
      prepare(sql) {
        capturedSql = sql;
        return { bind: () => ({ first: async () => null }) };
      },
    };

    await getNextEventWithActiveListing(fakeDb, ['segerstrom_center']);

    assert.ok(capturedSql.includes('l.price_cents'));
    assert.ok(capturedSql.includes('l.section_label'));
    assert.ok(capturedSql.includes('l.row_label'));
    assert.ok(capturedSql.includes('l.seat_label'));
    assert.ok(capturedSql.includes("current_state = 'ACTIVE'"));
  });

  test('Segerstrom drill-down strategy executes the full API-driven workflow', async () => {
    const targetRow = {
      venue_id: 'segerstrom_center',
      event_url: 'https://seatme.scfta.org/single?id=30589',
    };

    const mockAdapter = {
      performanceIdParam: 'id',
      settingsApiUrlPattern: 'https://seatme.scfta.org/api/settings/performance/{performanceId}',
      priceApiUrlPattern: 'https://seatme.scfta.org/api/pricing/performance/{performanceId}',
      inventoryApiUrlPattern: 'https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}',
      seatInfoApiUrlPattern: 'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId={groupId}&performanceId={performanceId}',
    };

    const mockApiResponses = {
      'https://seatme.scfta.org/api/settings/performance/30589': { facilitySettings: { sectionGroupings: [{ sectionGroupId: '1', description: 'Orchestra' }] } },
      'https://seatme.scfta.org/api/pricing/performance/30589': [{ zoneId: 9050, prices: [{ price: 206.78 }] }],
      'https://seatme.scfta.org/api/sectionAvailability/performance/30589': [{ sectionGroupId: '1', sectionGroupName: 'Orchestra' }],
      'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId=1&performanceId=30589': {
        available: { 'S_1-M-3': { no: 7027, sec: 1, row: 'M', num: '3', zone: 9050 } }
      },
    };

    const apiRequests = [];
    const fakeExecuteSecureFetch = async (_env, url, _targetRow, options) => {
      apiRequests.push({ url, options });
      return { text: JSON.stringify(mockApiResponses[url] || {}), status: 200 };
    };

    const result = await segerstromDrillDownStrategy(targetRow, '', {}, {}, fakeExecuteSecureFetch, () => {}, mockAdapter);

    assert.equal(result.length, 1);
    const seat = result[0];
    assert.equal(seat.eventId, '30589');
    assert.equal(seat.section, 'Orchestra');
    assert.equal(seat.row, 'M');
    assert.equal(seat.seat, '3');
    assert.equal(seat.priceLevel, 9050);
    assert.equal(seat.priceCents, 20678);
    assert.equal(seat.available, true);
    assert.equal(apiRequests.length, 4);
    assert.equal(apiRequests.every(({ options }) => options.apiRequest === true), true);
  });

  test('discovery persistence uses the schema column names and deterministic show IDs', async () => {
    const statements = [];
    const fakeDb = {
      prepare(sql) {
        return { bind: (...values) => ({ sql, values, all: async () => ({ results: [] }) }) };
      },
      batch: async batch => {
        statements.push(...batch);
        return batch.map(() => ({ changes: 1 }));
      }
    };
    const result = await upsertDiscoveredEvents(fakeDb, [{
      showName: 'Example Show', venueId: 'segerstrom_center', eventId: 'event-1',
      showtime: '2026-12-01T20:00:00Z', eventDetailUrl: 'https://example.test/event-1'
    }]);
    assert.equal(result.inserted, 1);
    assert.match(statements[0].sql, /shows \(id, venue_id, show_name\)/);
    assert.equal(statements[1].values[1], 'segerstrom_center:Example%20Show');
  });

  test('existing event IDs refresh changed showtime, hall, and event URL instead of silently skipping', async () => {
    const runs = [];
    const fakeDb = {
      prepare(sql) {
        if (sql.includes('FROM events WHERE id IN')) {
          return {
            bind: (...values) => ({
              all: async () => ({ results: [{ id: 'event-1', showtime: '2026-12-01T20:00:00Z', event_url: 'https://example.test/old-event-1', venue_hall: 'Main Hall' }] }),
              values,
            })
          };
        }
        return {
          bind: (...values) => {
            const statement = { sql, values };
            return {
              statement,
              async run() {
                runs.push(statement);
                return { changes: 1 };
              }
            };
          }
        };
      },
      batch: async batch => {
        runs.push(...batch.map(st => st.statement || st));
        return batch.map(() => ({ changes: 1 }));
      }
    };

    const result = await upsertDiscoveredEvents(fakeDb, [{
      showName: 'Example Show', venueId: 'segerstrom_center', eventId: 'event-1',
      showtime: '2026-12-02T20:00:00Z', eventDetailUrl: 'https://example.test/new-event-1', venueHall: 'Concert Hall'
    }]);

    assert.equal(result.inserted, 0);
    assert.equal(result.updated, 1);
    assert.ok(runs.some(entry => String(entry.sql || '').includes('UPDATE events SET')));
  });

  test('discovery registers a venue-scoped hall before linking a new event to it', async () => {
    const statements = [];
    const fakeDb = {
      prepare: sql => ({ bind: (...values) => ({
        sql,
        values,
        all: async () => ({ results: [] })
      }) }),
      batch: async batch => {
        statements.push(...batch);
        return batch.map(() => ({ changes: 1 }));
      }
    };
    await upsertDiscoveredEvents(fakeDb, [{
      showName: 'Example Show', venueId: 'segerstrom_center', eventId: 'hall-event',
      showtime: '2026-12-01T20:00:00Z', venueHall: 'Samueli Theater'
    }]);
    assert.ok(statements.some(statement => statement.sql.includes('INSERT OR IGNORE INTO venue_halls')));
    const eventInsert = statements.find(statement => statement.sql.includes('INSERT OR IGNORE INTO events'));
    assert.equal(eventInsert.values.at(-1), 'segerstrom_center:hall:samueli%20theater');
  });

  test('discovery upsert chunks large event existence lookups below D1 bind limits', async () => {
    const lookupBindCounts = [];
    const fakeDb = {
      prepare(sql) {
        if (sql.includes('FROM events WHERE id IN')) {
          return { bind: (...values) => ({
            all: async () => {
              lookupBindCounts.push(values.length);
              return { results: [] };
            }
          }) };
        }
        return { bind: (...values) => ({ sql, values }) };
      },
      batch: async statements => statements.map(() => ({ changes: 1 }))
    };
    const events = Array.from({ length: 151 }, (_, index) => ({
      showName: 'Example Show', venueId: 'segerstrom_center', eventId: `event-${index}`,
      showtime: '2026-12-01T20:00:00Z', eventDetailUrl: `https://example.test/event-${index}`
    }));
    const result = await upsertDiscoveredEvents(fakeDb, events);
    assert.equal(result.inserted, 151);
    assert.deepEqual(lookupBindCounts, [75, 75, 1]);
  });

  test('production discovery routes the SeatMe settings API through the API provider', async () => {
    let state = null;
    const fakeDb = {
      prepare(sql) {
        return {
          bind: (...values) => ({
            first: async () => sql.includes('SELECT value_string') && state ? { value_string: JSON.stringify(state) } : null,
            run: async () => {
              if (sql.includes('INSERT OR REPLACE INTO system_state')) state = JSON.parse(values[1]);
              return { changes: 1 };
            },
            all: async () => ({ results: [] }),
            sql,
            values
          })
        };
      },
      batch: async statements => statements.map(() => ({ changes: 1 }))
    };
    const settingsRequests = [];
    const adapter = {
      venueName: 'Segerstrom Center for the Arts', timezoneName: 'America/Los_Angeles', algoliaAppId: 'app', algoliaApiKey: 'key', algoliaIndexName: 'index',
      buyButtonApiUrl: 'https://www.scfta.org/BuyButton/ButtonById',
      settingsApiUrlPattern: 'https://seatme.scfta.org/api/settings/performance/{performanceId}',
      ticketingUrlTemplate: 'https://seatme.scfta.org/single?id={performanceId}'
    };
    const secureFetch = async (_env, url, _target, options) => {
      if (url.includes('ButtonById')) return { status: 200, routedVia: 'zenrows_api', text: JSON.stringify({ SubItems: [{ ItemId: 123, Status: 'OnSale', TicketCount: 1 }] }) };
      settingsRequests.push({ url, options });
      return { status: 200, routedVia: 'zenrows_api', text: JSON.stringify({ additionalPerformances: [{ performanceId: 123, performanceDate: '2026-12-01T20:00:00Z', description: 'Example Show' }] }) };
    };
    const apiFetch = async () => ({ status: 200, text: JSON.stringify({ hits: [{ TessituraId: 456, Title: 'Example Show' }], nbPages: 1 }) });
    const RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate {
      constructor(value) {
        super(value === undefined ? '2026-08-03T13:00:00-07:00' : value);
      }
      static now() { return new RealDate('2026-08-03T13:00:00-07:00').getTime(); }
    };
    try {
      await segerstromProductionDiscoveryStrategy({ venue_id: 'segerstrom_center' }, '', { DB: fakeDb }, {}, secureFetch, () => {}, adapter, apiFetch);
    } finally {
      globalThis.Date = RealDate;
    }
    assert.equal(settingsRequests.length, 1);
    assert.equal(settingsRequests[0].options.apiRequest, true);
  });

  test('targets endpoint requires authentication and does not disclose adapter secrets', async () => {
    const denied = await worker.fetch(new Request('https://example.com/targets'), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(denied.status, 401);

    const fakeDb = { prepare: () => ({ all: async () => ({ results: [{
      venue_id: 'example', venue_name: 'Example', timezone_name: 'UTC', security_tier: 'low',
      config_json: JSON.stringify({ discoveryStrategy: 'singleStep', inventoryStrategy: 'singleStep', urlPattern: 'https://example.test' }),
      credential_refs_json: JSON.stringify({ apiKey: 'EXAMPLE_API_KEY' })
    }] }) }) };
    const allowed = await worker.fetch(new Request('https://example.com/targets', { headers: { 'X-Webhook-Secret': WEBHOOK_SECRET } }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET, EXAMPLE_API_KEY: 'not-disclosed', DB: fakeDb }, {});
    const payload = await allowed.json();
    assert.equal(allowed.status, 200);
    assert.equal('algoliaApiKey' in payload.venue_adapters[0], false);
  });

  test('exact inventory test endpoint requires authentication, an event ID, and a valid quantity', async () => {
    const denied = await worker.fetch(new Request('https://example.com/inventory/test', { method: 'POST', body: '{}' }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(denied.status, 401);

    const missingEventId = await worker.fetch(new Request('https://example.com/inventory/test', {
      method: 'POST',
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
      body: '{}'
    }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(missingEventId.status, 400);

    const invalidQuantity = await worker.fetch(new Request('https://example.com/inventory/test', {
      method: 'POST',
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
      body: '{"event_id":"30584","quantity":0}'
    }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(invalidQuantity.status, 400);
  });

  test('automated approval requires two explicit production controls', () => {
    assert.equal(isSkyboxListingEnabled({ ALLOW_SKYBOX_LISTING: 'true' }), false);
    assert.equal(isSkyboxListingEnabled({ ALLOW_SKYBOX_LISTING: 'true', ENABLE_AUTOMATED_APPROVAL: 'true' }), true);
  });


};

run();
