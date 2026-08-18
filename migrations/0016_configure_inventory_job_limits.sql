UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.inventoryBatchSize', 5,
  '$.inventoryMaxRunDurationMs', 45000,
  '$.dropWatchBatchSize', 12,
  '$.automaticSoldOutIntervalMinutes', 20,
  '$.inventoryTargetQuantities', json('[2,6]')
)
WHERE venue_id = 'segerstrom_center';
