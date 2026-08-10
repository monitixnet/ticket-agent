INSERT OR IGNORE INTO venues (id, name, state_code, timezone_name, security_tier) VALUES
  ('segerstrom_center', 'Segerstrom Center for the Arts', 'CA', 'America/Los_Angeles', 'high'),
  ('citizen_opera_house', 'Citizen Opera House', 'MA', 'America/New_York', 'medium'),
  ('grand_ole_opry', 'Grand Ole Opry', 'TN', 'America/Chicago', 'medium'),
  ('asu_gammage', 'ASU Gammage', 'AZ', 'America/Phoenix', 'medium'),
  ('first_interstate_center_for_the_arts', 'First Interstate Center for the Arts', 'WA', 'America/Los_Angeles', 'medium'),
  ('orpheum_minneapolis', 'Orpheum Theatre Minneapolis', 'MN', 'America/Chicago', 'medium'),
  ('orpheum_san_francisco', 'Orpheum Theatre San Francisco', 'CA', 'America/Los_Angeles', 'medium'),
  ('paramount_theatre_seattle', 'Paramount Theatre Seattle', 'WA', 'America/Los_Angeles', 'medium'),
  ('aronoff_center', 'Aronoff Center', 'OH', 'America/New_York', 'medium'),
  ('broadway_com', 'Broadway.com', 'NY', 'America/New_York', 'medium'),
  ('broadwaydirect_com', 'BroadwayDirect.com', 'NY', 'America/New_York', 'medium');

INSERT OR IGNORE INTO system_state (key_name, value_string) VALUES
  ('tracked_venues_seeded', 'true');
