-- A physical seat has a position zone; a hall does not have one global zone.
-- `unclassified` fails closed until a future venue supplies its own mapping.
ALTER TABLE venue_hall_seats ADD COLUMN quality_zone TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (quality_zone IN ('center', 'left', 'right', 'side', 'limited_view', 'not_applicable', 'unclassified'));

UPDATE venue_hall_seats
SET quality_zone = 'not_applicable'
WHERE row_id IN (
  SELECT r.id
  FROM venue_hall_rows r
  JOIN venue_hall_sections s ON s.id = r.section_id
  WHERE s.venue_hall_id = 'segerstrom_center:hall:segerstrom%20hall'
);

UPDATE venue_halls
SET metadata_json = json_set(metadata_json,
  '$.seat_position_policy', 'not_applicable_row_forward_only',
  '$.seat_position_zone', 'not_applicable')
WHERE id = 'segerstrom_center:hall:segerstrom%20hall';

-- Replace the unbounded raw-seat snapshot table. No local rows existed when
-- this correction was introduced. We retain scan headers and only persist
-- actionable target blocks with their two qualifying buffers.
DROP TABLE IF EXISTS inventory_snapshot_seats;

CREATE TABLE IF NOT EXISTS inventory_candidate_blocks (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  target_quantity INTEGER NOT NULL CHECK (target_quantity > 0),
  section_label TEXT NOT NULL,
  row_label TEXT NOT NULL,
  start_seat_label TEXT NOT NULL,
  end_seat_label TEXT NOT NULL,
  price_level TEXT,
  seat_quality TEXT,
  price_cents INTEGER,
  position_zone TEXT NOT NULL DEFAULT 'unclassified',
  target_seats_json TEXT NOT NULL,
  buffer_blocks_json TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scan_id) REFERENCES inventory_scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_candidate_blocks_scan
  ON inventory_candidate_blocks(scan_id, target_quantity, section_label, row_label);
