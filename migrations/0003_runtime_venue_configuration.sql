-- Runtime control plane. Secret values remain in Worker secret bindings; this
-- table stores only their names/references.
CREATE TABLE IF NOT EXISTS venue_runtime_configs (
  venue_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'active', 'paused')) DEFAULT 'draft',
  config_json TEXT NOT NULL,
  credential_refs_json TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_venue_runtime_configs_status ON venue_runtime_configs(status);

-- Initial non-secret Segerstrom adapter. Set ALGOLIA_SEGERSTROM_API_KEY as a
-- Worker secret before changing this row to active in a new environment.
INSERT OR IGNORE INTO venues (id, name, state_code, timezone_name, security_tier)
VALUES ('segerstrom_center', 'Segerstrom Center for the Arts', 'CA', 'America/Los_Angeles', 'high');

INSERT OR IGNORE INTO venue_runtime_configs (venue_id, status, config_json, credential_refs_json)
VALUES (
  'segerstrom_center', 'active',
  '{"discoveryStrategy":"segerstromProductionDiscovery","inventoryStrategy":"segerstromDrillDown","urlPattern":"https://www.scfta.org/shows-events","buyButtonApiUrl":"https://www.scfta.org/BuyButton/ButtonById","settingsApiUrlPattern":"https://seatme.scfta.org/api/settings/performance/{performanceId}","inventoryApiUrlPattern":"https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}","seatInfoApiUrlPattern":"https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId={groupId}&performanceId={performanceId}","priceApiUrlPattern":"https://seatme.scfta.org/api/pricing/performance/{performanceId}","ticketingUrlTemplate":"https://seatme.scfta.org/single?id={performanceId}","ticketingUrlPattern":"https://seatme.scfta.org/single\\?id=\\d+","performanceIdParam":"id","algoliaAppId":"12REW53NEL","algoliaIndexName":"prod_scfta_calendar","discoveryBatchSize":30,"baseIntervalMs":120000,"maxIntervalMs":600000,"inventoryBufferBlockCount":2}',
  '{"algoliaApiKey":"ALGOLIA_SEGERSTROM_API_KEY"}'
);
