-- Verified from Segerstrom's official seating-chart PDF. Row and seat records
-- are intentionally not inferred from the raster image; they require a
-- validated extraction or a structured venue layout source.
INSERT OR IGNORE INTO venue_halls (
  id, venue_id, canonical_name, display_name, seating_layout_key, status, metadata_json
) VALUES (
  'segerstrom_center:hall:segerstrom%20hall',
  'segerstrom_center',
  'segerstrom hall',
  'Segerstrom Hall',
  'scfta-segerstrom-hall',
  'validated',
  '{"layout_source":"https://www.scfta.org/segerstrom/media/SCFTA/About%20Us/Seating%20Charts/segerstromhallseating.pdf","layout_source_type":"official_pdf","row_seat_validation_status":"pending"}'
);

INSERT OR IGNORE INTO venue_hall_sections (id, venue_hall_id, canonical_name, display_name, sort_order) VALUES
  ('segerstrom_center:hall:segerstrom%20hall:section:orchestra', 'segerstrom_center:hall:segerstrom%20hall', 'orchestra', 'Orchestra', 1),
  ('segerstrom_center:hall:segerstrom%20hall:section:orchestra%20terrace', 'segerstrom_center:hall:segerstrom%20hall', 'orchestra terrace', 'Orchestra Terrace', 2),
  ('segerstrom_center:hall:segerstrom%20hall:section:loge', 'segerstrom_center:hall:segerstrom%20hall', 'loge', 'Loge', 3),
  ('segerstrom_center:hall:segerstrom%20hall:section:balcony', 'segerstrom_center:hall:segerstrom%20hall', 'balcony', 'Balcony', 4);
