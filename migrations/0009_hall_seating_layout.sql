-- Canonical physical seating layout. This is intentionally separate from live
-- event inventory: one hall layout can be reused by many performances.
CREATE TABLE IF NOT EXISTS venue_hall_sections (
  id TEXT PRIMARY KEY,
  venue_hall_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sort_order INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (venue_hall_id, canonical_name),
  FOREIGN KEY (venue_hall_id) REFERENCES venue_halls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS venue_hall_rows (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL,
  row_label TEXT NOT NULL,
  sort_order INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (section_id, row_label),
  FOREIGN KEY (section_id) REFERENCES venue_hall_sections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS venue_hall_seats (
  id TEXT PRIMARY KEY,
  row_id TEXT NOT NULL,
  seat_label TEXT NOT NULL,
  seat_number INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (row_id, seat_label),
  FOREIGN KEY (row_id) REFERENCES venue_hall_rows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_venue_hall_sections_hall ON venue_hall_sections(venue_hall_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_venue_hall_rows_section ON venue_hall_rows(section_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_venue_hall_seats_row ON venue_hall_seats(row_id, seat_number);
