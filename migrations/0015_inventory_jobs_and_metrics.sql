-- Checkpointed all-inventory work. A venue can have only one running job;
-- expiring leases allow the next cron to safely resume after an interruption.
CREATE TABLE IF NOT EXISTS inventory_jobs (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'paused')),
  remaining_event_ids_json TEXT NOT NULL,
  total_event_count INTEGER NOT NULL,
  completed_event_count INTEGER NOT NULL DEFAULT 0,
  failed_event_count INTEGER NOT NULL DEFAULT 0,
  skipped_event_count INTEGER NOT NULL DEFAULT 0,
  batch_count INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  completed_at DATETIME,
  lease_owner TEXT,
  lease_expires_at DATETIME,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_jobs_one_running_per_venue
  ON inventory_jobs(venue_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_inventory_jobs_venue_status
  ON inventory_jobs(venue_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS inventory_job_batches (
  id TEXT PRIMARY KEY,
  inventory_job_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  batch_number INTEGER NOT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NOT NULL,
  duration_ms INTEGER NOT NULL,
  attempted_event_count INTEGER NOT NULL,
  completed_event_count INTEGER NOT NULL,
  failed_event_count INTEGER NOT NULL,
  skipped_event_count INTEGER NOT NULL,
  remaining_event_count INTEGER NOT NULL,
  FOREIGN KEY (inventory_job_id) REFERENCES inventory_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_job_batches_job_number
  ON inventory_job_batches(inventory_job_id, batch_number);

ALTER TABLE inventory_scans ADD COLUMN inventory_job_id TEXT;
ALTER TABLE inventory_scans ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_scans ADD COLUMN candidate_block_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_inventory_scans_job_scanned
  ON inventory_scans(inventory_job_id, scanned_at DESC);
