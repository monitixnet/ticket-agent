-- Drop-watch priority is always venue-scoped through inventory_watch_rules.
-- New sold-out events with no explicit rule default to medium in the selector.
ALTER TABLE inventory_watch_rules ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'
  CHECK(priority IN ('critical', 'high', 'medium', 'low'));

UPDATE inventory_watch_rules
SET priority = 'critical', updated_at = CURRENT_TIMESTAMP
WHERE venue_id = 'segerstrom_center' AND show_name = 'Phantom of the Opera';

UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.dropWatchBatchSize', 20,
  '$.dropWatchIntervalsMinutes', json('{"critical":5,"high":10,"medium":30,"low":60}')
)
WHERE venue_id = 'segerstrom_center';
