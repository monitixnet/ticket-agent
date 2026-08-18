-- 0016 was already applied in existing local environments. Persist the new
-- priority-watch limits in the runtime control plane for those databases too.
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.dropWatchBatchSize', 12,
  '$.automaticSoldOutIntervalMinutes', 20
)
WHERE venue_id = 'segerstrom_center';
