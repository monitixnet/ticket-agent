ALTER TABLE inventory_watch_rules ADD COLUMN max_price_cents INTEGER
  CHECK(max_price_cents IS NULL OR max_price_cents >= 0);

-- Phantom drops are actionable only at $170.00 or less.
UPDATE inventory_watch_rules
SET max_price_cents = 17000, updated_at = CURRENT_TIMESTAMP
WHERE id = 'segerstrom_center:watch:phantom-of-the-opera';
