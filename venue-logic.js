const DEFAULT_BUSINESS_HOURS = {
  start: { hour: 7, minute: 30 },
  end: { hour: 23, minute: 59 }
};
import {
  CRON_SCHEDULE_CONFIG
} from './global-config.js';

export function isSkyboxListingEnabled(env) {
  const isEnabled = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? 'false').trim().toLowerCase());
  // Listing approval is intentionally a two-person/configuration action. A
  // monitoring deployment cannot become an approval service from one typo.
  return isEnabled(env?.ALLOW_SKYBOX_LISTING ?? env?.SKYBOX_LISTING_ENABLED)
    && isEnabled(env?.ENABLE_AUTOMATED_APPROVAL);
}

export function buildVenueAdapterSmokeReport(adapters = []) {
  return adapters.map(adapter => ({
    venueId: adapter.venueId,
    venueName: adapter.venueName,
    timezoneName: adapter.timezoneName,
    sourceAdapter: 'venue_specific',
    listingApprovalAllowed: false,
    outboundApprovalEnabled: false,
    monitoringOnly: true,
    active: true,
    mustPass: adapter.smokeChecks || []
  }));
}

export function isSmokeMatrixReady(adapters = []) {
  return adapters.every(adapter => adapter.active && !adapter.listingApprovalAllowed);
}

export function buildOperationalTelemetrySnapshot(referenceDate = new Date(), env = {}, adapters = []) {
  const listingEnabled = isSkyboxListingEnabled(env);
  const monitoringOnly = !listingEnabled;
  const venues = adapters.map(adapter => {
    const timeZone = adapter.timezoneName || "UTC";
    const businessWindowOpen = isMonitoringWindowActive(referenceDate, timeZone);
    const reasonCode = businessWindowOpen ? "within_business_window" : "outside_business_window";

    return {
      venueId: adapter.venueId,
      venueName: adapter.venueName,
      timezoneName: timeZone,
      businessWindowOpen,
      monitoringOnly,
      retryCount: 0,
      reasonCode,
      lastScanAt: null,
      sourcePolicy: 'venue_specific',
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
  return "UTC";
}

export function isMonitoringWindowActive(date = new Date(), timeZone = "UTC", businessHours = DEFAULT_BUSINESS_HOURS) {
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
  const start = businessHours?.start || DEFAULT_BUSINESS_HOURS.start;
  const end = businessHours?.end || DEFAULT_BUSINESS_HOURS.end;
  const startMinutes = Number(start.hour) * 60 + Number(start.minute);
  const endMinutes = Number(end.hour) * 60 + Number(end.minute);
  return localMinutes >= startMinutes && localMinutes <= endMinutes;
}

// Keep scheduler audit records in the venue's own clock, never the Worker host
// or the operator's browser timezone.
export function formatVenueLocalTime(date = new Date(), timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(", ", " ");
}

export function getScheduleModeForCronDate(date = new Date()) {
  const minute = Number(date.getUTCMinutes());
  if (CRON_SCHEDULE_CONFIG.dropWatchMinutes.has(minute)) return "drop_watch";
  if (CRON_SCHEDULE_CONFIG.inventoryScanMinutes.has(minute)) return "inventory_scan";
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
