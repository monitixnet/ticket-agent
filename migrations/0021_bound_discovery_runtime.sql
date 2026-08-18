-- Keep a discovery checkpoint safely inside a Worker invocation. With jitter
-- removed, ten production API checks leave headroom for real network latency.
UPDATE venue_runtime_configs
SET config_json = json_set(config_json, '$.discoveryBatchSize', 10)
WHERE venue_id = 'segerstrom_center';
