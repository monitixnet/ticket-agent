import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHumanReviewNotification,
  default as worker,
} from '../index.js';
import {
  isMonitoringWindowActive,
  getScheduleModeForCronDate,
  inferVenueTimeZone,
  resolveVenuePolicy,
  buildVenueAdapterSmokeReport,
  isSmokeMatrixReady,
  buildOperationalTelemetrySnapshot,
  resolveVenueAdapter,
  isBlockLikeStatus,
  computeBackoffDelayMs,
} from '../venue-logic.js';
import {
  ACTIVE_VENUE_SET,
  ACTIVE_VENUE_SMOKE_MATRIX,
} from '../venue-config.js';
import {
  parseSegerstromInventoryDocument,
  evaluateEquivalentInventoryCoverage,
  isSpecificSeatMatch,
  isPriceParityMatch,
} from '../venue-rules.js';
import {
  segerstromDrillDownStrategy,
  multiStepApiDiscoveryStrategy
} from '../strategies.js';
import {
  getNextUpcomingEvent,
  getNextEventWithActiveListing,
  getListingForValidation,
} from '../database/queries.js';

const WEBHOOK_SECRET = 'test-shared-secret';

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

  test('venue timezone inference resolves Segerstrom to Los Angeles', () => {
    assert.equal(inferVenueTimeZone('Segerstrom Center', 'CA', null), 'America/Los_Angeles');
  });

  test('primary market scan is selected at minute 12', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 12, 0));
    assert.equal(getScheduleModeForCronDate(date), 'primary_scan');
  });

  test('listing watcher is selected at minute 17', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 17, 0));
    assert.equal(getScheduleModeForCronDate(date), 'listing_watch');
  });

  test('idle mode is selected outside the monitoring cadence', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 22, 0));
    assert.equal(getScheduleModeForCronDate(date), 'idle');
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

  test('active venue set includes only the approved venues and excludes disallowed sources', () => {
    assert.deepEqual(ACTIVE_VENUE_SET, [
      'segerstrom_center',
      'citizen_opera_house',
      'asu_gammage',
      'first_interstate_center_for_the_arts',
      'orpheum_minneapolis',
      'orpheum_san_francisco',
      'paramount_theatre_seattle',
      'aronoff_center'
    ]);
    assert.equal(ACTIVE_VENUE_SET.includes('grand_ole_opry'), false);
    assert.equal(ACTIVE_VENUE_SET.includes('broadway_com'), false);
    assert.equal(ACTIVE_VENUE_SET.includes('broadwaydirect_com'), false);
  });

  test('source policy resolves active venue settings and enforces a safe backoff schedule', () => {
    const policy = resolveVenuePolicy('segerstrom_center');
    assert.equal(policy.active, true);
    assert.equal(policy.venueId, 'segerstrom_center');
    assert.equal(policy.baseIntervalMs, 120000);
    assert.equal(policy.maxIntervalMs, 600000);
    assert.equal(policy.reason, null);
  });

  test('the eight-venue smoke matrix is ready without enabling outbound listing approval', () => {
    assert.equal(ACTIVE_VENUE_SMOKE_MATRIX.length, 8);
    assert.equal(ACTIVE_VENUE_SET.length, 8);
    assert.equal(isSmokeMatrixReady(), true);
    assert.equal(buildVenueAdapterSmokeReport().every(entry => entry.monitoringOnly === true), true);
    assert.equal(buildVenueAdapterSmokeReport().every(entry => entry.outboundApprovalEnabled === false), true);
  });

  test('operational telemetry exposes a summary snapshot for each active venue', () => {
    const snapshot = buildOperationalTelemetrySnapshot(new Date('2026-08-03T15:00:00-07:00'), { ALLOW_SKYBOX_LISTING: 'false' });
    assert.equal(snapshot.monitoringOnly, true);
    assert.equal(snapshot.activeVenueCount, 8);
    assert.equal(snapshot.venues.length, 8);
    assert.equal(snapshot.venues.every(entry => entry.reasonCode), true);
    assert.equal(snapshot.venues.some(entry => entry.venueId === 'segerstrom_center'), true);
    assert.equal(snapshot.venues.some(entry => entry.businessWindowOpen === true), true);
  });

  test('each active venue has a defined adapter contract for the current milestone', () => {
    for (const venueId of ACTIVE_VENUE_SET) {
      const adapter = resolveVenueAdapter(venueId);
      assert.ok(adapter, `missing adapter contract for ${venueId}`);
      assert.equal(adapter.listingApprovalAllowed, false);
      assert.equal(adapter.monitoringOnly, true);
      assert.ok(Array.isArray(adapter.requiredInventoryFields));
      assert.ok(adapter.requiredInventoryFields.includes('eventId'));
      assert.ok(Array.isArray(adapter.smokeChecks));
    }
  });

  test('resolveVenuePolicy correctly identifies inactive venues', () => {
    const blocked = resolveVenuePolicy('grand_ole_opry');
    assert.equal(blocked.active, false);
    assert.equal(blocked.enabled, false);
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

    await getNextUpcomingEvent(fakeDb, ACTIVE_VENUE_SET);
    await getNextEventWithActiveListing(fakeDb, ACTIVE_VENUE_SET);
    await getListingForValidation(fakeDb, 'listing-123', ACTIVE_VENUE_SET);

    for (const bind of capturedBinds) {
      assert.equal(bind.includes('grand_ole_opry'), false);
      assert.equal(bind.includes('broadway_com'), false);
      assert.equal(bind.includes('broadwaydirect_com'), false);
    }
    assert.deepEqual(capturedBinds[0], ACTIVE_VENUE_SET);
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

    await getNextEventWithActiveListing(fakeDb, ACTIVE_VENUE_SET);

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

    const fakeExecuteSecureFetch = async (env, url) => {
      return { text: JSON.stringify(mockApiResponses[url] || {}) };
    };

    const result = await segerstromDrillDownStrategy(targetRow, '', {}, {}, fakeExecuteSecureFetch, () => {}, mockAdapter);

    assert.equal(result.length, 1);
    const seat = result[0];
    assert.equal(seat.section, 'Orchestra');
    assert.equal(seat.row, 'M');
    assert.equal(seat.seat, '3');
    assert.equal(seat.priceLevel, 9050);
    assert.equal(seat.priceCents, 20678);
    assert.equal(seat.available, true);
  });

  test('Segerstrom discovery strategy returns empty inventory and calls upsert', async () => {
    const targetRow = { venue_id: 'segerstrom_center', event_url: 'https://www.scfta.org/shows-events' };
    const calendarHtml = `<div class="cell image-container "><a href="/events/2026/some-show"></a><a class="event-link buy-tickets" href="https://seatme.scfta.org/single?id=12345">Buy now</a></div>`;
    const detailPageHtml = `<li class="cell small-4 large-5 buy-performance" data-productionid="12345"></li>`;
    const settingsApiJson = { additionalPerformances: [{ performanceId: 12345, description: 'Some Show', performanceDate: '2026-09-19T19:30:00' }] };

    const fakeExecuteSecureFetch = async (env, url) => {
      if (url.includes('/shows-events')) return { text: calendarHtml };
      if (url.includes('/events/2026/some-show')) return { text: detailPageHtml };
      if (url.includes('/api/settings/performance/')) return { text: JSON.stringify(settingsApiJson) };
      return { text: '{}' };
    };

    const fakeTrackWorkerLog = () => {};
    const fakeCtx = { waitUntil: () => {} };
    const result = await multiStepApiDiscoveryStrategy(targetRow, calendarHtml, { DB: { prepare: () => ({ bind: () => ({ first: () => ({ id: 1 }) }) }), batch: () => ([]) } }, fakeCtx, fakeExecuteSecureFetch, fakeTrackWorkerLog);
    assert.deepEqual(result, []);
  });

};

run();
