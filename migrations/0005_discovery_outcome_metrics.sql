-- Aggregate source outcomes for testing, audit, and dashboard health checks.
ALTER TABLE discovery_batch_metrics ADD COLUMN outcome_counts_json TEXT NOT NULL DEFAULT '{}';
