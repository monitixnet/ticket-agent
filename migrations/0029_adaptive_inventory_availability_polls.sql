-- Availability-first inventory polling. A lightweight section-availability
-- fingerprint lets unchanged available events skip price and seat-map calls.
ALTER TABLE event_inventory_state ADD COLUMN availability_fingerprint TEXT;
ALTER TABLE event_inventory_state ADD COLUMN last_availability_checked_at DATETIME;
ALTER TABLE event_inventory_state ADD COLUMN last_deep_scan_at DATETIME;

UPDATE event_inventory_state
SET last_availability_checked_at = COALESCE(last_availability_checked_at, last_observed_at),
    last_deep_scan_at = COALESCE(last_deep_scan_at, last_observed_at);

CREATE INDEX IF NOT EXISTS idx_event_inventory_state_polling
  ON event_inventory_state(availability_state, last_availability_checked_at);

-- This is an event-attempt ceiling. Actual work stops earlier at the shared
-- request or runtime safety budget; it is not a fixed six-event batch.
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.inventoryMaxEventsPerRun', 120
)
WHERE venue_id = 'segerstrom_center';
