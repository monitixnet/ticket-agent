-- Availability priority is venue-scoped. Segerstrom Hall has a validated
-- fixed-seat map, so its event-level availability can be compared with the
-- mapped hall capacity without guessing from a partial seat response.
ALTER TABLE event_inventory_state ADD COLUMN capacity_seat_count INTEGER
  CHECK(capacity_seat_count IS NULL OR capacity_seat_count > 0);
ALTER TABLE event_inventory_state ADD COLUMN available_percentage_basis_points INTEGER
  CHECK(available_percentage_basis_points IS NULL
    OR available_percentage_basis_points BETWEEN 0 AND 10000);

-- Keep this physical capacity derived from the validated seat records rather
-- than a manually copied number. Other halls remain NULL and fail closed.
UPDATE venue_halls
SET capacity = (
  SELECT COUNT(*)
  FROM venue_hall_seats seat
  JOIN venue_hall_rows row ON row.id = seat.row_id
  JOIN venue_hall_sections section ON section.id = row.section_id
  WHERE section.venue_hall_id = venue_halls.id
)
WHERE venue_id = 'segerstrom_center'
  AND canonical_name = 'segerstrom hall'
  AND EXISTS (
    SELECT 1
    FROM venue_hall_seats seat
    JOIN venue_hall_rows row ON row.id = seat.row_id
    JOIN venue_hall_sections section ON section.id = row.section_id
    WHERE section.venue_hall_id = venue_halls.id
  );

-- At <=10% available, monitor every five minutes. At >=80% available,
-- monitor weekly. These are monitoring cadences, not automatic purchase or
-- listing decisions. A true drop alert still requires sold_out -> available.
UPDATE venue_runtime_configs
SET config_json = json_set(
  COALESCE(config_json, '{}'),
  '$.availabilityPriorityPolicy', json('{"enabled":true,"criticalMaxAvailableBasisPoints":1000,"lowMinAvailableBasisPoints":8000}'),
  '$.dropWatchIntervalsMinutes.low', 10080
)
WHERE venue_id = 'segerstrom_center';
