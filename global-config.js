export const CRON_SCHEDULE_CONFIG = {
  // Drops get a dedicated five-minute fast lane.
  dropWatchMinutes: new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]),
  inventoryScanMinutes: new Set([7, 17, 27, 37, 47, 57]),
  listingWatchMinutes: new Set([12, 32, 52]),
  discoveryScanMinutes: new Set([3, 8, 13, 18, 23, 28, 33, 38, 43, 48, 53, 58]),
};

export const SCAN_JITTER_CONFIG = {
  listingWatch: { minMs: 4000, maxMs: 16000 },
  inventoryScan: { minMs: 15000, maxMs: 45000 },
};
