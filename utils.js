export function computeStringHash(text) {
  let hash = 0;
  if (text.length === 0) return hash.toString();
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString();
}

export const delayExecution = ms => new Promise(res => setTimeout(res, ms));

export const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const computeJitteredDelay = (baseMinMs, baseMaxMs) => {
  const baseMs = randomBetween(baseMinMs, baseMaxMs);
  const jitterMs = randomBetween(0, Math.max(5000, Math.floor(baseMs * 0.35)));
  return baseMs + jitterMs;
};

export const buildWorkerLogId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function parseVenueTime(localDatePart, localTimePart, timeZone, year) {
  // localDatePart example: "Wednesday, Aug. 12" or "Aug. 12"
  // localTimePart example: "7:30 PM"
  // timeZone example: "America/Los_Angeles"
  // year example: 2026 (from monthYear)

  // Construct a full local date-time string that `new Date()` can parse,
  // but we need to ensure it's interpreted in the correct timezone.
  // The most robust way is to get the components in the target timezone and build a UTC date.

  // Create a dummy date string for parsing month/day, assuming current year if not provided.
  const currentYear = new Date().getFullYear();
  const fullDateString = `${localDatePart} ${year || currentYear} ${localTimePart}`;

  // Use Intl.DateTimeFormat to get the components of this local time in the target timezone.
  const options = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZone: timeZone,
    hour12: false // Ensure 24-hour format for easier parsing
  };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date(fullDateString));

  const getPart = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);

  // Construct a UTC Date object from these components.
  // This inherently handles DST because the components are already adjusted for the target timezone at the given date.
  return new Date(Date.UTC(getPart('year'), getPart('month') - 1, getPart('day'), getPart('hour'), getPart('minute'), getPart('second')));
}

export function timingSafeEqual(a = '', b = '') {
  const strA = String(a);
  const strB = String(b);
  if (strA.length !== strB.length) return false;

  let mismatch = 0;
  for (let i = 0; i < strA.length; i++) {
    mismatch |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return mismatch === 0;
}