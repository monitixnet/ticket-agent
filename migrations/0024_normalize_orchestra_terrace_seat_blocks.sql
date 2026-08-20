-- Orchestra Terrace rows B-P each contain two disjoint physical seat blocks.
-- Preserve both blocks explicitly for seating-chart review and future venue
-- adapters; do not infer a false continuous range from 1 through 101+.
WITH row_blocks(row_label, aisle_range, main_range) AS (
  VALUES
    ('B', '1-6', '101-106'), ('C', '1-6', '101-109'),
    ('D', '1-6', '101-112'), ('E', '1-6', '101-114'),
    ('F', '1-6', '101-117'), ('G', '1-6', '101-120'),
    ('H', '1-6', '101-122'), ('J', '1-5', '101-125'),
    ('K', '1-5', '101-127'), ('L', '1-6', '101-130'),
    ('M', '1-5', '101-133'), ('N', '1-4', '101-135'),
    ('O', '1-3', '101-138'), ('P', '1-2', '101-140')
)
UPDATE venue_hall_rows
SET metadata_json = json_set(
  COALESCE(metadata_json, '{}'),
  '$.seat_blocks', json_array(
    (SELECT aisle_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label),
    (SELECT main_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label)
  ),
  '$.aisle_range', (SELECT aisle_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label),
  '$.main_range', (SELECT main_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label)
)
WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:orchestra%20terrace'
  AND row_label IN (SELECT row_label FROM row_blocks);

-- Loge rows E-J also have separate low-number aisle blocks.
WITH row_blocks(row_label, aisle_range, main_range) AS (
  VALUES
    ('E', '1-6', '101-119'), ('F', '1-6', '101-120'),
    ('G', '1-6', '101-123'), ('H', '1-6', '101-126'),
    ('J', '1-6', '101-129')
)
UPDATE venue_hall_rows
SET metadata_json = json_set(
  COALESCE(metadata_json, '{}'),
  '$.seat_blocks', json_array(
    (SELECT aisle_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label),
    (SELECT main_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label)
  ),
  '$.physical_aisle_side', 'right',
  '$.aisle_range', (SELECT aisle_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label),
  '$.main_range', (SELECT main_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label)
)
WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:loge'
  AND row_label IN (SELECT row_label FROM row_blocks);

UPDATE venue_hall_seats
SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.physical_aisle_side', 'right')
WHERE row_id IN (
  SELECT id FROM venue_hall_rows
  WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:loge'
    AND row_label IN ('E', 'F', 'G', 'H', 'J')
)
  AND seat_number BETWEEN 1 AND 6;

-- Balcony rows G-L have separate low-number aisle blocks. Balcony Row M is
-- a verified left-side aisle-only block between L and N, not an omitted row.
WITH row_blocks(row_label, aisle_range, main_range) AS (
  VALUES
    ('G', '1-4', '101-126'), ('H', '1-5', '101-128'),
    ('J', '1-5', '101-131'), ('K', '1-5', '101-135'),
    ('L', '1-5', '101-139')
)
UPDATE venue_hall_rows
SET metadata_json = json_set(
  COALESCE(metadata_json, '{}'),
  '$.seat_blocks', json_array(
    (SELECT aisle_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label),
    (SELECT main_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label)
  ),
  '$.physical_aisle_side', 'left',
  '$.aisle_range', (SELECT aisle_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label),
  '$.main_range', (SELECT main_range FROM row_blocks WHERE row_label = venue_hall_rows.row_label)
)
WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:balcony'
  AND row_label IN (SELECT row_label FROM row_blocks);

UPDATE venue_hall_seats
SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.physical_aisle_side', 'left')
WHERE row_id IN (
  SELECT id FROM venue_hall_rows
  WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:balcony'
    AND row_label IN ('G', 'H', 'J', 'K', 'L')
)
  AND seat_number BETWEEN 1 AND 5;

UPDATE venue_hall_rows
SET sort_order = sort_order + 1
WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:balcony'
  AND sort_order >= 12;

UPDATE venue_hall_rows
SET metadata_json = json_remove(COALESCE(metadata_json, '{}'), '$.notes')
WHERE section_id = 'segerstrom_center:hall:segerstrom%20hall:section:balcony'
  AND row_label = 'L';

INSERT INTO venue_hall_rows (id, section_id, row_label, sort_order, metadata_json)
VALUES (
  'segerstrom_center:hall:segerstrom%20hall:section:balcony:row:m',
  'segerstrom_center:hall:segerstrom%20hall:section:balcony',
  'M',
  12,
  json_object(
    'source', 'validated_operator_transcription',
    'seat_blocks', json_array('1-9'),
    'physical_aisle_side', 'left',
    'aisle_range', '1-9',
    'main_range', NULL,
    'notes', 'Left-side aisle block only; validated operator correction'
  )
)
ON CONFLICT(section_id, row_label) DO UPDATE SET
  sort_order = excluded.sort_order,
  metadata_json = excluded.metadata_json;

WITH RECURSIVE seat_numbers(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seat_numbers WHERE n < 9
)
INSERT OR IGNORE INTO venue_hall_seats (id, row_id, seat_label, seat_number, quality_zone, metadata_json)
SELECT
  'segerstrom_center:hall:segerstrom%20hall:section:balcony:row:m:seat:' || n,
  'segerstrom_center:hall:segerstrom%20hall:section:balcony:row:m',
  CAST(n AS TEXT),
  n,
  'not_applicable',
  json_object('source', 'validated_operator_transcription', 'block_type', 'aisle', 'physical_aisle_side', 'left')
FROM seat_numbers;
