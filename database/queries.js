export async function persistWorkerLog(env, logId, level, message, context = {}) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(
      'INSERT INTO worker_logs (id, timestamp, level, message, context) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      logId,
      new Date().toISOString(),
      level,
      message,
      JSON.stringify(context)
    ).run();
  } catch (err) {
    console.error('[DB] Log persist failed:', err?.message || err);
  }
}

export async function getRecentWorkerLogs(env, limit = 50) {
  const result = await env.DB.prepare(
    'SELECT id, timestamp, level, message, context FROM worker_logs ORDER BY timestamp DESC LIMIT ?'
  ).bind(limit).all();
  return (result && result.results) ? result.results : [];
}

// Endpoint telemetry intentionally records response metadata only: no request
// headers, cookies, URLs with query data, or response bodies.
export async function recordInventoryEndpointTelemetry(db, telemetry = {}) {
  if (!db || !telemetry.id || !telemetry.eventId || !telemetry.venueId || !telemetry.endpointType) return;
  try {
    await db.prepare(`INSERT INTO inventory_endpoint_telemetry (
      id, event_id, venue_id, inventory_job_id, endpoint_type, provider,
      http_status, content_type, redirect_detected, outcome, duration_ms, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        telemetry.id, telemetry.eventId, telemetry.venueId, telemetry.inventoryJobId || null,
        telemetry.endpointType, telemetry.provider || 'unknown', Number(telemetry.httpStatus) || 0,
        telemetry.contentType || null, telemetry.redirectDetected ? 1 : 0,
        telemetry.outcome || 'unknown', Math.max(0, Number(telemetry.durationMs) || 0),
        telemetry.observedAt || new Date().toISOString()
      ).run();
  } catch (err) {
    console.error('[DB] Inventory endpoint telemetry persist failed:', err?.message || err);
  }
}

// Discovery must remain successful even if this optional operational telemetry
// cannot be written, so persistence failures are contained here.
export async function recordDiscoveryBatchMetric(db, metric) {
  if (!db) return;
  try {
    await db.prepare(`INSERT INTO discovery_batch_metrics (
      id, venue_id, started_at, completed_at, duration_ms,
      processed_production_count, discovered_event_count, inserted_event_count,
      failed_production_count, remaining_production_count, total_production_count,
      outcome_counts_json, job_run_number, estimated_runs_remaining
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        metric.id, metric.venueId, metric.startedAt, metric.completedAt, metric.durationMs,
        metric.processedProductionCount, metric.discoveredEventCount, metric.insertedEventCount,
        metric.failedProductionCount, metric.remainingProductionCount, metric.totalProductionCount,
        JSON.stringify(metric.outcomeCounts || {}), metric.jobRunNumber, metric.estimatedRunsRemaining
      ).run();
  } catch (err) {
    console.error('[DB] Discovery metric persist failed:', err?.message || err);
  }
}

const GET_NEXT_EVENT_TO_SCAN_SQL = `
  SELECT e.id as event_id, e.showtime, e.event_url, e.venue_hall, e.venue_hall_id,
    s.show_name, v.id as venue_id, v.name as venue_name, v.state_code, v.timezone_name, v.security_tier,
    vh.capacity AS mapped_capacity_seat_count,
    eis.availability_state AS inventory_availability_state,
    eis.availability_fingerprint AS last_availability_fingerprint,
    eis.last_availability_checked_at,
    eis.last_deep_scan_at
  FROM events e
  JOIN shows s ON e.show_id = s.id
  JOIN venues v ON s.venue_id = v.id
  LEFT JOIN venue_halls vh ON vh.id = e.venue_hall_id
  LEFT JOIN event_inventory_state eis ON eis.event_id = e.id
`;

export function getNextEventWithActiveListing(db, activeVenueIds = []) {
  if (!activeVenueIds.length) return null;
  const placeholders = activeVenueIds.map(() => '?').join(', ');
  const sql = `
    SELECT e.id as event_id, e.showtime, e.event_url, s.show_name, v.id as venue_id, v.name as venue_name, v.state_code, v.timezone_name, v.security_tier,
           l.id as listing_row_id, l.section_label, l.row_label, l.seat_label, l.price_cents, l.skybox_listing_id
    FROM events e
    JOIN shows s ON e.show_id = s.id
    JOIN venues v ON s.venue_id = v.id
    JOIN listings l ON l.event_id = e.id AND l.current_state = 'ACTIVE'
    WHERE v.id IN (${placeholders})
    AND e.showtime >= datetime('now') ORDER BY e.last_scanned_at ASC LIMIT 1`;
  return db.prepare(sql).bind(...activeVenueIds).first();
}

export function getNextUpcomingEvent(db, activeVenueIds = []) {
  if (!activeVenueIds.length) return null;
  const placeholders = activeVenueIds.map(() => '?').join(', ');
  const sql = `${GET_NEXT_EVENT_TO_SCAN_SQL}
    WHERE v.id IN (${placeholders})
    AND e.showtime >= datetime('now')
    AND e.discovery_outcome IN ('on_sale', 'sold_out')
    ORDER BY e.last_scanned_at ASC LIMIT 1`;
  return db.prepare(sql).bind(...activeVenueIds).first();
}

// Exact-event lookup for authenticated inventory smoke tests. This deliberately
// uses the same event/venue shape as the scheduled inventory selector.
export function getUpcomingEventById(db, eventId, activeVenueIds = []) {
  if (!eventId || !activeVenueIds.length) return null;
  const placeholders = activeVenueIds.map(() => '?').join(', ');
  const sql = `${GET_NEXT_EVENT_TO_SCAN_SQL}
    WHERE e.id = ?
    AND v.id IN (${placeholders})
    AND e.showtime >= datetime('now')
    AND e.discovery_outcome IN ('on_sale', 'sold_out')
    LIMIT 1`;
  return db.prepare(sql).bind(eventId, ...activeVenueIds).first();
}

export function updateEventScanResult(db, eventId, snapshotHash, timestamp) {
  return db.prepare('UPDATE events SET last_snapshot_hash = ?, last_scanned_at = ? WHERE id = ?')
    .bind(snapshotHash, timestamp, eventId)
    .run();
}

// Persist only actionable candidates. Full raw-seat snapshots are intentionally
// not retained: they grow with every scan and are the wrong shape for the
// target-plus-two-buffer monitoring rule.
export async function persistInventoryCandidates(db, snapshot = {}) {
  if (!db || !snapshot.eventId || !snapshot.venueId || !snapshot.scanId) return null;
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  await db.prepare(`INSERT INTO inventory_scans (
    id, event_id, venue_id, scan_source, scanned_at, snapshot_hash, available_item_count,
    inventory_job_id, duration_ms, candidate_block_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      snapshot.scanId, snapshot.eventId, snapshot.venueId,
      snapshot.scanSource || 'scheduled_inventory', snapshot.scannedAt,
      snapshot.snapshotHash, Number(snapshot.availableItemCount) || 0,
      snapshot.inventoryJobId || null, Number(snapshot.durationMs) || 0, candidates.length
    ).run();

  const CHUNK_SIZE = 75;
  for (let offset = 0; offset < candidates.length; offset += CHUNK_SIZE) {
    const statements = candidates.slice(offset, offset + CHUNK_SIZE).map((candidate, index) => {
      const ordinal = offset + index;
      return db.prepare(`INSERT INTO inventory_candidate_blocks (
        id, scan_id, target_quantity, section_label, row_label,
        start_seat_label, end_seat_label, price_level, seat_quality,
        price_cents, position_zone, target_seats_json, buffer_blocks_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          `${snapshot.scanId}:candidate:${ordinal}`, snapshot.scanId,
          Math.max(1, Number(candidate.targetQuantity) || 1),
          String(candidate.section || ''), String(candidate.row || ''),
          String(candidate.startSeat || ''), String(candidate.endSeat || ''),
          candidate.priceLevel == null ? null : String(candidate.priceLevel),
          candidate.seatQuality == null ? null : String(candidate.seatQuality),
          Number.isFinite(Number(candidate.priceCents)) ? Number(candidate.priceCents) : null,
          String(candidate.positionZone || 'unclassified'),
          JSON.stringify(candidate.targetSeats || []), JSON.stringify(candidate.bufferBlocks || [])
        );
    });
    await db.batch(statements);
  }
  return { scanId: snapshot.scanId, candidateCount: candidates.length };
}

// A watch rule is a venue-scoped control-plane instruction, not a hard-coded
// title. A performance is due while its last successful inventory observation
// is sold out and either discovery also says sold_out or an explicit rule has
// opted that exact show into monitoring. The explicit-rule branch repairs
// legacy/stale discovery rows (such as Phantom) without admitting arbitrary
// unknown events into the drop lane.
export async function getDueDropWatchEvents(db, venueId, limit = 6, priorityIntervals = {}, availabilityPriorityPolicy = {}) {
  const intervals = {
    critical: Math.max(5, Number(priorityIntervals.critical) || 5),
    high: Math.max(5, Number(priorityIntervals.high) || 10),
    medium: Math.max(5, Number(priorityIntervals.medium) || 30),
    low: Math.max(5, Number(priorityIntervals.low) || 60)
  };
  const policyEnabled = availabilityPriorityPolicy.enabled === true || availabilityPriorityPolicy.enabled === 1;
  const criticalMaxAvailableBasisPoints = Math.max(0, Math.min(10_000,
    Number(availabilityPriorityPolicy.criticalMaxAvailableBasisPoints) || 1000));
  const lowMinAvailableBasisPoints = Math.max(0, Math.min(10_000,
    Number(availabilityPriorityPolicy.lowMinAvailableBasisPoints) || 8000));
  const result = await db.prepare(`SELECT e.id as event_id, e.showtime, e.event_url, e.venue_hall, e.venue_hall_id,
      s.show_name, v.id as venue_id, v.name as venue_name, v.state_code, v.timezone_name, v.security_tier,
      vh.capacity AS mapped_capacity_seat_count,
      wr.max_price_cents AS drop_watch_max_price_cents,
      CASE
        WHEN eis.availability_state = 'sold_out' AND wr.priority IS NOT NULL THEN wr.priority
        WHEN eis.availability_state = 'sold_out' THEN 'medium'
        WHEN ? = 1 AND eis.availability_state = 'available'
          AND eis.available_percentage_basis_points <= ? THEN 'critical'
        WHEN ? = 1 AND eis.availability_state = 'available'
          AND eis.available_percentage_basis_points >= ? THEN 'low'
        ELSE 'medium'
      END AS drop_watch_priority,
      eis.availability_state AS inventory_availability_state,
      eis.available_percentage_basis_points,
      eis.capacity_seat_count,
      eis.availability_fingerprint AS last_availability_fingerprint,
      eis.last_availability_checked_at,
      eis.last_deep_scan_at
    FROM events e JOIN shows s ON e.show_id = s.id JOIN venues v ON s.venue_id = v.id
    LEFT JOIN venue_halls vh ON vh.id = e.venue_hall_id
    LEFT JOIN inventory_watch_rules wr
      ON wr.venue_id = v.id AND wr.show_name = s.show_name AND wr.enabled = 1
    LEFT JOIN event_inventory_state eis ON eis.event_id = e.id
    WHERE v.id = ? AND e.showtime >= datetime('now')
      AND (
        (eis.availability_state = 'sold_out' AND (e.discovery_outcome = 'sold_out' OR wr.id IS NOT NULL))
        OR (? = 1 AND eis.availability_state = 'available' AND e.discovery_outcome = 'on_sale'
          AND eis.available_percentage_basis_points IS NOT NULL
          AND (eis.available_percentage_basis_points <= ? OR eis.available_percentage_basis_points >= ?))
      )
      AND (eis.last_observed_at IS NULL
        OR datetime(eis.last_observed_at, '+' || CASE
          WHEN (eis.availability_state = 'sold_out' AND wr.priority = 'critical')
            OR (? = 1 AND eis.availability_state = 'available'
              AND eis.available_percentage_basis_points <= ?) THEN ?
          WHEN eis.availability_state = 'sold_out' AND wr.priority = 'high' THEN ?
          WHEN (eis.availability_state = 'sold_out' AND wr.priority = 'low')
            OR (? = 1 AND eis.availability_state = 'available'
              AND eis.available_percentage_basis_points >= ?) THEN ?
          ELSE ? END || ' minutes') <= datetime('now'))
    ORDER BY CASE
      WHEN eis.availability_state = 'sold_out' AND wr.priority IS NOT NULL THEN wr.priority
      WHEN eis.availability_state = 'sold_out' THEN 'medium'
      WHEN ? = 1 AND eis.availability_state = 'available'
        AND eis.available_percentage_basis_points <= ? THEN 'critical'
      WHEN ? = 1 AND eis.availability_state = 'available'
        AND eis.available_percentage_basis_points >= ? THEN 'low'
      ELSE 'medium'
      END
      WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      eis.last_observed_at ASC, e.showtime ASC
    LIMIT ?`).bind(
      policyEnabled ? 1 : 0, criticalMaxAvailableBasisPoints,
      policyEnabled ? 1 : 0, lowMinAvailableBasisPoints,
      venueId, policyEnabled ? 1 : 0, criticalMaxAvailableBasisPoints, lowMinAvailableBasisPoints,
      policyEnabled ? 1 : 0, criticalMaxAvailableBasisPoints,
      policyEnabled ? 1 : 0, lowMinAvailableBasisPoints,
      policyEnabled ? 1 : 0, criticalMaxAvailableBasisPoints, intervals.critical,
      intervals.high,
      policyEnabled ? 1 : 0, lowMinAvailableBasisPoints, intervals.low,
      intervals.medium,
      policyEnabled ? 1 : 0, criticalMaxAvailableBasisPoints,
      policyEnabled ? 1 : 0, lowMinAvailableBasisPoints,
      Math.max(1, Math.min(48, Number(limit) || 6))).all();
  return result?.results || [];
}

// A critical watch is unhealthy when it has not received a successful live
// inventory observation within twice its configured cadence. This query is
// intentionally limited to explicit critical rules: automatic medium watches
// should not page the operator during ordinary batch delays.
export async function getStaleCriticalDropWatchEvents(db, venueId, staleAfterMinutes) {
  const minutes = Math.max(10, Number(staleAfterMinutes) || 10);
  const result = await db.prepare(`SELECT e.id AS event_id, s.show_name, e.showtime,
      e.discovery_outcome, eis.availability_state, eis.last_observed_at
    FROM inventory_watch_rules wr
    JOIN shows s ON s.venue_id = wr.venue_id AND s.show_name = wr.show_name
    JOIN events e ON e.show_id = s.id
    LEFT JOIN event_inventory_state eis ON eis.event_id = e.id
    WHERE wr.venue_id = ? AND wr.enabled = 1 AND wr.priority = 'critical'
      AND e.showtime >= datetime('now')
      AND (eis.last_observed_at IS NULL
        OR datetime(eis.last_observed_at, '+' || ? || ' minutes') <= datetime('now'))
    ORDER BY eis.last_observed_at ASC, e.showtime ASC`).bind(venueId, minutes).all();
  return result?.results || [];
}

export async function getDropWatchHealthAlertState(db, venueId) {
  const row = await db.prepare('SELECT value_string FROM system_state WHERE key_name = ?')
    .bind(`drop_watch_health_alert:${venueId}`).first();
  if (!row?.value_string) return null;
  try { return JSON.parse(row.value_string); } catch { return null; }
}

export function setDropWatchHealthAlertState(db, venueId, state) {
  return db.prepare('INSERT OR REPLACE INTO system_state (key_name, value_string) VALUES (?, ?)')
    .bind(`drop_watch_health_alert:${venueId}`, JSON.stringify(state || {})).run();
}

export function clearDropWatchHealthAlertState(db, venueId) {
  return db.prepare('DELETE FROM system_state WHERE key_name = ?')
    .bind(`drop_watch_health_alert:${venueId}`).run();
}

// The alert insertion happens before the state upsert in one D1 batch. That
// makes a sold_out -> available transition idempotent: retries of the same
// observation cannot send another alert, while a return to sold_out re-arms a
// later genuine drop.
export async function recordInventoryAvailabilityObservation(db, observation = {}) {
  if (!db || !observation.eventId || !observation.scanId || !observation.observedAt) return { dropDetected: false };
  const availableItemCount = Math.max(0, Number(observation.availableItemCount) || 0);
  const alertEligibleItemCount = Math.max(0, Number(
    observation.alertEligibleItemCount ?? availableItemCount
  ) || 0);
  const capacitySeatCount = Number.isInteger(Number(observation.capacitySeatCount)) && Number(observation.capacitySeatCount) > 0
    ? Number(observation.capacitySeatCount) : null;
  const availablePercentageBasisPoints = capacitySeatCount === null ? null
    : Math.min(10_000, Math.round((availableItemCount * 10_000) / capacitySeatCount));
  const nextState = availableItemCount > 0 ? 'available' : 'sold_out';
  const nextDiscoveryOutcome = nextState === 'available' ? 'on_sale' : 'sold_out';
  const alertId = observation.alertId || `${observation.scanId}:drop`;
  const payload = JSON.stringify(observation.alertPayload || {});
  const statements = [
    db.prepare(`INSERT INTO inventory_drop_alerts (
      id, event_id, scan_id, status, payload_json, next_attempt_at, created_at, updated_at
    ) SELECT ?, ?, ?, 'pending', ?, ?, ?, ?
      FROM event_inventory_state
      WHERE event_id = ? AND availability_state = 'sold_out' AND ? > 0`)
      .bind(alertId, observation.eventId, observation.scanId, payload,
        observation.observedAt, observation.observedAt, observation.observedAt,
        observation.eventId, alertEligibleItemCount),
    db.prepare(`INSERT INTO event_inventory_state (
      event_id, availability_state, available_item_count, last_scan_id, last_observed_at,
      availability_fingerprint, last_availability_checked_at, last_deep_scan_at,
      capacity_seat_count, available_percentage_basis_points, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      availability_state = excluded.availability_state,
      available_item_count = excluded.available_item_count,
      last_scan_id = excluded.last_scan_id,
      last_observed_at = excluded.last_observed_at,
      availability_fingerprint = excluded.availability_fingerprint,
      last_availability_checked_at = excluded.last_availability_checked_at,
      last_deep_scan_at = COALESCE(excluded.last_deep_scan_at, event_inventory_state.last_deep_scan_at),
      capacity_seat_count = excluded.capacity_seat_count,
      available_percentage_basis_points = excluded.available_percentage_basis_points,
      updated_at = excluded.updated_at`)
      .bind(observation.eventId, nextState, availableItemCount, observation.scanId,
        observation.observedAt, observation.availabilityFingerprint || null,
        observation.observedAt, observation.deepScanAt || null,
        capacitySeatCount, availablePercentageBasisPoints, observation.observedAt),
    // A successful SeatMe availability response is stronger and fresher than
    // an old discovery classification for a future performance. Synchronize
    // the inventory-derived outcome so it remains eligible for the correct
    // inventory or drop-monitoring lane. Failed requests never reach here.
    db.prepare(`UPDATE events SET discovery_outcome = ?, discovery_status_checked_at = ?
      WHERE id = ? AND discovery_outcome NOT IN ('past', 'not_on_sale', 'free_no_tickets')`)
      .bind(nextDiscoveryOutcome, observation.observedAt, observation.eventId)
  ];
  const results = await db.batch(statements);
  const inserted = results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0;
  return {
    dropDetected: inserted === 1,
    alertId: inserted === 1 ? alertId : null,
    availabilityState: nextState,
    discoveryOutcome: nextDiscoveryOutcome,
    capacitySeatCount,
    availablePercentageBasisPoints
  };
}

export async function getPendingInventoryDropAlerts(db, limit = 20) {
  const result = await db.prepare(`SELECT * FROM inventory_drop_alerts
    WHERE status IN ('pending', 'failed')
      AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
    ORDER BY created_at ASC LIMIT ?`).bind(Math.max(1, Math.min(50, Number(limit) || 20))).all();
  return result?.results || [];
}

export function markInventoryDropAlertDelivered(db, alertId, deliveredAt) {
  return db.prepare(`UPDATE inventory_drop_alerts SET status = 'delivered', attempt_count = attempt_count + 1,
    delivered_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
    .bind(deliveredAt, deliveredAt, alertId).run();
}

export function markInventoryDropAlertFailed(db, alertId, error, nextAttemptAt) {
  return db.prepare(`UPDATE inventory_drop_alerts SET status = 'failed', attempt_count = attempt_count + 1,
    last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
    .bind(String(error || 'delivery failed').slice(0, 500), nextAttemptAt, new Date().toISOString(), alertId).run();
}

// A candidate alert is created only when the actionable candidate digest for an
// event changes. If no candidates remain, pending alerts are made obsolete so
// an old opportunity cannot be delivered after a later scan disproves it.
export async function recordInventoryCandidateObservation(db, observation = {}) {
  if (!db || !observation.eventId || !observation.scanId || !observation.observedAt) return { candidateDetected: false };
  const fingerprint = String(observation.candidateFingerprint || '');
  const state = await db.prepare(`SELECT candidate_fingerprint, active
    FROM inventory_candidate_alert_state WHERE event_id = ?`).bind(observation.eventId).first();
  const hasCandidates = Boolean(fingerprint);
  const changed = hasCandidates && (Number(state?.active) !== 1 || state?.candidate_fingerprint !== fingerprint);
  const statements = [];
  if (!hasCandidates) {
    statements.push(db.prepare(`UPDATE inventory_candidate_alerts SET status = 'obsolete', updated_at = ?
      WHERE event_id = ? AND status IN ('pending', 'failed')`).bind(observation.observedAt, observation.eventId));
  } else if (changed) {
    statements.push(db.prepare(`UPDATE inventory_candidate_alerts SET status = 'obsolete', updated_at = ?
      WHERE event_id = ? AND status IN ('pending', 'failed')`).bind(observation.observedAt, observation.eventId));
    statements.push(db.prepare(`INSERT INTO inventory_candidate_alerts (
      id, event_id, scan_id, status, payload_json, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .bind(observation.alertId || `${observation.scanId}:candidate`, observation.eventId, observation.scanId,
        JSON.stringify(observation.alertPayload || {}), observation.observedAt, observation.observedAt, observation.observedAt));
  }
  statements.push(db.prepare(`INSERT INTO inventory_candidate_alert_state (
    event_id, candidate_fingerprint, active, updated_at
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(event_id) DO UPDATE SET
    candidate_fingerprint = excluded.candidate_fingerprint,
    active = excluded.active,
    updated_at = excluded.updated_at`)
    .bind(observation.eventId, hasCandidates ? fingerprint : null, hasCandidates ? 1 : 0, observation.observedAt));
  await db.batch(statements);
  return { candidateDetected: changed, alertId: changed ? (observation.alertId || `${observation.scanId}:candidate`) : null };
}

export async function getPendingInventoryCandidateAlerts(db, limit = 20) {
  const result = await db.prepare(`SELECT * FROM inventory_candidate_alerts
    WHERE status IN ('pending', 'failed')
      AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
    ORDER BY created_at ASC LIMIT ?`).bind(Math.max(1, Math.min(50, Number(limit) || 20))).all();
  return result?.results || [];
}

export function markInventoryCandidateAlertDelivered(db, alertId, deliveredAt) {
  return db.prepare(`UPDATE inventory_candidate_alerts SET status = 'delivered', attempt_count = attempt_count + 1,
    delivered_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
    .bind(deliveredAt, deliveredAt, alertId).run();
}

export function markInventoryCandidateAlertFailed(db, alertId, error, nextAttemptAt) {
  return db.prepare(`UPDATE inventory_candidate_alerts SET status = 'failed', attempt_count = attempt_count + 1,
    last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
    .bind(String(error || 'delivery failed').slice(0, 500), nextAttemptAt, new Date().toISOString(), alertId).run();
}

export async function getUpcomingInventoryEvents(db, venueId) {
  const result = await db.prepare(`${GET_NEXT_EVENT_TO_SCAN_SQL}
    WHERE v.id = ? AND e.showtime >= datetime('now')
      AND e.discovery_outcome IN ('on_sale', 'sold_out')
    ORDER BY e.showtime ASC`).bind(venueId).all();
  return result?.results || [];
}

export async function getInventoryJob(db, venueId) {
  return db.prepare(`SELECT * FROM inventory_jobs WHERE venue_id = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1`).bind(venueId).first();
}

export async function createInventoryJob(db, job) {
  await db.prepare(`INSERT INTO inventory_jobs (
    id, venue_id, status, remaining_event_ids_json, total_event_count, started_at
  ) VALUES (?, ?, 'running', ?, ?, ?)`)
    .bind(job.id, job.venueId, JSON.stringify(job.remainingEventIds), job.remainingEventIds.length, job.startedAt).run();
  return getInventoryJob(db, job.venueId);
}

export async function claimInventoryJobLease(db, jobId, leaseOwner, leaseExpiresAt, nowIso) {
  const result = await db.prepare(`UPDATE inventory_jobs
    SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
      AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)`)
    .bind(leaseOwner, leaseExpiresAt, nowIso, jobId, nowIso, leaseOwner).run();
  return (result?.meta?.changes ?? result?.changes ?? 0) === 1;
}

export async function checkpointInventoryJob(db, job) {
  return db.prepare(`UPDATE inventory_jobs SET
    remaining_event_ids_json = ?, completed_event_count = ?, failed_event_count = ?,
    skipped_event_count = ?, batch_count = ?, lease_owner = NULL, lease_expires_at = NULL,
    last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?`)
    .bind(JSON.stringify(job.remainingEventIds), job.completedEventCount, job.failedEventCount,
      job.skippedEventCount, job.batchCount, job.lastError || null, job.updatedAt,
      job.id, job.leaseOwner).run();
}

export async function completeInventoryJob(db, job) {
  return db.prepare(`UPDATE inventory_jobs SET status = 'completed', remaining_event_ids_json = '[]',
    completed_event_count = ?, failed_event_count = ?, skipped_event_count = ?, batch_count = ?,
    completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?`)
    .bind(job.completedEventCount, job.failedEventCount, job.skippedEventCount, job.batchCount,
      job.completedAt, job.completedAt, job.id, job.leaseOwner).run();
}

export async function recordInventoryJobBatchMetric(db, metric) {
  return db.prepare(`INSERT INTO inventory_job_batches (
    id, inventory_job_id, venue_id, batch_number, started_at, completed_at, duration_ms,
    attempted_event_count, completed_event_count, failed_event_count, skipped_event_count, remaining_event_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(metric.id, metric.jobId, metric.venueId, metric.batchNumber, metric.startedAt, metric.completedAt,
      metric.durationMs, metric.attemptedEventCount, metric.completedEventCount, metric.failedEventCount,
      metric.skippedEventCount, metric.remainingEventCount).run();
}

export async function getHallRowOrdering(db, venueHallId) {
  if (!db || !venueHallId) return [];
  const result = await db.prepare(`SELECT s.canonical_name AS section_name, r.row_label, r.sort_order
    FROM venue_hall_rows r
    JOIN venue_hall_sections s ON s.id = r.section_id
    WHERE s.venue_hall_id = ?`).bind(venueHallId).all();
  return result?.results || [];
}

export async function getHallInventoryPolicy(db, venueHallId) {
  if (!db || !venueHallId) return null;
  const row = await db.prepare('SELECT metadata_json FROM venue_halls WHERE id = ?')
    .bind(venueHallId).first();
  if (!row) return null;
  try {
    const metadata = JSON.parse(row.metadata_json || '{}');
    return {
      // SQLite JSON stores SQL TRUE as numeric 1. Accept both valid JSON
      // representations so a hall enabled by a migration is not treated as
      // discovery-only at runtime.
      inventoryEnabled: metadata.inventory_enabled === true || metadata.inventory_enabled === 1,
      seatPositionPolicy: metadata.seat_position_policy || null,
      seatPositionZone: metadata.seat_position_zone || 'unclassified'
    };
  } catch {
    return null;
  }
}

export function getListingForValidation(db, skyboxListingId, activeVenueIds = []) {
  if (!activeVenueIds.length) return null;
  const placeholders = activeVenueIds.map(() => '?').join(', ');
  const sql = `
    SELECT l.id as listing_row_id, l.section_label, l.row_label, l.seat_label, l.price_cents, l.current_state,
           e.id as event_id, e.event_url, e.showtime, s.show_name, v.id as venue_id, v.name as venue_name, v.state_code, v.timezone_name, v.security_tier
    FROM listings l JOIN events e ON l.event_id = e.id JOIN shows s ON e.show_id = s.id JOIN venues v ON s.venue_id = v.id
    WHERE l.skybox_listing_id = ? AND v.id IN (${placeholders}) AND e.showtime >= datetime('now') LIMIT 1
  `;
  return db.prepare(sql).bind(skyboxListingId, ...activeVenueIds).first();
}

export function updateListingState(db, listingRowId, newState, timestamp) {
  return db.prepare('UPDATE listings SET current_state = ?, updated_at = ? WHERE id = ?')
    .bind(newState, timestamp, listingRowId)
    .run();
}

export async function getVenueBackoffState(db, venueId) {
  const row = await db.prepare('SELECT value_string FROM system_state WHERE key_name = ?')
    .bind(`venue_backoff:${venueId}`)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.value_string);
  } catch {
    return null;
  }
}

export async function setVenueBackoffState(db, venueId, state) {
  return db.prepare('INSERT OR REPLACE INTO system_state (key_name, value_string) VALUES (?, ?)')
    .bind(`venue_backoff:${venueId}`, JSON.stringify(state))
    .run();
}

export async function clearVenueBackoffState(db, venueId) {
  return db.prepare('DELETE FROM system_state WHERE key_name = ?')
    .bind(`venue_backoff:${venueId}`)
    .run();
}

export async function getDiscoveryJobState(db, jobKey) {
  const row = await db.prepare('SELECT value_string FROM system_state WHERE key_name = ?')
    .bind(jobKey)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.value_string);
  } catch {
    return null;
  }
}

export async function setDiscoveryJobState(db, jobKey, state) {
  return db.prepare('INSERT OR REPLACE INTO system_state (key_name, value_string) VALUES (?, ?)')
    .bind(jobKey, JSON.stringify(state))
    .run();
}

export async function clearDiscoveryJobState(db, jobKey) {
  return db.prepare('DELETE FROM system_state WHERE key_name = ?')
    .bind(jobKey)
    .run();
}

// Retains the last known sale outcome independently of the resumable queue.
// This lets a new catalog pass permanently exclude terminal outcomes while
// retaining a durable audit record of what was observed.
export async function getDiscoveryProductionSchedule(db, venueId) {
  const row = await db.prepare('SELECT value_string FROM system_state WHERE key_name = ?')
    .bind(`discovery_production_schedule:${venueId}`)
    .first();
  if (!row?.value_string) return {};
  try {
    const value = JSON.parse(row.value_string);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export async function setDiscoveryProductionSchedule(db, venueId, schedule) {
  return db.prepare('INSERT OR REPLACE INTO system_state (key_name, value_string) VALUES (?, ?)')
    .bind(`discovery_production_schedule:${venueId}`, JSON.stringify(schedule || {}))
    .run();
}

// Discovery can observe a performance as sold out before it has ever been
// through broad inventory. Seed that state only once so a later successful
// inventory scan remains the authoritative live availability observation.
export async function markDiscoveredSoldOutEvents(db, eventIds = [], observedAt) {
  const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
  if (!uniqueEventIds.length) return 0;
  const timestamp = observedAt || new Date().toISOString();
  const statements = uniqueEventIds.map(eventId => db.prepare(`INSERT INTO event_inventory_state (
    event_id, availability_state, available_item_count, last_scan_id, last_observed_at, updated_at
  ) VALUES (?, 'sold_out', 0, NULL, ?, ?)
  ON CONFLICT(event_id) DO NOTHING`).bind(eventId, timestamp, timestamp));
  await db.batch(statements);
  return uniqueEventIds.length;
}

export async function recordDiscoveredEventOutcomes(db, observations = [], observedAt) {
  const checkedAt = observedAt || new Date().toISOString();
  const allowed = new Set(['on_sale', 'sold_out', 'past', 'not_on_sale', 'free_no_tickets', 'unknown']);
  const unique = new Map();
  for (const observation of observations) {
    const eventId = normalizeExternalId(observation?.eventId);
    const outcome = String(observation?.outcome || 'unknown');
    if (eventId && allowed.has(outcome)) unique.set(eventId, { eventId, outcome, sourceProductionId: observation?.sourceProductionId || null });
  }
  if (!unique.size) return 0;
  const results = await db.batch([...unique.values()].map(({ eventId, outcome, sourceProductionId }) => db.prepare(`UPDATE events
    SET source_production_id = COALESCE(?, source_production_id), discovery_outcome = ?, discovery_status_checked_at = ?
    WHERE id = ?`).bind(sourceProductionId, outcome, checkedAt, eventId)));
  return results.reduce((total, result) => total + (result?.meta?.changes ?? result?.changes ?? 0), 0);
}

// Discovery checkpoints are stored as JSON in system_state. Use a separate,
// compare-and-set lease key so an overlapping cron cannot read the same queue
// and process the same production batch twice. A cancelled Worker naturally
// becomes recoverable after the short expiry.
export async function claimDiscoveryJobLease(db, jobKey, leaseOwner, leaseExpiresAt, nowIso) {
  const leaseKey = `${jobKey}:lease`;
  const payload = JSON.stringify({ leaseOwner, leaseExpiresAt });
  const result = await db.prepare(`INSERT INTO system_state (key_name, value_string) VALUES (?, ?)
    ON CONFLICT(key_name) DO UPDATE SET value_string = excluded.value_string
    WHERE json_extract(system_state.value_string, '$.leaseExpiresAt') IS NULL
      OR json_extract(system_state.value_string, '$.leaseExpiresAt') < ?
      OR json_extract(system_state.value_string, '$.leaseOwner') = ?`)
    .bind(leaseKey, payload, nowIso, leaseOwner).run();
  return (result?.meta?.changes ?? result?.changes ?? 0) === 1;
}

export function releaseDiscoveryJobLease(db, jobKey, leaseOwner) {
  return db.prepare(`DELETE FROM system_state
    WHERE key_name = ? AND json_extract(value_string, '$.leaseOwner') = ?`)
    .bind(`${jobKey}:lease`, leaseOwner).run();
}

export async function cleanupPastEvents(db) {
  console.log('[DB] Running cleanup job for past events...');
  // Purge events that happened more than 6 hours ago. The 6-hour buffer accounts
  // for long-running shows and potential timezone discrepancies.
  const result = await db.prepare("DELETE FROM events WHERE showtime < datetime('now', '-6 hours')").run();
  const changed = result.changes ?? 0;
  if (changed > 0) {
    console.log(`[DB] Purged ${changed} past event(s) from the database.`);
  }
  return { purged: changed };
}

export async function cleanupOldWorkerLogs(db) {
  console.log('[DB] Running cleanup job for old worker logs...');
  // Purge logs older than 7 days to keep the database size manageable.
  const result = await db.prepare("DELETE FROM worker_logs WHERE timestamp < datetime('now', '-7 days')").run();
  await db.prepare("DELETE FROM inventory_endpoint_telemetry WHERE observed_at < datetime('now', '-30 days')").run();
  const changed = result.changes ?? 0;
  if (changed > 0) {
    console.log(`[DB] Purged ${changed} old log(s) from the database.`);
  }
  return { purged: changed };
}

function normalizeHallName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getVenueHallId(venueId, hallName) {
  const normalizedName = normalizeHallName(hallName);
  return normalizedName ? `${venueId}:hall:${encodeURIComponent(normalizedName)}` : null;
}

export async function upsertDiscoveredEvents(db, discoveredEvents = []) {
  if (!discoveredEvents.length) return { inserted: 0, updated: 0, total: 0 };

  const normalizedEvents = discoveredEvents
    .filter(event => event?.eventId)
    .map(event => ({
      ...event,
      normalizedEventId: normalizeExternalId(event.eventId),
      eventUrl: event.eventDetailUrl || null,
      showtime: event.showtime || null,
      venueHall: event.venueHall || event.hall || event.venue_hall || event.location || null,
    }))
    .map(event => ({ ...event, venueHallId: getVenueHallId(event.venueId, event.venueHall) }));

  if (!normalizedEvents.length) return { inserted: 0, updated: 0, total: 0 };

  const existingEventMap = new Map();
  const eventIds = normalizedEvents.map(event => event.normalizedEventId);
  if (eventIds.length) {
    // D1/SQLite has a bounded number of bind variables. Discovery can return
    // hundreds of performances, so query known events in safe-sized chunks.
    const EVENT_LOOKUP_CHUNK_SIZE = 75;
    for (let offset = 0; offset < eventIds.length; offset += EVENT_LOOKUP_CHUNK_SIZE) {
      const eventIdChunk = eventIds.slice(offset, offset + EVENT_LOOKUP_CHUNK_SIZE);
      const placeholders = eventIdChunk.map(() => '?').join(', ');
      const sql = `SELECT id, showtime, event_url, venue_hall, venue_hall_id, source_production_id, discovery_outcome FROM events WHERE id IN (${placeholders})`;
      const existingRows = await db.prepare(sql).bind(...eventIdChunk).all();
      for (const row of existingRows?.results || []) {
        existingEventMap.set(row.id, row);
      }
    }
  }

  const statements = [];
  const halls = new Map();
  for (const event of normalizedEvents) {
    if (event.venueHallId && !halls.has(event.venueHallId)) {
      halls.set(event.venueHallId, event);
    }
  }
  for (const [hallId, event] of halls) {
    statements.push({
      kind: 'hall',
      statement: db.prepare(`INSERT OR IGNORE INTO venue_halls (
        id, venue_id, canonical_name, display_name, status, metadata_json
      ) VALUES (?, ?, ?, ?, 'discovered', '{}')`)
        .bind(hallId, event.venueId, normalizeHallName(event.venueHall), event.venueHall)
    });
  }
  const shows = normalizedEvents.reduce((acc, event) => {
    if (!acc[event.showName]) {
      acc[event.showName] = { venueId: event.venueId, events: [] };
    }
    acc[event.showName].events.push(event);
    return acc;
  }, {});

  for (const showName in shows) {
    const { venueId, events } = shows[showName];
    const showId = `${venueId}:${encodeURIComponent(showName)}`;
    statements.push({
      kind: 'show',
      statement: db.prepare('INSERT OR IGNORE INTO shows (id, venue_id, show_name) VALUES (?, ?, ?)')
        .bind(showId, venueId, showName)
    });

    for (const event of events) {
      const existing = existingEventMap.get(event.normalizedEventId);
      if (existing) {
        // A sold-out BuyButton response has no settings payload. Do not erase
        // previously discovered showtime, URL, or hall metadata with nulls.
        const showtime = event.showtime || existing.showtime;
        const eventUrl = event.eventUrl || existing.event_url;
        const venueHall = event.venueHall || existing.venue_hall;
        const venueHallId = event.venueHallId || existing.venue_hall_id;
        const showtimeChanged = String(existing.showtime || '') !== String(showtime || '');
        const urlChanged = String(existing.event_url || '') !== String(eventUrl || '');
        const hallChanged = String(existing.venue_hall || '') !== String(venueHall || '');
        const hallIdChanged = String(existing.venue_hall_id || '') !== String(venueHallId || '');
        const sourceProductionId = event.sourceProductionId || existing.source_production_id;
        const discoveryOutcome = event.discoveryOutcome || existing.discovery_outcome || 'unknown';
        const eligibilityChanged = String(existing.source_production_id || '') !== String(sourceProductionId || '')
          || String(existing.discovery_outcome || '') !== String(discoveryOutcome || '');

        if (showtimeChanged || urlChanged || hallChanged || hallIdChanged || eligibilityChanged) {
          const eventUpdateTarget = db.prepare(
            'UPDATE events SET show_id = ?, showtime = ?, event_url = ?, venue_hall = ?, venue_hall_id = ?, source_production_id = ?, discovery_outcome = ?, discovery_status_checked_at = ? WHERE id = ?'
          );
          statements.push({
            kind: 'event_update',
            statement: eventUpdateTarget.bind(showId, showtime, eventUrl, venueHall || null, venueHallId, sourceProductionId, discoveryOutcome, new Date().toISOString(), event.normalizedEventId)
          });
        }
        continue;
      }

      // Conflict-safe even if a concurrent/retried discovery run inserts the
      // same performance after the existence lookup.
      const eventInsert = db.prepare('INSERT OR IGNORE INTO events (id, show_id, showtime, event_url, venue_hall, venue_hall_id, source_production_id, discovery_outcome, discovery_status_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      statements.push({
        kind: 'event_insert',
        statement: eventInsert.bind(event.normalizedEventId, showId, event.showtime, event.eventUrl, event.venueHall || null, event.venueHallId, event.sourceProductionId || null, event.discoveryOutcome || 'unknown', new Date().toISOString())
      });
    }
  }

  const results = await db.batch(statements.map(({ statement }) => statement));
  const inserted = results.reduce((sum, res, index) => sum + (statements[index].kind === 'event_insert' ? (res.changes ?? 1) : 0), 0);
  const updated = results.reduce((sum, res, index) => sum + (statements[index].kind === 'event_update' ? (res.changes ?? 1) : 0), 0);

  console.log(`[DB] Upsert complete. Inserted ${inserted} new event(s), updated ${updated} changed event(s), out of ${normalizedEvents.length} discovered.`);
  return { inserted, updated, total: normalizedEvents.length };
}
import { normalizeExternalId } from '../utils.js';
