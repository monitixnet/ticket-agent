-- Venue-scoped hall control-plane registry. Discovery may register a hall when
-- the source supplies one; curated layout/capacity metadata belongs here.
CREATE TABLE IF NOT EXISTS venue_halls (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capacity INTEGER,
  seating_layout_key TEXT,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'validated', 'active', 'inactive')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (venue_id, canonical_name),
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_venue_halls_venue_status ON venue_halls(venue_id, status);

ALTER TABLE events ADD COLUMN venue_hall_id TEXT REFERENCES venue_halls(id);
CREATE INDEX IF NOT EXISTS idx_events_venue_hall_id ON events(venue_hall_id);
