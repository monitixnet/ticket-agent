-- Existing databases already applied the original watch seed/configuration.
-- Bring their drop-detection cadence to five minutes as well.
UPDATE inventory_watch_rules
SET scan_interval_minutes = 5, updated_at = CURRENT_TIMESTAMP
WHERE id = 'segerstrom_center:watch:phantom-of-the-opera';

UPDATE venue_runtime_configs
SET config_json = json_set(config_json, '$.automaticSoldOutIntervalMinutes', 5)
WHERE venue_id = 'segerstrom_center';
