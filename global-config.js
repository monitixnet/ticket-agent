export const CRON_SCHEDULE_CONFIG = {
  primaryScanMinutes: new Set([12, 32, 52]),
  listingWatchMinutes: new Set([7, 17, 27, 37, 47, 57]),
  discoveryScanMinutes: new Set([2, 22, 42]), // New cron minute for discovery scans
};

export const SCAN_JITTER_CONFIG = {
  listingWatch: { minMs: 4000, maxMs: 16000 },
  primaryScan: { minMs: 15000, maxMs: 45000 },
};