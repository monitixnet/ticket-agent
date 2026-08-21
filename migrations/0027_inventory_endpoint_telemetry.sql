CREATE TABLE IF NOT EXISTS inventory_endpoint_telemetry (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  inventory_job_id TEXT,
  endpoint_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  content_type TEXT,
  redirect_detected INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  observed_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_endpoint_telemetry_job_observed
  ON inventory_endpoint_telemetry(inventory_job_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_endpoint_telemetry_venue_endpoint_observed
  ON inventory_endpoint_telemetry(venue_id, endpoint_type, observed_at DESC);
