-- Initial production rollout: persist and monitor Segerstrom Hall only.
UPDATE venue_runtime_configs
SET config_json = json_set(COALESCE(config_json, '{}'), '$.discoveryAllowedHalls', json_array('Segerstrom Hall'))
WHERE venue_id = 'segerstrom_center';
