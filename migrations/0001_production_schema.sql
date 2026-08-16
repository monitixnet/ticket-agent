-- Apply with: npx wrangler d1 migrations apply ticket-agent-db --remote
-- This migration is safe for the existing schema and creates missing indexes.

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state_code TEXT NOT NULL,
  timezone_name TEXT NOT NULL DEFAULT 'UTC',
  security_tier TEXT NOT NULL DEFAULT 'low'
);

CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  show_name TEXT NOT NULL,
  FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  showtime TEXT NOT NULL,
  event_url TEXT,
  last_snapshot_hash TEXT,
  last_scanned_at TIMESTAMP,
  FOREIGN KEY(show_id) REFERENCES shows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  section_label TEXT NOT NULL,
  row_label TEXT NOT NULL,
  seat_label TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  skybox_listing_id TEXT NOT NULL,
  current_state TEXT DEFAULT 'ACTIVE',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_state (
  key_name TEXT PRIMARY KEY,
  value_string TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_logs (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shows_venue_name ON shows(venue_id, show_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_skybox_listing_id ON listings(skybox_listing_id);
CREATE INDEX IF NOT EXISTS idx_events_showtime ON events(showtime);
CREATE INDEX IF NOT EXISTS idx_events_last_scanned_at ON events(last_scanned_at);
