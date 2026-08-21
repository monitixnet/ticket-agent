-- Six events normally use 42 Segerstrom API requests (three shared endpoints
-- plus four seat-group endpoints per event). Keep one request below the
-- Cloudflare 50-subrequest ceiling and retain the existing 45-second limit.
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.inventoryBatchSize', 6,
  '$.inventoryExternalRequestBudget', 48
)
WHERE venue_id = 'segerstrom_center';
