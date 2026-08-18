-- Durable time-series records for the discovery dashboard.
CREATE TABLE IF NOT EXISTS discovery_batch_metrics (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NOT NULL,
  duration_ms INTEGER NOT NULL,
  processed_production_count INTEGER NOT NULL,
  discovered_event_count INTEGER NOT NULL,
  inserted_event_count INTEGER NOT NULL,
  failed_production_count INTEGER NOT NULL DEFAULT 0,
  remaining_production_count INTEGER NOT NULL,
  total_production_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_metrics_venue_completed
  ON discovery_batch_metrics(venue_id, completed_at DESC);
