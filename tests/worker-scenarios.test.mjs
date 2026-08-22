import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHumanReviewNotification,
  buildNotificationRequest,
  buildDropAlertMessage,
  buildCandidateAlertMessage,
  buildStaleDropWatchAlertMessage,
  formatAlertDateTime,
  formatAvailabilityPriority,
  filterInventoryForDropPriceRule,
  isSubrequestBudgetExhaustion,
  buildServerIssuedCookieHeader,
  normalizeDropPriceCapCents,
  runScheduledCycle,
  default as worker,
} from '../index.js';
import { calculateCandidateCheckoutAmounts } from '../checkout-fees.js';
import { mergeCookieHeaders, isSessionRedirectResponse } from '../session-manager.js';
import {
  isMonitoringWindowActive,
  formatVenueLocalTime,
  getScheduleModeForCronDate,
  inferVenueTimeZone,
  buildVenueAdapterSmokeReport,
  isSmokeMatrixReady,
  buildOperationalTelemetrySnapshot,
  isBlockLikeStatus,
  computeBackoffDelayMs,
  isSkyboxListingEnabled,
  isVenueValidationResponse,
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
  segerstromSingleProductionDiscovery,
  buildAvailabilityFingerprint,
  resolveCalendarVenueHall,
  resolveVenueHall,
  classifyDiscoveryOutcome,
  getCurrentSoldOutPerformances,
  getDiscoveryRecheckMs,
  formatJobDuration,
  isProductionDueForDiscovery
} from '../strategies.js';
import {
  getNextUpcomingEvent,
  getNextEventWithActiveListing,
  getListingForValidation,
  upsertDiscoveredEvents,
  markDiscoveredSoldOutEvents,
  getHallInventoryPolicy,
  getDueDropWatchEvents,
  getStaleCriticalDropWatchEvents,
  getPendingInventoryDropAlerts,
  recordInventoryAvailabilityObservation,
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

  test('SeatMe validation HTML is classified even when upstream returns HTTP 200', () => {
    assert.equal(isVenueValidationResponse({
      status: 200,
      text: 'User validation required to continue. Validation needed due to the detection of invalid input from this client IP address, error code : 421'
    }), true);
    assert.equal(isVenueValidationResponse({ status: 200, text: '[{"sectionGroupId":"1"}]' }), false);
    assert.equal(isVenueValidationResponse({ status: 200, text: '<html>ordinary maintenance page</html>' }), false);
  });

  test('same-invocation session smoke builds a cookie header only from server-issued cookie pairs', () => {
    assert.equal(buildServerIssuedCookieHeader([
      'TrueTickets_Session=abc; Path=/; HttpOnly',
      'sessid=xyz; Secure',
      'malformed-cookie'
    ]), 'TrueTickets_Session=abc; sessid=xyz');
  });

  test('venue session merges refreshed cookies and recognizes SeatMe redirect masks', () => {
    assert.equal(mergeCookieHeaders('sessid=old; alpha=1', 'sessid=new; beta=2'), 'sessid=new; alpha=1; beta=2');
    assert.equal(isSessionRedirectResponse({ status: 303, text: '{}' }), true);
    assert.equal(isSessionRedirectResponse({ status: 200, text: '{"redirectMask":"https://example.test"}' }), true);
    assert.equal(isSessionRedirectResponse({ status: 200, text: '[]' }), false);
  });

  test('business window is closed before 7:30 AM local venue time', () => {
    assert.equal(isMonitoringWindowActive(new Date('2026-08-03T06:00:00-07:00'), 'America/Los_Angeles'), false);
  });

  test('curfew audit time is rendered in the venue timezone, not UTC', () => {
    assert.equal(formatVenueLocalTime(new Date('2026-08-03T14:05:00Z'), 'America/Los_Angeles'), '2026-08-03 07:05:00');
  });

  test('current sold-out performances are monitored even when a production also contains past performances', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const outcome = classifyDiscoveryOutcome({
      Status: 'NotOnSale',
      MaxDate: '2026-08-30T01:00:00Z',
      SubItems: [
        { Status: 'PastSale', Ticks: now.getTime() - 60_000 },
        { Status: 'SoldOut', Ticks: now.getTime() + 60_000 },
      ]
    }, new Set(), now);
    assert.equal(outcome, 'sold_out');
  });

  test('recorded exclusions are not due again, while scheduled and malformed records are handled safely', () => {
    const production = { id: 'excluded-production' };
    const nowMs = Date.parse('2026-08-19T12:00:00.000Z');
    assert.equal(isProductionDueForDiscovery(production, {
      'excluded-production': { outcome: 'past', nextCheckAt: null }
    }, nowMs), false);
    assert.equal(isProductionDueForDiscovery(production, {
      'excluded-production': { outcome: 'sold_out', nextCheckAt: '2026-08-19T11:59:59.000Z' }
    }, nowMs), true);
    assert.equal(isProductionDueForDiscovery(production, {
      'excluded-production': { outcome: 'unknown', nextCheckAt: 'not-a-date' }
    }, nowMs), true);
  });

  test('venue-configured on-sale discovery recheck interval is 60 minutes', () => {
    assert.equal(getDiscoveryRecheckMs({ discoveryRecheckMinutes: { on_sale: 60 } }, 'on_sale'), 60 * 60 * 1000);
    assert.equal(getDiscoveryRecheckMs({}, 'sold_out'), 60 * 60 * 1000);
  });

  test('drop watch uses venue-scoped intervals and capacity-aware priority bands', async () => {
    let capturedSql = '';
    let capturedValues = [];
    const fakeDb = {
      prepare(sql) {
        capturedSql = sql;
        return {
          bind: (...values) => {
            capturedValues = values;
            return { all: async () => ({ results: [] }) };
          }
        };
      }
    };
    await getDueDropWatchEvents(fakeDb, 'segerstrom_center', 20, {
      critical: 5, high: 10, medium: 30, low: 10080
    }, {
      enabled: true, criticalMaxAvailableBasisPoints: 1000, lowMinAvailableBasisPoints: 8000
    });
    assert.match(capturedSql, /wr\.venue_id = v\.id/);
    assert.match(capturedSql, /eis\.available_percentage_basis_points <= \?/);
    assert.match(capturedSql, /eis\.available_percentage_basis_points >= \?/);
    assert.match(capturedSql, /e\.discovery_outcome = 'sold_out' OR wr\.id IS NOT NULL/);
    assert.match(capturedSql, /WHEN 'critical' THEN 0/);
    assert.equal(capturedValues.includes('segerstrom_center'), true);
    assert.equal(capturedValues.includes(10080), true);
  });

  test('successful inventory observations synchronize the latest eligibility outcome', async () => {
    const statements = [];
    const fakeDb = {
      prepare(sql) {
        return {
          bind: (...values) => {
            statements.push({ sql, values });
            return {};
          }
        };
      },
      batch: async () => [{ meta: { changes: 0 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]
    };
    const result = await recordInventoryAvailabilityObservation(fakeDb, {
      eventId: 'phantom-event', scanId: 'scan-1', observedAt: '2026-08-22T16:00:00.000Z',
      availableItemCount: 50, capacitySeatCount: 500
    });
    const outcomeUpdate = statements.find(statement => statement.sql.includes('UPDATE events SET discovery_outcome'));
    const stateUpsert = statements.find(statement => statement.sql.includes('INSERT INTO event_inventory_state'));
    assert.deepEqual(outcomeUpdate?.values, ['on_sale', '2026-08-22T16:00:00.000Z', 'phantom-event']);
    assert.equal(stateUpsert?.values.at(-3), 500);
    assert.equal(stateUpsert?.values.at(-2), 1000);
    assert.equal(result.discoveryOutcome, 'on_sale');
    assert.equal(result.availablePercentageBasisPoints, 1000);
  });

  test('critical drop-watch health audit checks only explicitly configured critical rules', async () => {
    let capturedSql = '';
    let capturedValues = [];
    const fakeDb = { prepare(sql) {
      capturedSql = sql;
      return { bind: (...values) => {
        capturedValues = values;
        return { all: async () => ({ results: [] }) };
      } };
    } };
    await getStaleCriticalDropWatchEvents(fakeDb, 'segerstrom_center', 10);
    assert.match(capturedSql, /wr\.priority = 'critical'/);
    assert.match(capturedSql, /wr\.enabled = 1/);
    assert.match(capturedSql, /datetime\(eis\.last_observed_at, '\+' \|\| \? \|\| ' minutes'\)/);
    assert.deepEqual(capturedValues, ['segerstrom_center', 10]);
  });

  test('job runtime timers render comparable elapsed durations', () => {
    assert.equal(formatJobDuration(321), '0s');
    assert.equal(formatJobDuration(65_000), '1m 5s');
  });

  test('only future sold-out performances are enrolled for drop monitoring', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const performances = getCurrentSoldOutPerformances({ SubItems: [
      { ItemId: 1, Status: 'SoldOut', Ticks: now.getTime() - 1 },
      { ItemId: 2, Status: 'SoldOut', Ticks: now.getTime() + 1 },
      { ItemId: 3, Status: 'PastSale', Ticks: now.getTime() + 1 },
      { ItemId: 4, Status: 'SoldOut' }
    ] }, now);
    assert.deepEqual(performances.map(item => item.ItemId), [2]);
  });

  test('discovery can seed sold-out events into the existing drop-watch state machine', async () => {
    const statements = [];
    const fakeDb = {
      prepare: sql => ({ bind: (...values) => ({ sql, values }) }),
      batch: async batch => { statements.push(...batch); return batch.map(() => ({ changes: 1 })); }
    };
    const enrolled = await markDiscoveredSoldOutEvents(fakeDb, ['performance-1', 'performance-1', 'performance-2'], '2026-08-19T12:00:00.000Z');
    assert.equal(enrolled, 2);
    assert.equal(statements.length, 2);
    assert.ok(statements.every(statement => statement.sql.includes("VALUES (?, 'sold_out', 0")));
    assert.ok(statements.every(statement => statement.sql.includes('ON CONFLICT(event_id) DO NOTHING')));
    assert.ok(statements.every(statement => statement.values.includes('2026-08-19T12:00:00.000Z')));
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

  test('hall inventory policy accepts SQLite JSON true represented as 1', async () => {
    const fakeDb = {
      prepare: () => ({ bind: () => ({ first: async () => ({ metadata_json: '{"inventory_enabled":1}' }) }) })
    };
    const policy = await getHallInventoryPolicy(fakeDb, 'segerstrom-hall');
    assert.equal(policy.inventoryEnabled, true);
  });

  test('external numeric IDs discard only a decimal-zero suffix', () => {
    assert.equal(normalizeExternalId('31946.0'), '31946');
    assert.equal(normalizeExternalId('00123'), '00123');
    assert.equal(normalizeExternalId('section-A'), 'section-A');
  });

  test('discovery hall resolution prefers a performance-specific hall over a venue fallback', () => {
    assert.equal(resolveVenueHall(
      { hallName: 'Samueli Theater' },
      { facilitySettings: { facilityName: 'Segerstrom Hall' } }
    ), 'Samueli Theater');
    assert.equal(resolveVenueHall(
      {},
      { facilitySettings: { facilityName: 'Segerstrom Hall' } }
    ), 'Segerstrom Hall');
    assert.equal(resolveVenueHall({ facility: { name: 'Segerstrom Hall' } }, {}), 'Segerstrom Hall');
    assert.equal(resolveVenueHall({ venueName: 'Segerstrom Center for the Arts' }, {}), null);
    assert.equal(resolveVenueHall({}, {}), null);
  });

  test('Segerstrom calendar hall resolution uses only the calendar Venue array', () => {
    assert.equal(resolveCalendarVenueHall({ Venue: ['Samueli Theater'] }), 'Samueli Theater');
    assert.equal(resolveCalendarVenueHall({ Venue: ['  Segerstrom Hall  ', 'Ignored'] }), 'Segerstrom Hall');
    assert.equal(resolveCalendarVenueHall({ venue: 'Segerstrom Hall' }), null);
    assert.equal(resolveCalendarVenueHall({}), null);
  });

  test('venue timezone inference uses the persisted venue timezone', () => {
    assert.equal(inferVenueTimeZone('Segerstrom Center', 'CA', 'America/Los_Angeles'), 'America/Los_Angeles');
  });

  test('inventory scan is selected at minute 7', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 7, 0));
    assert.equal(getScheduleModeForCronDate(date), 'inventory_scan');
  });

  test('inventory scan is selected at minute 17 under the accelerated cadence', () => {
    assert.equal(getScheduleModeForCronDate(new Date('2026-08-19T12:17:00.000Z')), 'inventory_scan');
  });

  test('curfew-blocked inventory scheduler starts no job, lease, cleanup, fetch, or notification work', async () => {
    const sqlCalls = [];
    const configRow = {
      venue_id: 'segerstrom_center', venue_name: 'Segerstrom Center for the Arts',
      timezone_name: 'America/Los_Angeles', security_tier: 'high', credential_refs_json: '{}',
      config_json: JSON.stringify({
        discoveryStrategy: 'segerstromProductionDiscovery', inventoryStrategy: 'segerstromDrillDown',
        urlPattern: 'https://www.scfta.org/shows-events',
        businessHours: { start: { hour: 7, minute: 30 }, end: { hour: 23, minute: 59 } }
      })
    };
    const fakeDb = {
      prepare(sql) {
        sqlCalls.push(sql);
        return {
          bind: () => ({
            first: async () => sql.includes('FROM venues v JOIN venue_runtime_configs') ? configRow : null,
            run: async () => ({ success: true })
          })
        };
      }
    };
    const waits = [];
    await runScheduledCycle({ DB: fakeDb, WORKER_VENUE_ID: 'segerstrom_center' }, {
      waitUntil: promise => waits.push(promise)
    }, {
      forcedMode: 'inventory_scan', now: new Date('2026-08-03T06:00:00-07:00')
    });
    await Promise.all(waits);
    assert.ok(sqlCalls.some(sql => sql.includes('INSERT INTO worker_logs')));
    assert.equal(sqlCalls.some(sql => /inventory_jobs|cleanup|events WHERE|DELETE FROM/i.test(sql)), false);
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

  test('unbounded drop watch accepts every available inventory item regardless of price', () => {
    const inventory = [
      { priceCents: 16999 },
      { priceCents: 17000 },
      { priceCents: 17001 },
      { priceCents: null }
    ];
    assert.deepEqual(filterInventoryForDropPriceRule(inventory, null), inventory);
  });

  test('an unbounded D1 drop-price rule remains unbounded in the scan path', () => {
    assert.equal(normalizeDropPriceCapCents(null), null);
    assert.equal(normalizeDropPriceCapCents(''), null);
    assert.equal(normalizeDropPriceCapCents(17000), 17000);
  });

  test('the shared request cap is a resumable boundary rather than a SeatMe error', () => {
    assert.equal(isSubrequestBudgetExhaustion({ code: 'SUBREQUEST_BUDGET_EXHAUSTED' }), true);
    assert.equal(isSubrequestBudgetExhaustion(new Error('External subrequest budget exhausted before GET')), true);
    assert.equal(isSubrequestBudgetExhaustion(new Error('section_availability returned redirect HTTP 303')), false);
  });

  test('Telegram notifications use Telegram chat_id and text fields', () => {
    const request = buildNotificationRequest(
      'https://api.telegram.org/botREDACTED/sendMessage?chat_id=-123&text=',
      'Drop detected'
    );
    assert.equal(request.url, 'https://api.telegram.org/botREDACTED/sendMessage');
    assert.deepEqual(JSON.parse(request.body), { chat_id: '-123', text: 'Drop detected' });
  });

  test('drop alerts contain decision-ready venue, ticket, pricing, and seat details', () => {
    const message = buildDropAlertMessage({
      venueName: 'Segerstrom Center for the Arts', venueHall: 'Segerstrom Hall',
      showName: 'Phantom of the Opera', showtime: '2026-08-20 19:30:00', eventId: '30586',
      eventUrl: 'https://seatme.scfta.org/single?id=30586', availableItemCount: 8,
      maxPriceCents: 17000, lowestQualifyingPriceCents: 12500, highestQualifyingPriceCents: 17000,
      sectionSummaries: [{ section: 'Orchestra', availableSeats: 8 }],
      eligibleSeatSamples: [{ section: 'Orchestra', row: 'D', seat: '12', priceCents: 12500 }],
      eligibleCandidateBlocks: [{ targetQuantity: 2, section: 'Orchestra', row: 'D', startSeat: '12', endSeat: '13', priceCents: 12500 }],
      observedAt: '2026-08-20T12:00:00.000Z', timezoneName: 'America/Los_Angeles'
    });
    assert.match(message, /Hall: Segerstrom Hall/);
    assert.match(message, /Performance: Thursday, August 20, 2026 at 7:30 PM PDT/);
    assert.match(message, /Event ID: 30586/);
    assert.match(message, /\$125\.00–\$170\.00/);
    assert.match(message, /Row D, Seat 12/);
    assert.match(message, /Buy: https:\/\/seatme\.scfta\.org\/single\?id=30586/);
  });

  test('unbounded drop alerts describe the rule as any available price', () => {
    const message = buildDropAlertMessage({ maxPriceCents: null });
    assert.match(message, /Price rule: any available price/);
    assert.doesNotMatch(message, /\$0\.00 or less/);
  });

  test('candidate alerts show target blocks but do not disclose buffer blocks', () => {
    const message = buildCandidateAlertMessage({
      venueName: 'Segerstrom Center for the Arts', venueHall: 'Segerstrom Hall',
      showName: 'Example Show', showtime: '2026-09-01 19:30:00', eventUrl: 'https://seatme.example/event',
      observedAt: '2026-08-22T00:00:00.000Z', timezoneName: 'America/Los_Angeles',
      checkoutFeeRule: { type: 'percentage_per_ticket', rateBasisPoints: 1800 },
      availabilityPriority: 'CRITICAL — 92% SOLD OUT (8% available)',
      candidates: [{ targetQuantity: 2, section: 'Orchestra', row: 'D', startSeat: '10', endSeat: '11', priceCents: 12500, bufferBlocks: [{ row: 'C' }] }]
    });
    assert.match(message, /Qty 2: Orchestra, Row D, Seats 10–11 \(\$125\.00 \+ \$22\.50 fee = \$147\.50 each; \$295\.00 all-in total\)/);
    assert.match(message, /Priority: CRITICAL — 92% SOLD OUT \(8% available\)/);
    assert.doesNotMatch(message, /buffer|Row C/i);
  });

  test('capacity-aware priority labels critical scarce inventory without calling it a drop', () => {
    const adapter = {
      availabilityPriorityPolicy: {
        enabled: true, criticalMaxAvailableBasisPoints: 1000, lowMinAvailableBasisPoints: 8000
      }
    };
    assert.equal(
      formatAvailabilityPriority(adapter, { availablePercentageBasisPoints: 800 }),
      'CRITICAL — 92% SOLD OUT (8% available)'
    );
    assert.equal(formatAvailabilityPriority(adapter, { availablePercentageBasisPoints: 1001 }), null);
    assert.equal(formatAvailabilityPriority({}, { availablePercentageBasisPoints: 800 }), null);
  });

  test('critical drop-watch health alerts use readable venue-local times', () => {
    const message = buildStaleDropWatchAlertMessage({
      venueName: 'Segerstrom Center for the Arts', timezoneName: 'America/Los_Angeles'
    }, [{ show_name: 'Phantom of the Opera', last_observed_at: '2026-08-22T15:45:26.235Z' }],
    10, '2026-08-22T16:20:14.403Z');
    assert.match(message, /oldest scan Saturday, August 22, 2026 at 8:45 AM PDT/);
    assert.match(message, /Observed: Saturday, August 22, 2026 at 9:20 AM PDT/);
    assert.doesNotMatch(message, /2026-08-22T/);
  });

  test('alert times are readable in the venue timezone without shifting wall-clock D1 timestamps', () => {
    assert.equal(
      formatAlertDateTime('2026-12-10 19:00:00', 'America/Los_Angeles'),
      'Thursday, December 10, 2026 at 7:00 PM PST'
    );
    assert.equal(
      formatAlertDateTime('2026-08-22T02:30:00.000Z', 'America/Los_Angeles'),
      'Friday, August 21, 2026 at 7:30 PM PDT'
    );
  });

  test('Segerstrom checkout fee rule rounds 18 percent per ticket', () => {
    const first = calculateCandidateCheckoutAmounts(6271, 2, {
      type: 'percentage_per_ticket', rateBasisPoints: 1800
    });
    const second = calculateCandidateCheckoutAmounts(20678, 1, {
      type: 'percentage_per_ticket', rateBasisPoints: 1800
    });
    assert.deepEqual(first && {
      fee: first.feePerTicketCents, allIn: first.allInPerTicketCents, total: first.allInTotalCents
    }, { fee: 1129, allIn: 7400, total: 14800 });
    assert.deepEqual(second && {
      fee: second.feePerTicketCents, allIn: second.allInPerTicketCents, total: second.allInTotalCents
    }, { fee: 3722, allIn: 24400, total: 24400 });
  });

  test('durable alert selection parses ISO timestamps instead of comparing them as text', async () => {
    let capturedSql = '';
    const fakeDb = { prepare(sql) {
      capturedSql = sql;
      return { bind: () => ({ all: async () => ({ results: [] }) }) };
    } };
    await getPendingInventoryDropAlerts(fakeDb, 5);
    assert.match(capturedSql, /datetime\(next_attempt_at\) <= datetime\('now'\)/);
  });

  test('listing watcher is selected at minute 12', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 12, 0));
    assert.equal(getScheduleModeForCronDate(date), 'listing_watch');
  });

  test('discovery scan is selected at minute 3', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 3, 0));
    assert.equal(getScheduleModeForCronDate(date), 'discovery_scan');
  });

  test('discovery scan is not selected between hourly :03 runs', () => {
    const date = new Date(Date.UTC(2026, 7, 3, 0, 8, 0));
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
    const configRow = {
      venue_id: 'example', venue_name: 'Example', timezone_name: 'UTC', security_tier: 'low',
      config_json: JSON.stringify({ discoveryStrategy: 'singleStep', inventoryStrategy: 'singleStep', urlPattern: 'https://example.test' }),
      credential_refs_json: JSON.stringify({ apiKey: 'EXAMPLE_API_KEY' })
    };
    const fakeDb = {
      prepare: () => ({
        bind: () => ({ first: async () => configRow }),
        all: async () => ({ results: [configRow] })
      })
    };
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
      'https://seatme.scfta.org/api/pricing/performance/30589': [{ zoneId: 9050, prices: [{ price: 206.78 }] }],
      'https://seatme.scfta.org/api/sectionAvailability/performance/30589': [
        { sectionGroupId: '1', sectionGroupName: 'Orchestra', totalAvailableSeats: 1 },
        { sectionGroupId: '2', sectionGroupName: 'Balcony', totalAvailableSeats: 0 }
      ],
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
    assert.deepEqual(apiRequests.map(request => request.url), [
      'https://seatme.scfta.org/api/sectionAvailability/performance/30589',
      'https://seatme.scfta.org/api/pricing/performance/30589',
      'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId=1&performanceId=30589'
    ]);
    assert.equal(apiRequests.every(({ options }) => options.apiRequest === true), true);
    assert.equal(apiRequests.every(({ options }) => options.redirect === 'manual'), true);
    assert.deepEqual(apiRequests.map(({ options }) => options.inventoryEndpoint), [
      'section_availability', 'pricing', 'seat_info'
    ]);
  });

  test('Segerstrom drill-down reports a SeatMe redirect without parsing it as inventory JSON', async () => {
    const targetRow = { venue_id: 'segerstrom_center', event_url: 'https://seatme.scfta.org/single?id=30598' };
    const adapter = {
      performanceIdParam: 'id',
      inventoryApiUrlPattern: 'https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}'
    };
    await assert.rejects(
      segerstromDrillDownStrategy(targetRow, '', {}, {}, async () => ({
        status: 303,
        text: JSON.stringify({ redirectMask: 'https://www.scfta.org/cart/updatecart' })
      }), () => {}, adapter),
      /section_availability returned redirect HTTP 303/
    );
  });

  test('Segerstrom drill-down records a sold-out event from availability alone', async () => {
    const targetRow = { venue_id: 'segerstrom_center', event_url: 'https://seatme.scfta.org/single?id=30589' };
    const adapter = {
      performanceIdParam: 'id',
      settingsApiUrlPattern: 'https://seatme.scfta.org/api/settings/performance/{performanceId}',
      priceApiUrlPattern: 'https://seatme.scfta.org/api/pricing/performance/{performanceId}',
      inventoryApiUrlPattern: 'https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}',
      seatInfoApiUrlPattern: 'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId={groupId}&performanceId={performanceId}'
    };
    const apiRequests = [];
    const fetchAvailabilityOnly = async (_env, url) => {
      apiRequests.push(url);
      return { text: JSON.stringify([{ sectionGroupId: '1', sectionGroupName: 'Orchestra', totalAvailableSeats: 0 }]), status: 200 };
    };

    const result = await segerstromDrillDownStrategy(targetRow, '', {}, {}, fetchAvailabilityOnly, () => {}, adapter);

    assert.deepEqual(result, []);
    assert.deepEqual(apiRequests, ['https://seatme.scfta.org/api/sectionAvailability/performance/30589']);
  });

  test('Segerstrom inventory uses one availability request for an unchanged available performance', async () => {
    const targetRow = {
      venue_id: 'segerstrom_center',
      event_url: 'https://seatme.scfta.org/single?id=30589',
      event_id: '30589',
      inventory_availability_state: 'available'
    };
    const availability = [{
      sectionGroupId: '1', sectionGroupName: 'Orchestra', totalAvailableSeats: 12,
      sectionSeatSummaries: [{ sectionId: 1, zoneId: 9050, screenId: 1, availableCount: 12 }]
    }];
    targetRow.last_availability_fingerprint = buildAvailabilityFingerprint(availability);
    const adapter = {
      performanceIdParam: 'id',
      inventoryApiUrlPattern: 'https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}',
      priceApiUrlPattern: 'https://seatme.scfta.org/api/pricing/performance/{performanceId}',
      seatInfoApiUrlPattern: 'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId={groupId}&performanceId={performanceId}'
    };
    const apiRequests = [];
    const result = await segerstromDrillDownStrategy(targetRow, '', {}, {}, async (_env, url) => {
      apiRequests.push(url);
      return { text: JSON.stringify(availability), status: 200 };
    }, () => {}, adapter);

    assert.deepEqual(result, []);
    assert.equal(result.scanMetadata.availabilityOnly, true);
    assert.equal(result.scanMetadata.availabilityState, 'available');
    assert.equal(result.scanMetadata.availableItemCount, 12);
    assert.deepEqual(apiRequests, ['https://seatme.scfta.org/api/sectionAvailability/performance/30589']);
  });

  test('Segerstrom drill-down uses settings only when availability omits a section name', async () => {
    const targetRow = { venue_id: 'segerstrom_center', event_url: 'https://seatme.scfta.org/single?id=30589' };
    const adapter = {
      performanceIdParam: 'id',
      settingsApiUrlPattern: 'https://seatme.scfta.org/api/settings/performance/{performanceId}',
      priceApiUrlPattern: 'https://seatme.scfta.org/api/pricing/performance/{performanceId}',
      inventoryApiUrlPattern: 'https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}',
      seatInfoApiUrlPattern: 'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId={groupId}&performanceId={performanceId}'
    };
    const responses = {
      'https://seatme.scfta.org/api/sectionAvailability/performance/30589': [{ sectionGroupId: '1', totalAvailableSeats: 1 }],
      'https://seatme.scfta.org/api/settings/performance/30589': { facilitySettings: { sectionGroupings: [{ sectionGroupId: '1', description: 'Orchestra' }] } },
      'https://seatme.scfta.org/api/pricing/performance/30589': [{ zoneId: 9050, prices: [{ price: 206.78 }] }],
      'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId=1&performanceId=30589': {
        available: { 'S_1-M-3': { no: 7027, sec: 1, row: 'M', num: '3', zone: 9050 } }
      }
    };
    const apiRequests = [];
    const fakeFetch = async (_env, url) => {
      apiRequests.push(url);
      return { text: JSON.stringify(responses[url] || {}), status: 200 };
    };

    const result = await segerstromDrillDownStrategy(targetRow, '', {}, {}, fakeFetch, () => {}, adapter);

    assert.equal(result[0].section, 'Orchestra');
    assert.deepEqual(apiRequests, [
      'https://seatme.scfta.org/api/sectionAvailability/performance/30589',
      'https://seatme.scfta.org/api/settings/performance/30589',
      'https://seatme.scfta.org/api/pricing/performance/30589',
      'https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId=1&performanceId=30589'
    ]);
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
    assert.equal(eventInsert.values[5], 'segerstrom_center:hall:samueli%20theater');
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
    const persistedStatements = [];
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
      batch: async statements => {
        persistedStatements.push(...statements);
        return statements.map(() => ({ changes: 1 }));
      }
    };
    const settingsRequests = [];
    const bulkBuyButtonRequests = [];
    let singleBuyButtonRequestCount = 0;
    const adapter = {
      venueName: 'Segerstrom Center for the Arts', timezoneName: 'America/Los_Angeles', algoliaAppId: 'app', algoliaApiKey: 'key', algoliaIndexName: 'index',
      discoveryAllowedHalls: ['Segerstrom Hall'],
      buyButtonApiUrl: 'https://www.scfta.org/BuyButton/ButtonById',
      settingsApiUrlPattern: 'https://seatme.scfta.org/api/settings/performance/{performanceId}',
      ticketingUrlTemplate: 'https://seatme.scfta.org/single?id={performanceId}'
    };
    const secureFetch = async (_env, url, _target, options) => {
      if (url.includes('ButtonsById')) {
        bulkBuyButtonRequests.push({ url, options });
        // Deliberately reverse the records: discovery must correlate each
        // response by ItemId rather than assume response order.
        return {
          status: 200,
          routedVia: 'native',
          text: JSON.stringify([
            { ItemId: 789, SubItems: [{ ItemId: 7891, Status: 'OnSale', TicketCount: 1 }] },
            { ItemId: 456, SubItems: [{ ItemId: 4561, Status: 'OnSale', TicketCount: 1 }] }
          ])
        };
      }
      if (url.includes('ButtonById')) {
        singleBuyButtonRequestCount += 1;
        return { status: 200, routedVia: 'native', text: JSON.stringify({ SubItems: [] }) };
      }
      settingsRequests.push({ url, options });
      const performanceId = url.split('/').at(-1);
      return { status: 200, routedVia: 'native', text: JSON.stringify({ additionalPerformances: [{ performanceId, performanceDate: '2026-12-01T20:00:00Z', description: 'Example Show', hallName: 'Segerstrom Hall' }] }) };
    };
    const apiFetch = async () => ({ status: 200, text: JSON.stringify({ hits: [
      { TessituraId: 456, Title: 'Example Show One', Venue: ['Segerstrom Hall'] },
      { TessituraId: 789, Title: 'Example Show Two', Venue: ['Segerstrom Hall'] }
    ], nbPages: 1 }) });
    const RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate {
      constructor(value) {
        super(value === undefined ? '2026-08-03T13:00:00-07:00' : value);
      }
      static now() { return new RealDate('2026-08-03T13:00:00-07:00').getTime(); }
    };
    try {
      await segerstromProductionDiscoveryStrategy({ venue_id: 'segerstrom_center' }, '', { DB: fakeDb }, {}, secureFetch, () => {}, adapter, apiFetch);
      const singleResult = await segerstromSingleProductionDiscovery(
        { venue_id: 'segerstrom_center' },
        { id: 456, title: 'Example Show One' },
        { DB: fakeDb }, {}, secureFetch, () => {}, adapter, apiFetch
      );
      assert.equal(singleResult.discoveredEvents[0].venueHall, 'Segerstrom Hall');
    } finally {
      globalThis.Date = RealDate;
    }
    assert.equal(bulkBuyButtonRequests.length, 2);
    assert.match(bulkBuyButtonRequests[0].options.body, /ProdIds%5B%5D=456/);
    assert.match(bulkBuyButtonRequests[0].options.body, /ProdIds%5B%5D=789/);
    assert.equal(singleBuyButtonRequestCount, 0);
    assert.equal(settingsRequests.length, 3);
    assert.ok(settingsRequests.every(request => request.options.apiRequest === true));
    const eventInsert = persistedStatements.find(statement => statement.sql?.includes('INSERT OR IGNORE INTO events'));
    assert.equal(eventInsert.values[4], 'Segerstrom Hall');
  });

  test('targets endpoint requires authentication and does not disclose adapter secrets', async () => {
    const denied = await worker.fetch(new Request('https://example.com/targets'), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(denied.status, 401);

    const configRow = {
      venue_id: 'example', venue_name: 'Example', timezone_name: 'UTC', security_tier: 'low',
      config_json: JSON.stringify({ discoveryStrategy: 'singleStep', inventoryStrategy: 'singleStep', urlPattern: 'https://example.test' }),
      credential_refs_json: JSON.stringify({ apiKey: 'EXAMPLE_API_KEY' })
    };
    const fakeDb = {
      prepare: () => ({
        bind: () => ({ first: async () => configRow }),
        all: async () => ({ results: [configRow] })
      })
    };
    const noVenueBinding = await worker.fetch(new Request('https://example.com/targets', { headers: { 'X-Webhook-Secret': WEBHOOK_SECRET } }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET, EXAMPLE_API_KEY: 'not-disclosed', DB: fakeDb }, {});
    assert.equal(noVenueBinding.status, 200);
    assert.deepEqual((await noVenueBinding.json()).venue_adapters, []);

    const allowed = await worker.fetch(new Request('https://example.com/targets', { headers: { 'X-Webhook-Secret': WEBHOOK_SECRET } }), {
      WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET,
      EXAMPLE_API_KEY: 'not-disclosed',
      WORKER_VENUE_ID: 'example',
      DB: fakeDb
    }, {});
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

  test('single-production discovery endpoint requires authentication and a numeric production ID', async () => {
    const denied = await worker.fetch(new Request('https://example.com/discovery/single-production', { method: 'POST', body: '{}' }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(denied.status, 401);

    const invalidProduction = await worker.fetch(new Request('https://example.com/discovery/single-production', {
      method: 'POST',
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
      body: '{"production_id":"not-a-tessitura-id"}'
    }), { WEBHOOK_SHARED_SECRET: WEBHOOK_SECRET }, {});
    assert.equal(invalidProduction.status, 400);
  });

  test('automated approval requires two explicit production controls', () => {
    assert.equal(isSkyboxListingEnabled({ ALLOW_SKYBOX_LISTING: 'true' }), false);
    assert.equal(isSkyboxListingEnabled({ ALLOW_SKYBOX_LISTING: 'true', ENABLE_AUTOMATED_APPROVAL: 'true' }), true);
  });


};

run();
