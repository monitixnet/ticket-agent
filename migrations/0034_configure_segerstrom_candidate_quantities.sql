-- Evaluate the standard resale quantity packs for Segerstrom Hall. The
-- inventory engine reads this venue-scoped D1 setting at runtime.
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.inventoryTargetQuantities', json('[2,4,6,8,10]')
)
WHERE venue_id = 'segerstrom_center';
