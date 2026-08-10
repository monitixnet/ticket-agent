async function ensureTable(env, createTableSql) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(createTableSql).run();
  } catch (err) {
    console.error('[DB] Table creation failed:', err?.message || err);
  }
}

export async function ensureWorkerLogsTable(env) {
  const sql = `CREATE TABLE IF NOT EXISTS worker_logs (
    id TEXT PRIMARY KEY,
    timestamp DATETIME NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
  await ensureTable(env, sql);
}

export async function persistWorkerLog(env, logId, level, message, context = {}) {
  if (!env?.DB) return;
  try {
    await ensureWorkerLogsTable(env);
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
  await ensureWorkerLogsTable(env);
  const result = await env.DB.prepare(
    'SELECT id, timestamp, level, message, context FROM worker_logs ORDER BY timestamp DESC LIMIT ?'
  ).bind(limit).all();
  return (result && result.results) ? result.results : [];
}

const GET_NEXT_EVENT_TO_SCAN_SQL = `
  SELECT e.id as event_id, e.showtime, e.event_url, s.show_name, v.id as venue_id, v.name as venue_name, v.state_code, v.timezone_name, v.security_tier
  FROM events e JOIN shows s ON e.show_id = s.id JOIN venues v ON s.venue_id = v.id
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
    AND e.showtime >= datetime('now') ORDER BY e.last_scanned_at ASC LIMIT 1`;
  return db.prepare(sql).bind(...activeVenueIds).first();
}

export function updateEventScanResult(db, eventId, snapshotHash, timestamp) {
  return db.prepare('UPDATE events SET last_snapshot_hash = ?, last_scanned_at = ? WHERE id = ?')
    .bind(snapshotHash, timestamp, eventId)
    .run();
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

export async function getNextPendingScanJob(env, ctx) {
  // In a real environment, this would interact with a queue or durable object.
  // For local dev, we log that this is a no-op. This is not an event worth
  // persisting, so we just return null.
  console.log('[SCHEDULED] No pending scan job implementation available in local dev.');
  return null;
}

export async function completeScanJob(env, ctx, jobId, outcome, metadata) {
  // In a real environment, this would update the state of a job.
  // For local dev, we log that this is a no-op.
  console.log(`[SCHEDULED] Skipping completeScanJob for job ${jobId}. Outcome: ${outcome}`);
  return null;
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

export async function upsertDiscoveredEvents(db, discoveredEvents = []) {
  if (!discoveredEvents.length) return { inserted: 0, updated: 0 };

  const stmts = [];
  // Group events by show name to reduce show lookups
  const shows = discoveredEvents.reduce((acc, event) => {
    if (!acc[event.showName]) {
      acc[event.showName] = { venueId: event.venueId, events: [] };
    }
    acc[event.showName].events.push(event);
    return acc;
  }, {});

  for (const showName in shows) {
    const { venueId, events } = shows[showName];
    // Upsert show to get a stable show_id
    stmts.push(db.prepare("INSERT INTO shows (name, venue_id) VALUES (?, ?) ON CONFLICT(name, venue_id) DO NOTHING").bind(showName, venueId));
    const show = await db.prepare("SELECT id FROM shows WHERE name = ? AND venue_id = ?").bind(showName, venueId).first();
    const showId = show.id;

    // Batch insert all events for this show
    const eventInsert = db.prepare("INSERT OR IGNORE INTO events (id, show_id, showtime, event_url) VALUES (?, ?, ?, ?)"); // event_url is the ticketing page URL
    const eventStmts = events.map(event => eventInsert.bind(event.eventId, showId, event.showtime, event.eventDetailUrl));
    stmts.push(...eventStmts);
  }

  const results = await db.batch(stmts);
  const inserted = results.reduce((sum, res) => sum + (res.changes ?? 0), 0);
  console.log(`[DB] Upsert complete. Inserted ${inserted} new event(s) out of ${discoveredEvents.length} discovered.`);
  return { inserted, total: discoveredEvents.length };
}