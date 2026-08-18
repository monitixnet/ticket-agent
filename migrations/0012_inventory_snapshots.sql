-- Durable inventory observations. A scan is immutable: history is retained as
-- separate scans so availability can be compared across time without rewriting
-- the prior observation.
CREATE TABLE IF NOT EXISTS inventory_scans (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  scan_source TEXT NOT NULL,
  scanned_at DATETIME NOT NULL,
  snapshot_hash TEXT NOT NULL,
  available_item_count INTEGER NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_scans_event_scanned
  ON inventory_scans(event_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_scans_venue_scanned
  ON inventory_scans(venue_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS inventory_snapshot_seats (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  section_label TEXT NOT NULL,
  row_label TEXT NOT NULL,
  seat_label TEXT NOT NULL,
  price_level TEXT,
  seat_quality TEXT,
  price_cents INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (scan_id) REFERENCES inventory_scans(id) ON DELETE CASCADE,
  UNIQUE (scan_id, section_label, row_label, seat_label, price_level, seat_quality, price_cents)
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshot_seats_scan
  ON inventory_snapshot_seats(scan_id, section_label, row_label, seat_label);
