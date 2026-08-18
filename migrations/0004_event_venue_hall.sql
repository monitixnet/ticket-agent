-- Supports event refreshes when a venue changes a performance hall/location.
ALTER TABLE events ADD COLUMN venue_hall TEXT;
