-- Drop watching is deliberately independent from resale-candidate evaluation.
-- A watcher records the last verified availability for an individual
-- performance and produces one durable alert only for sold_out -> available.
CREATE TABLE IF NOT EXISTS inventory_watch_rules (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  show_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  scan_interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(scan_interval_minutes BETWEEN 1 AND 120),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(venue_id, show_name),
  FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_inventory_state (
  event_id TEXT PRIMARY KEY,
  availability_state TEXT NOT NULL CHECK(availability_state IN ('unknown', 'sold_out', 'available')),
  available_item_count INTEGER NOT NULL DEFAULT 0,
  last_scan_id TEXT,
  last_observed_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(last_scan_id) REFERENCES inventory_scans(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inventory_drop_alerts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed')),
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at DATETIME,
  delivered_at DATETIME,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, scan_id),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(scan_id) REFERENCES inventory_scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watch_rules_active
  ON inventory_watch_rules(venue_id, enabled, show_name);
CREATE INDEX IF NOT EXISTS idx_drop_alerts_delivery
  ON inventory_drop_alerts(status, next_attempt_at, created_at);

-- Start observing every future Phantom performance. The first observation is
-- only a baseline; alerts begin when a later scan sees availability after a
-- confirmed sold-out observation.
INSERT OR IGNORE INTO inventory_watch_rules (
  id, venue_id, show_name, enabled, scan_interval_minutes
) VALUES (
  'segerstrom_center:watch:phantom-of-the-opera',
  'segerstrom_center', 'Phantom of the Opera', 1, 5
);
