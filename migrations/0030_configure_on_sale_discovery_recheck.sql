-- On-sale productions remain in inventory monitoring, but discovery must also
-- refresh their performance catalog often enough to detect date, hall, and
-- status changes. This is venue-scoped and does not affect other venues.
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.discoveryRecheckMinutes', json('{"on_sale":60}')
)
WHERE venue_id = 'segerstrom_center';
