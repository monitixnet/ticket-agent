-- Remove historical duplicate event IDs such as "30587.0" once their
-- canonical integer-string event ID ("30587") exists. New discovery writes
-- normalize IDs before persistence; this migration repairs older rows only.
--
-- Keep any decimal-suffixed row that has no canonical counterpart. That is
-- safer than guessing that two unrelated external identifiers are equivalent.

UPDATE listings
SET event_id = substr(event_id, 1, length(event_id) - 2)
WHERE substr(event_id, -2) = '.0'
  AND EXISTS (
    SELECT 1
    FROM events canonical_event
    WHERE canonical_event.id = substr(listings.event_id, 1, length(listings.event_id) - 2)
  );

DELETE FROM events
WHERE substr(id, -2) = '.0'
  AND EXISTS (
    SELECT 1
    FROM events canonical_event
    WHERE canonical_event.id = substr(events.id, 1, length(events.id) - 2)
  );
