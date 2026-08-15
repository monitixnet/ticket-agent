export const DEFAULT_BUSINESS_HOURS = {
  start: { hour: 7, minute: 30 }, // 7:30 AM
  end: { hour: 23, minute: 59 }, // 10:30 PM
};

const VENUE_MASTER_LIST = [
  { id: "segerstrom_center", name: "Segerstrom Center for the Arts", stateCode: "CA", timezoneName: "America/Los_Angeles", securityTier: "high", active: true, discoveryStrategy: "segerstromProductionDiscovery", inventoryStrategy: "segerstromDrillDown", fetchProvider: "zenrows_browser", algoliaAppId: "12REW53NEL", algoliaApiKey: "48f45be4ee8cf2996f1ae593bbd94454", algoliaIndexName: "prod_scfta_calendar", settingsApiUrlPattern: "https://seatme.scfta.org/api/settings/performance/{performanceId}", inventoryApiUrlPattern: "https://seatme.scfta.org/api/sectionAvailability/performance/{performanceId}", seatInfoApiUrlPattern: "https://seatme.scfta.org/api/seatinfo/sectiongroup?groupId={groupId}&performanceId={performanceId}", priceApiUrlPattern: "https://seatme.scfta.org/api/pricing/performance/{performanceId}", urlPattern: "https://www.scfta.org/shows-events", buyButtonApiUrl: 'https://www.scfta.org/BuyButton/ButtonById', buyButtonsApiUrl: 'https://www.scfta.org/BuyButton/ButtonsById', ticketingUrlPattern: "https://seatme.scfta.org/single\\?id=\\d+", ticketingUrlTemplate: "https://seatme.scfta.org/single?id={performanceId}", ticketingLinkText: "Buy now", performanceIdParam: "id", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "citizen_opera_house", name: "Citizen Opera House", stateCode: "MA", timezoneName: "America/New_York", securityTier: "medium", active: true, parseStrategy: "multiStepApiDiscovery", urlPattern: "https://www.citizenoperahouse.com/events/*", ticketingLinkText: "Buy Tickets", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "asu_gammage", name: "ASU Gammage", stateCode: "AZ", timezoneName: "America/Phoenix", securityTier: "medium", active: true, parseStrategy: "singleStep", urlPattern: "https://www.asugammage.com/shows-events", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "first_interstate_center_for_the_arts", name: "First Interstate Center for the Arts", stateCode: "WA", timezoneName: "America/Los_Angeles", securityTier: "medium", active: true, parseStrategy: "singleStep", urlPattern: "https://www.firstinterstatecenter.org/events-tickets/calendar", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "orpheum_minneapolis", name: "Orpheum Theatre Minneapolis", stateCode: "MN", timezoneName: "America/Chicago", securityTier: "medium", active: true, parseStrategy: "singleStep", urlPattern: "https://minneapolis.broadway.com/shows/", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "orpheum_san_francisco", name: "Orpheum Theatre San Francisco", stateCode: "CA", timezoneName: "America/Los_Angeles", securityTier: "medium", active: true, parseStrategy: "singleStep", urlPattern: "https://sanfrancisco.broadway.com/shows/", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "paramount_theatre_seattle", name: "Paramount Theatre Seattle", stateCode: "WA", timezoneName: "America/Los_Angeles", securityTier: "medium", active: true, parseStrategy: "singleStep", urlPattern: "https://seattle.broadway.com/shows/", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "aronoff_center", name: "Aronoff Center", stateCode: "OH", timezoneName: "America/New_York", securityTier: "medium", active: true, parseStrategy: "singleStep", urlPattern: "https://www.cincinnatiarts.org/events/calendar", smokeChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"] },
  // { id: "grand_ole_opry", name: "Grand Ole Opry", stateCode: "TN", timezoneName: "America/Chicago", securityTier: "low", active: false, reason: "Excluded from active validation set for this release.", urlPattern: null, smokeChecks: [] },
  // { id: "broadway_com", name: "Broadway.com", stateCode: "NY", timezoneName: "America/New_York", securityTier: "low", active: false, reason: "Excluded from active validation set for this release.", urlPattern: null, smokeChecks: [] },
  // { id: "broadwaydirect_com", name: "BroadwayDirect.com", stateCode: "NY", timezoneName: "America/New_York", securityTier: "low", active: false, reason: "Excluded from active validation set for this release.", urlPattern: null, smokeChecks: [] }
];

function generateVenuePolicyMap() {
  const map = {};
  for (const venue of VENUE_MASTER_LIST) {
    map[venue.id] = {
      venueId: venue.id,
      venueName: venue.name,
      stateCode: venue.stateCode,
      timezoneName: venue.timezoneName,
      active: venue.active,
      enabled: venue.active,
      securityTier: venue.securityTier,
      baseIntervalMs: venue.active ? 120000 : 0,
      maxIntervalMs: venue.active ? 600000 : 0,
      sourcePolicy: venue.active ? "venue_specific" : "excluded_release",
      excluded: !venue.active,
      reason: venue.reason || null
    };
  }
  return Object.freeze(map);
}

function generateActiveVenueAdapters() {
  const adapters = {};
  for (const venue of VENUE_MASTER_LIST.filter(v => v.active)) {
    adapters[venue.id] = {
      venueId: venue.id,
      venueName: venue.name,
      timezoneName: venue.timezoneName,
      securityTier: venue.securityTier,
      sourceAdapter: "venue_specific",
      adapterType: "venue_specific_event_page",
      urlPattern: venue.urlPattern,
      fetchProvider: venue.fetchProvider || null,
      ticketingUrlPattern: venue.ticketingUrlPattern || null,
      ticketingLinkText: venue.ticketingLinkText || null,
      ticketingUrlTemplate: venue.ticketingUrlTemplate || null,
      performanceIdParam: venue.performanceIdParam || null,
      buyButtonApiUrl: venue.buyButtonApiUrl || null,
      buyButtonsApiUrl: venue.buyButtonsApiUrl || null,
      inventoryApiUrlPattern: venue.inventoryApiUrlPattern || null,
      settingsApiUrlPattern: venue.settingsApiUrlPattern || null,
      algoliaAppId: venue.algoliaAppId || null,
      algoliaApiKey: venue.algoliaApiKey || null,
      algoliaIndexName: venue.algoliaIndexName || null,
      seatInfoApiUrlPattern: venue.seatInfoApiUrlPattern || null,
      priceApiUrlPattern: venue.priceApiUrlPattern || null,
      requiredInventoryFields: ["section", "row", "seat", "priceLevel", "seatQuality", "eventId"],
      normalizationRules: ["normalize_section_labels", "normalize_row_labels", "normalize_seat_labels", "normalize_price_levels"],
      discoveryStrategy: venue.discoveryStrategy || venue.parseStrategy,
      inventoryStrategy: venue.inventoryStrategy || venue.parseStrategy,
      smokeChecks: venue.smokeChecks || [],
      listingApprovalAllowed: false,
      monitoringOnly: true,
      active: true
    };
  }
  return Object.freeze(adapters);
}

export const ACTIVE_VENUE_SET = Object.freeze(VENUE_MASTER_LIST.filter(v => v.active).map(v => v.id));

export const ACTIVE_VENUE_ADAPTERS = generateActiveVenueAdapters();

function generateSmokeMatrix() {
  return Object.freeze(VENUE_MASTER_LIST.filter(v => v.active).map(venue => ({
    venueId: venue.id,
    venueName: venue.name,
    timezoneName: venue.timezoneName,
    sourceAdapter: "venue_specific",
    listingApprovalAllowed: false,
    outboundApprovalEnabled: false,
    monitoringOnly: true,
    active: true,
    businessHours: { start: `${DEFAULT_BUSINESS_HOURS.start.hour}:${String(DEFAULT_BUSINESS_HOURS.start.minute).padStart(2, '0')}`, end: `${DEFAULT_BUSINESS_HOURS.end.hour}:${String(DEFAULT_BUSINESS_HOURS.end.minute).padStart(2, '0')}` },
    expectedChecks: ["time_window", "section_parity", "price_parity", "fresh_snapshot", "3x_coverage"],
    notes: `Monitoring-only validation for ${venue.name}.`
  })));
}

export const ACTIVE_VENUE_SMOKE_MATRIX = generateSmokeMatrix();

export const VENUE_POLICY_MAP = generateVenuePolicyMap();

export const MONITORED_TARGETS = Object.freeze(
  VENUE_MASTER_LIST.filter(v => v.active).map(({ id, name, stateCode, securityTier }) => ({ id, name, state_code: stateCode, security_tier: securityTier, sources: ["venue_specific"] }))
);
