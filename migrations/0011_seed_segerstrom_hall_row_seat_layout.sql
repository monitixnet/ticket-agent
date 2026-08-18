-- Segerstrom Hall canonical physical seating layout.
-- Source: validated operator transcription of the official seating chart.
-- A seat here means physically present in the hall; it does NOT imply that it
-- is currently sellable for any particular performance.

WITH layouts(section_key, row_label, sort_order, main_start, main_end, aisle_start, aisle_end, notes) AS (
  VALUES
    -- Orchestra (there is intentionally no row I)
    ('orchestra','A',1,1,37,NULL,NULL,NULL), ('orchestra','B',2,1,39,NULL,NULL,NULL),
    ('orchestra','C',3,1,42,NULL,NULL,NULL), ('orchestra','D',4,1,44,NULL,NULL,NULL),
    ('orchestra','E',5,1,48,NULL,NULL,NULL), ('orchestra','F',6,1,50,NULL,NULL,NULL),
    ('orchestra','G',7,1,53,NULL,NULL,NULL), ('orchestra','H',8,1,55,NULL,NULL,NULL),
    ('orchestra','J',9,1,57,NULL,NULL,'No row I'), ('orchestra','K',10,1,45,NULL,NULL,NULL),
    ('orchestra','L',11,1,45,NULL,NULL,NULL), ('orchestra','M',12,1,45,NULL,NULL,NULL),
    ('orchestra','N',13,1,45,NULL,NULL,NULL), ('orchestra','O',14,1,45,NULL,NULL,NULL),
    ('orchestra','P',15,1,44,NULL,NULL,NULL), ('orchestra','Q',16,1,44,NULL,NULL,NULL),
    ('orchestra','R',17,1,44,NULL,NULL,NULL), ('orchestra','S',18,1,44,NULL,NULL,NULL),
    ('orchestra','T',19,1,44,NULL,NULL,NULL), ('orchestra','U',20,1,44,NULL,NULL,NULL),
    ('orchestra','V',21,1,44,NULL,NULL,NULL), ('orchestra','W',22,1,43,NULL,NULL,NULL),
    ('orchestra','X',23,1,41,NULL,NULL,NULL), ('orchestra','Y',24,1,38,NULL,NULL,NULL),
    ('orchestra','Z',25,1,35,NULL,NULL,NULL), ('orchestra','ZZ',26,1,22,NULL,NULL,NULL),
    -- Orchestra Terrace
    ('orchestra terrace','A',1,NULL,NULL,1,6,NULL), ('orchestra terrace','B',2,101,106,1,6,NULL),
    ('orchestra terrace','C',3,101,109,1,6,NULL), ('orchestra terrace','D',4,101,112,1,6,NULL),
    ('orchestra terrace','E',5,101,114,1,6,NULL), ('orchestra terrace','F',6,101,117,1,6,NULL),
    ('orchestra terrace','G',7,101,120,1,6,NULL), ('orchestra terrace','H',8,101,122,1,6,NULL),
    ('orchestra terrace','J',9,101,125,1,5,'No row I'), ('orchestra terrace','K',10,101,127,1,5,NULL),
    ('orchestra terrace','L',11,101,130,1,6,NULL), ('orchestra terrace','M',12,101,133,1,5,NULL),
    ('orchestra terrace','N',13,101,135,1,4,NULL), ('orchestra terrace','O',14,101,138,1,3,NULL),
    ('orchestra terrace','P',15,101,140,1,2,'Aisle seats are shaded/limited view'),
    ('orchestra terrace','Q',16,101,142,NULL,NULL,NULL), ('orchestra terrace','R',17,101,140,NULL,NULL,NULL),
    ('orchestra terrace','S',18,101,140,NULL,NULL,NULL), ('orchestra terrace','T',19,101,141,NULL,NULL,NULL),
    ('orchestra terrace','U',20,101,140,NULL,NULL,NULL), ('orchestra terrace','V',21,101,138,NULL,NULL,NULL),
    ('orchestra terrace','W',22,101,125,NULL,NULL,NULL),
    -- Loge
    ('loge','A',1,101,106,NULL,NULL,NULL), ('loge','B',2,101,107,NULL,NULL,NULL),
    ('loge','C',3,101,108,NULL,NULL,NULL), ('loge','D',4,101,109,NULL,NULL,NULL),
    ('loge','E',5,101,119,1,6,NULL), ('loge','F',6,101,120,1,6,NULL),
    ('loge','G',7,101,123,1,6,NULL), ('loge','H',8,101,126,1,6,NULL),
    ('loge','J',9,101,129,1,6,'No row I'), ('loge','K',10,101,139,NULL,NULL,NULL),
    ('loge','L',11,101,137,NULL,NULL,NULL), ('loge','M',12,101,135,NULL,NULL,NULL),
    ('loge','N',13,101,132,NULL,NULL,NULL), ('loge','O',14,101,130,NULL,NULL,NULL),
    ('loge','P',15,101,127,NULL,NULL,NULL), ('loge','Q',16,101,124,NULL,NULL,NULL),
    ('loge','R',17,101,121,NULL,NULL,NULL), ('loge','S',18,101,119,NULL,NULL,NULL),
    ('loge','T',19,101,116,NULL,NULL,NULL), ('loge','U',20,101,113,NULL,NULL,NULL),
    ('loge','V',21,101,108,NULL,NULL,NULL),
    -- Balcony (there is intentionally no row I or M)
    ('balcony','A',1,101,106,NULL,NULL,NULL), ('balcony','B',2,101,107,NULL,NULL,NULL),
    ('balcony','C',3,101,108,NULL,NULL,NULL), ('balcony','D',4,101,109,NULL,NULL,NULL),
    ('balcony','E',5,101,110,NULL,NULL,NULL), ('balcony','F',6,101,111,NULL,NULL,NULL),
    ('balcony','G',7,101,126,1,4,NULL), ('balcony','H',8,101,128,1,5,NULL),
    ('balcony','J',9,101,131,1,5,'No row I'), ('balcony','K',10,101,135,1,5,NULL),
    ('balcony','L',11,101,139,1,5,'No row M'), ('balcony','N',12,101,138,NULL,NULL,NULL),
    ('balcony','O',13,101,145,NULL,NULL,NULL), ('balcony','P',14,101,143,NULL,NULL,NULL),
    ('balcony','Q',15,101,141,NULL,NULL,NULL), ('balcony','R',16,101,138,NULL,NULL,NULL),
    ('balcony','S',17,101,136,NULL,NULL,NULL), ('balcony','T',18,101,133,NULL,NULL,NULL),
    ('balcony','U',19,101,130,NULL,NULL,NULL), ('balcony','V',20,101,128,NULL,NULL,NULL),
    ('balcony','W',21,101,126,NULL,NULL,NULL)
)
INSERT OR IGNORE INTO venue_hall_rows (id, section_id, row_label, sort_order, metadata_json)
SELECT
  venue_hall_sections.id || ':row:' || lower(layouts.row_label), venue_hall_sections.id, layouts.row_label, layouts.sort_order,
  json_object('source','validated_operator_transcription','main_range',
    CASE WHEN main_start IS NULL THEN NULL ELSE printf('%d-%d', main_start, main_end) END,
    'aisle_range', CASE WHEN aisle_start IS NULL THEN NULL ELSE printf('%d-%d', aisle_start, aisle_end) END,
    'notes', notes)
FROM layouts
JOIN venue_hall_sections ON venue_hall_sections.venue_hall_id = 'segerstrom_center:hall:segerstrom%20hall'
  AND venue_hall_sections.canonical_name = layouts.section_key;

-- Populate seats from the explicit ranges. Two blocks in a row remain distinct
-- in metadata even where their numeric labels are far apart.
WITH layouts(section_key, row_label, main_start, main_end, aisle_start, aisle_end) AS (
  VALUES
    ('orchestra','A',1,37,NULL,NULL),('orchestra','B',1,39,NULL,NULL),('orchestra','C',1,42,NULL,NULL),('orchestra','D',1,44,NULL,NULL),('orchestra','E',1,48,NULL,NULL),('orchestra','F',1,50,NULL,NULL),('orchestra','G',1,53,NULL,NULL),('orchestra','H',1,55,NULL,NULL),('orchestra','J',1,57,NULL,NULL),('orchestra','K',1,45,NULL,NULL),('orchestra','L',1,45,NULL,NULL),('orchestra','M',1,45,NULL,NULL),('orchestra','N',1,45,NULL,NULL),('orchestra','O',1,45,NULL,NULL),('orchestra','P',1,44,NULL,NULL),('orchestra','Q',1,44,NULL,NULL),('orchestra','R',1,44,NULL,NULL),('orchestra','S',1,44,NULL,NULL),('orchestra','T',1,44,NULL,NULL),('orchestra','U',1,44,NULL,NULL),('orchestra','V',1,44,NULL,NULL),('orchestra','W',1,43,NULL,NULL),('orchestra','X',1,41,NULL,NULL),('orchestra','Y',1,38,NULL,NULL),('orchestra','Z',1,35,NULL,NULL),('orchestra','ZZ',1,22,NULL,NULL),
    ('orchestra terrace','A',NULL,NULL,1,6),('orchestra terrace','B',101,106,1,6),('orchestra terrace','C',101,109,1,6),('orchestra terrace','D',101,112,1,6),('orchestra terrace','E',101,114,1,6),('orchestra terrace','F',101,117,1,6),('orchestra terrace','G',101,120,1,6),('orchestra terrace','H',101,122,1,6),('orchestra terrace','J',101,125,1,5),('orchestra terrace','K',101,127,1,5),('orchestra terrace','L',101,130,1,6),('orchestra terrace','M',101,133,1,5),('orchestra terrace','N',101,135,1,4),('orchestra terrace','O',101,138,1,3),('orchestra terrace','P',101,140,1,2),('orchestra terrace','Q',101,142,NULL,NULL),('orchestra terrace','R',101,140,NULL,NULL),('orchestra terrace','S',101,140,NULL,NULL),('orchestra terrace','T',101,141,NULL,NULL),('orchestra terrace','U',101,140,NULL,NULL),('orchestra terrace','V',101,138,NULL,NULL),('orchestra terrace','W',101,125,NULL,NULL),
    ('loge','A',101,106,NULL,NULL),('loge','B',101,107,NULL,NULL),('loge','C',101,108,NULL,NULL),('loge','D',101,109,NULL,NULL),('loge','E',101,119,1,6),('loge','F',101,120,1,6),('loge','G',101,123,1,6),('loge','H',101,126,1,6),('loge','J',101,129,1,6),('loge','K',101,139,NULL,NULL),('loge','L',101,137,NULL,NULL),('loge','M',101,135,NULL,NULL),('loge','N',101,132,NULL,NULL),('loge','O',101,130,NULL,NULL),('loge','P',101,127,NULL,NULL),('loge','Q',101,124,NULL,NULL),('loge','R',101,121,NULL,NULL),('loge','S',101,119,NULL,NULL),('loge','T',101,116,NULL,NULL),('loge','U',101,113,NULL,NULL),('loge','V',101,108,NULL,NULL),
    ('balcony','A',101,106,NULL,NULL),('balcony','B',101,107,NULL,NULL),('balcony','C',101,108,NULL,NULL),('balcony','D',101,109,NULL,NULL),('balcony','E',101,110,NULL,NULL),('balcony','F',101,111,NULL,NULL),('balcony','G',101,126,1,4),('balcony','H',101,128,1,5),('balcony','J',101,131,1,5),('balcony','K',101,135,1,5),('balcony','L',101,139,1,5),('balcony','N',101,138,NULL,NULL),('balcony','O',101,145,NULL,NULL),('balcony','P',101,143,NULL,NULL),('balcony','Q',101,141,NULL,NULL),('balcony','R',101,138,NULL,NULL),('balcony','S',101,136,NULL,NULL),('balcony','T',101,133,NULL,NULL),('balcony','U',101,130,NULL,NULL),('balcony','V',101,128,NULL,NULL),('balcony','W',101,126,NULL,NULL)
), blocks AS (
  SELECT section_key,row_label,main_start AS first_seat,main_end AS last_seat,'main' AS block_type FROM layouts WHERE main_start IS NOT NULL
  UNION ALL
  SELECT section_key,row_label,aisle_start,aisle_end,'aisle' FROM layouts WHERE aisle_start IS NOT NULL
), numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 145)
INSERT OR IGNORE INTO venue_hall_seats (id, row_id, seat_label, seat_number, metadata_json)
SELECT r.id || ':seat:' || numbers.n, r.id, CAST(numbers.n AS TEXT), numbers.n,
       json_object('source','validated_operator_transcription','block_type',blocks.block_type)
FROM blocks
JOIN venue_hall_sections s ON s.venue_hall_id = 'segerstrom_center:hall:segerstrom%20hall' AND s.canonical_name = blocks.section_key
JOIN venue_hall_rows r ON r.section_id = s.id AND r.row_label = blocks.row_label
JOIN numbers ON numbers.n BETWEEN blocks.first_seat AND blocks.last_seat;

UPDATE venue_halls
SET metadata_json = json_set(metadata_json,
  '$.row_seat_validation_status', 'operator_transcribed',
  '$.row_seat_layout_source', 'validated operator transcription supplied 2026-08-17')
WHERE id = 'segerstrom_center:hall:segerstrom%20hall';
