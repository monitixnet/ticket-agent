import {
  ACTIVE_VENUE_SET,
  ACTIVE_VENUE_ADAPTERS,
  ACTIVE_VENUE_SMOKE_MATRIX,
  VENUE_POLICY_MAP,
  DEFAULT_BUSINESS_HOURS
} from './venue-config.js';
import {
  CRON_SCHEDULE_CONFIG
} from './global-config.js';

export function isSkyboxListingEnabled(env) {
  const rawValue = env?.ALLOW_SKYBOX_LISTING ?? env?.SKYBOX_LISTING_ENABLED ?? 'false';
  const normalized = String(rawValue).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function findInMap(map, venueIdentifier) {
  const input = String(venueIdentifier ?? "").trim();
  if (!input) return null;

  const byId = map[input.toLowerCase()];
  if (byId) return byId;

  const normalized = input.toLowerCase()?.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return Object.values(map).find(item => item.venueId === normalized || item.venueName.toLowerCase()?.replace(/[^a-z0-9]+/g, "_") === normalized) || null;
}

export function resolveVenuePolicy(venueIdentifier) {
  return findInMap(VENUE_POLICY_MAP, venueIdentifier) || { active: false, enabled: false, reason: "Venue not in active or approved registry.", baseIntervalMs: 0, maxIntervalMs: 0 };
}

export function buildVenueAdapterSmokeReport() {
  return ACTIVE_VENUE_SMOKE_MATRIX.map(entry => {
    const adapter = resolveVenueAdapter(entry.venueId);
    return {
      ...entry,
      mustPass: adapter ? adapter.smokeChecks : []
    };
  });
}

export function isSmokeMatrixReady() {
  return ACTIVE_VENUE_SMOKE_MATRIX.length === ACTIVE_VENUE_SET.length
    && ACTIVE_VENUE_SMOKE_MATRIX.every(entry => entry.active && !entry.listingApprovalAllowed);
}

export function resolveVenueAdapter(venueIdentifier) {
  return findInMap(ACTIVE_VENUE_ADAPTERS, venueIdentifier) || null;
}

export function buildOperationalTelemetrySnapshot(referenceDate = new Date(), env = {}) {
  const listingEnabled = isSkyboxListingEnabled(env);
  const monitoringOnly = !listingEnabled;
  const venues = ACTIVE_VENUE_SET.map(venueId => {
    const policy = resolveVenuePolicy(venueId);
    const timeZone = policy.timezoneName || "UTC";
    const businessWindowOpen = isMonitoringWindowActive(referenceDate, timeZone);
    const reasonCode = businessWindowOpen ? "within_business_window" : "outside_business_window";

    return {
      venueId,
      venueName: policy.venueName,
      timezoneName: timeZone,
      businessWindowOpen,
      monitoringOnly,
      retryCount: 0,
      reasonCode,
      lastScanAt: null,
      sourcePolicy: policy.sourcePolicy,
      outboundApprovalEnabled: listingEnabled
    };
  });

  return {
    generatedAt: new Date(referenceDate).toISOString(),
    monitoringOnly,
    activeVenueCount: venues.length,
    outboundApprovalEnabled: listingEnabled,
    venues
  };
}

export function inferVenueTimeZone(venueName, _stateCode, explicitTimezone) {
  if (explicitTimezone) return explicitTimezone;

  const policy = resolveVenuePolicy(venueName);
  if (policy && policy.timezoneName) return policy.timezoneName;

  return "UTC";
}

export function isMonitoringWindowActive(date = new Date(), timeZone = "UTC") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const hourPart = parts.find(part => part.type === "hour")?.value ?? "0";
  const minutePart = parts.find(part => part.type === "minute")?.value ?? "0";
  const localMinutes = Number(hourPart) * 60 + Number(minutePart);
  const startMinutes = DEFAULT_BUSINESS_HOURS.start.hour * 60 + DEFAULT_BUSINESS_HOURS.start.minute;
  const endMinutes = DEFAULT_BUSINESS_HOURS.end.hour * 60 + DEFAULT_BUSINESS_HOURS.end.minute;
  return localMinutes >= startMinutes && localMinutes <= endMinutes;
}

export function getScheduleModeForCronDate(date = new Date()) {
  const minute = Number(date.getUTCMinutes());
  if (CRON_SCHEDULE_CONFIG.primaryScanMinutes.has(minute)) return "primary_scan";
  if (CRON_SCHEDULE_CONFIG.listingWatchMinutes.has(minute)) return "listing_watch";
  if (CRON_SCHEDULE_CONFIG.discoveryScanMinutes.has(minute)) return "discovery_scan";
  return "idle";
}

const BLOCK_LIKE_STATUS_CODES = new Set([403, 429, 503]);

export function isBlockLikeStatus(statusCode) {
  return BLOCK_LIKE_STATUS_CODES.has(Number(statusCode));
}

export function computeBackoffDelayMs(consecutiveBlocks, policy = {}) {
  const baseIntervalMs = policy.baseIntervalMs || 120000;
  const maxIntervalMs = policy.maxIntervalMs || 600000;
  const ceilingMs = maxIntervalMs * 6;
  const delayMs = baseIntervalMs * Math.pow(2, Math.max(1, consecutiveBlocks));
  return Math.min(delayMs, ceilingMs);
}