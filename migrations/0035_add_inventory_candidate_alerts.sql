-- Candidate notifications are venue-scoped through their event. They are
-- deduplicated by the event's current actionable-candidate fingerprint.
CREATE TABLE IF NOT EXISTS inventory_candidate_alert_state (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  candidate_fingerprint TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  last_notified_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_candidate_alerts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL REFERENCES inventory_scans(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed', 'obsolete')),
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at DATETIME,
  delivered_at DATETIME,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_candidate_alerts_due
  ON inventory_candidate_alerts(status, next_attempt_at, created_at);
