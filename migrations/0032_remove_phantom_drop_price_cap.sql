-- Alert on every genuine Phantom drop. The Telegram payload still includes
-- observed price ranges so the operator can decide whether to act.
UPDATE inventory_watch_rules
SET max_price_cents = NULL, updated_at = CURRENT_TIMESTAMP
WHERE venue_id = 'segerstrom_center' AND show_name = 'Phantom of the Opera';
