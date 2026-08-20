-- Seat blocks are ordered physically left-to-right. Loge's low-number aisle
-- block is on the right, so it follows the main block: ["101-119", "1-6"].
-- Balcony and Orchestra Terrace retain their existing aisle-first order.
UPDATE venue_hall_rows
SET metadata_json = json_set(
  COALESCE(metadata_json, '{}'),
  '$.seat_blocks', json_array(
    json_extract(metadata_json, '$.main_range'),
    json_extract(metadata_json, '$.aisle_range')
  )
)
WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:loge'
  AND json_extract(metadata_json, '$.main_range') IS NOT NULL
  AND json_extract(metadata_json, '$.aisle_range') IS NOT NULL;
