UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.apiFetchProviderPool', json('["native"]'),
  '$.fetchProviderPool', json('["native"]'),
  '$.discoveryMaxPages', 30,
  '$.debugTelemetryEnabled', 0,
  '$.debugNotificationsEnabled', 0,
  '$.allowSkyboxListing', 0,
  '$.enableAutomatedApproval', 0
)
WHERE venue_id = 'segerstrom_center';
