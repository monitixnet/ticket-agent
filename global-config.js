export const CRON_SCHEDULE_CONFIG = {
  // Drops get a dedicated five-minute fast lane.
  dropWatchMinutes: new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]),
  inventoryScanMinutes: new Set([9, 29, 59]),
  listingWatchMinutes: new Set([17, 27, 57]),
  discoveryScanMinutes: new Set([7, 37]),
};

export const SCAN_JITTER_CONFIG = {
  listingWatch: { minMs: 4000, maxMs: 16000 },
  inventoryScan: { minMs: 15000, maxMs: 45000 },
};
