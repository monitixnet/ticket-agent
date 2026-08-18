-- Makes discovery-job progress directly queryable for testing and dashboards.
ALTER TABLE discovery_batch_metrics ADD COLUMN job_run_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_batch_metrics ADD COLUMN estimated_runs_remaining INTEGER NOT NULL DEFAULT 0;
