-- Venue runtime policy: target block plus this many qualifying backup blocks.
-- Segerstrom starts with two backups (the original 3x total-block policy).
UPDATE venue_runtime_configs
SET config_json = json_set(config_json, '$.inventoryBufferBlockCount', 2)
WHERE venue_id = 'segerstrom_center'
  AND json_extract(config_json, '$.inventoryBufferBlockCount') IS NULL;
