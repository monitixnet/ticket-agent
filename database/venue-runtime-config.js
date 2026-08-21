import { DISCOVERY_PAGE_LIMITS } from '../global-config.js';

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function buildAdapter(row, env) {
  const config = parseJson(row.config_json);
  const credentialRefs = parseJson(row.credential_refs_json);
  const errors = [];
  for (const field of ['discoveryStrategy', 'inventoryStrategy', 'urlPattern']) {
    if (!config[field] || typeof config[field] !== 'string') errors.push(`missing ${field}`);
  }
  const credentials = {};
  for (const [field, secretName] of Object.entries(credentialRefs)) {
    if (!SECRET_NAME_PATTERN.test(String(secretName))) {
      errors.push(`invalid secret reference for ${field}`);
      continue;
    }
    if (!env?.[secretName]) errors.push(`missing Worker secret ${secretName}`);
    else credentials[field] = env[secretName];
  }
  if (errors.length) return { adapter: null, errors };
  const configuredBufferBlockCount = Number(config.inventoryBufferBlockCount);
  const inventoryBufferBlockCount = Number.isInteger(configuredBufferBlockCount)
    && configuredBufferBlockCount >= 1 && configuredBufferBlockCount <= 5
    ? configuredBufferBlockCount
    : 2;
  const inventoryBatchSize = Number.isInteger(Number(config.inventoryBatchSize))
    ? Math.min(20, Math.max(1, Number(config.inventoryBatchSize)))
    : 5;
  const inventoryMaxRunDurationMs = Number.isInteger(Number(config.inventoryMaxRunDurationMs))
    ? Math.min(120000, Math.max(10000, Number(config.inventoryMaxRunDurationMs)))
    : 45000;
  const inventoryExternalRequestBudget = Number.isInteger(Number(config.inventoryExternalRequestBudget))
    ? Math.min(49, Math.max(8, Number(config.inventoryExternalRequestBudget)))
    : 48;
  const dropWatchBatchSize = Number.isInteger(Number(config.dropWatchBatchSize))
    ? Math.min(20, Math.max(1, Number(config.dropWatchBatchSize)))
    : 12;
  const automaticSoldOutIntervalMinutes = Number.isInteger(Number(config.automaticSoldOutIntervalMinutes))
    ? Math.min(120, Math.max(5, Number(config.automaticSoldOutIntervalMinutes)))
    : 5;
  const inventoryTargetQuantities = Array.isArray(config.inventoryTargetQuantities)
    ? [...new Set(config.inventoryTargetQuantities.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 10))]
    : [2, 6];
  const providerPool = value => (Array.isArray(value) ? value : String(value || 'native').split(','))
    .map(provider => String(provider).trim()).filter(Boolean);

  return {
    adapter: {
      ...config,
      ...credentials,
      venueId: row.venue_id,
      venueName: row.venue_name,
      timezoneName: row.timezone_name,
      securityTier: row.security_tier,
      active: true,
      monitoringOnly: true,
      listingApprovalAllowed: false,
      requiredInventoryFields: ['section', 'row', 'seat', 'priceLevel', 'seatQuality', 'eventId'],
      normalizationRules: ['normalize_section_labels', 'normalize_row_labels', 'normalize_seat_labels', 'normalize_price_levels'],
      smokeChecks: config.smokeChecks || ['time_window', 'section_parity', 'price_parity', 'fresh_snapshot', '3x_coverage'],
      businessHours: config.businessHours || { start: { hour: 7, minute: 30 }, end: { hour: 23, minute: 59 } },
      baseIntervalMs: Number(config.baseIntervalMs) || 120000,
      maxIntervalMs: Number(config.maxIntervalMs) || 600000,
      inventoryBufferBlockCount,
      inventoryBatchSize,
      inventoryMaxRunDurationMs,
      inventoryExternalRequestBudget,
      dropWatchBatchSize,
      automaticSoldOutIntervalMinutes,
      inventoryTargetQuantities: inventoryTargetQuantities.length ? inventoryTargetQuantities : [2, 6]
      ,apiFetchProviderPool: providerPool(config.apiFetchProviderPool)
      ,fetchProviderPool: providerPool(config.fetchProviderPool)
      ,discoveryMaxPages: Math.max(1, Math.min(
        Number(config.discoveryMaxPages) || DISCOVERY_PAGE_LIMITS.defaultMaxPages,
        DISCOVERY_PAGE_LIMITS.absoluteMaxPages
      ))
      ,debugTelemetryEnabled: config.debugTelemetryEnabled === true || config.debugTelemetryEnabled === 1
    },
    errors: []
  };
}

export async function getActiveVenueAdapters(db, env) {
  if (!db) return [];
  const result = await db.prepare(`SELECT v.id AS venue_id, v.name AS venue_name, v.timezone_name, v.security_tier,
      c.config_json, c.credential_refs_json
    FROM venues v JOIN venue_runtime_configs c ON c.venue_id = v.id
    WHERE c.status = 'active' ORDER BY v.id`).all();
  const adapters = [];
  for (const row of result?.results || []) {
    const { adapter, errors } = buildAdapter(row, env);
    if (adapter) adapters.push(adapter);
    else console.error(`[CONFIG] Active venue ${row.venue_id} was skipped: ${errors.join(', ')}`);
  }
  return adapters;
}

export async function getVenueAdapter(db, env, venueId) {
  if (!db) return null;
  const row = await db.prepare(`SELECT v.id AS venue_id, v.name AS venue_name, v.timezone_name, v.security_tier,
      c.config_json, c.credential_refs_json
    FROM venues v JOIN venue_runtime_configs c ON c.venue_id = v.id
    WHERE v.id = ? AND c.status = 'active'`).bind(venueId).first();
  if (!row) return null;
  const { adapter, errors } = buildAdapter(row, env);
  if (!adapter) console.error(`[CONFIG] Active venue ${venueId} was skipped: ${errors.join(', ')}`);
  return adapter;
}

export function buildPublicVenueSummary(adapter) {
  return {
    venueId: adapter.venueId,
    venueName: adapter.venueName,
    timezoneName: adapter.timezoneName,
    securityTier: adapter.securityTier,
    active: true,
    monitoringOnly: true,
    discoveryStrategy: adapter.discoveryStrategy,
    inventoryStrategy: adapter.inventoryStrategy,
    inventoryBufferBlockCount: adapter.inventoryBufferBlockCount,
    inventoryBatchSize: adapter.inventoryBatchSize,
    inventoryMaxRunDurationMs: adapter.inventoryMaxRunDurationMs,
    inventoryExternalRequestBudget: adapter.inventoryExternalRequestBudget,
    dropWatchBatchSize: adapter.dropWatchBatchSize,
    automaticSoldOutIntervalMinutes: adapter.automaticSoldOutIntervalMinutes,
    inventoryTargetQuantities: adapter.inventoryTargetQuantities
  };
}
