-- Broad inventory must use the latest discovery classification, not merely a
-- future showtime. Existing rows begin unknown and are eligible only after a
-- fresh discovery confirms they are on sale or sold out.
ALTER TABLE events ADD COLUMN source_production_id TEXT;
ALTER TABLE events ADD COLUMN discovery_outcome TEXT NOT NULL DEFAULT 'unknown'
  CHECK(discovery_outcome IN ('on_sale', 'sold_out', 'future_sale', 'past', 'not_on_sale', 'free_no_tickets', 'settings_unavailable', 'unknown', 'error'));
ALTER TABLE events ADD COLUMN discovery_status_checked_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_events_inventory_eligibility
  ON events(show_id, discovery_outcome, showtime);
