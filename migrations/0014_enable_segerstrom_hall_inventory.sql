-- Initial inventory rollout: only Segerstrom Hall has validated fixed-seat
-- metadata. All other discovered halls remain discovery-only by default.
UPDATE venue_halls
SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.inventory_enabled', true)
WHERE id = 'segerstrom_center:hall:segerstrom%20hall';
