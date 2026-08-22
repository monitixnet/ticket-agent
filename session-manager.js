// Venue session utilities are deliberately transport-agnostic. The caller
// supplies its own request function, so this module cannot make arbitrary
// network calls or leak cookie values into logs/responses.

export function buildServerIssuedCookieHeader(setCookies = []) {
  const pairs = new Map();
  for (const setCookie of Array.isArray(setCookies) ? setCookies : []) {
    const pair = String(setCookie || '').split(';', 1)[0].trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function parseCookieHeader(cookieHeader = '') {
  const pairs = new Map();
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return pairs;
}

export function mergeCookieHeaders(...headers) {
  const pairs = new Map();
  for (const header of headers) {
    for (const [name, value] of parseCookieHeader(header)) pairs.set(name, value);
  }
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function sessionStateKey(venueId) {
  return `venue_http_session:${String(venueId || '').trim()}`;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sessionEncryptionKey(env) {
  if (!env?.VENUE_SESSION_ENCRYPTION_KEY) {
    throw new Error('VENUE_SESSION_ENCRYPTION_KEY is required when venue session bootstrap is enabled.');
  }
  const raw = base64ToBytes(env.VENUE_SESSION_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error('VENUE_SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSessionPayload(env, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionEncryptionKey(env), plaintext);
  return JSON.stringify({ version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) });
}

async function decryptSessionPayload(env, encrypted) {
  const record = JSON.parse(encrypted || '{}');
  if (record.version !== 1 || !record.iv || !record.ciphertext) return null;
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
    await sessionEncryptionKey(env),
    base64ToBytes(record.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function loadVenueSessionCookieHeader(db, env, venueId, nowMs = Date.now()) {
  const keyName = sessionStateKey(venueId);
  const row = await db.prepare('SELECT value_string FROM system_state WHERE key_name = ?').bind(keyName).first();
  if (!row?.value_string) return '';
  try {
    const payload = await decryptSessionPayload(env, row.value_string);
    if (!payload?.cookieHeader || !Number.isFinite(Number(payload.expiresAt)) || Number(payload.expiresAt) <= nowMs) {
      await db.prepare('DELETE FROM system_state WHERE key_name = ?').bind(keyName).run();
      return '';
    }
    return String(payload.cookieHeader);
  } catch {
    await db.prepare('DELETE FROM system_state WHERE key_name = ?').bind(keyName).run();
    return '';
  }
}

export async function saveVenueSessionCookieHeader(db, env, venueId, cookieHeader, ttlMs) {
  if (!cookieHeader) return;
  const expiresAt = Date.now() + Math.max(60_000, Number(ttlMs) || 15 * 60_000);
  const valueString = await encryptSessionPayload(env, { cookieHeader, expiresAt });
  await db.prepare('INSERT OR REPLACE INTO system_state (key_name, value_string) VALUES (?, ?)')
    .bind(sessionStateKey(venueId), valueString)
    .run();
}

export function isSessionRedirectResponse(result = {}) {
  if (Number(result?.status) >= 300 && Number(result?.status) < 400) return true;
  return classifyInventoryResponse(result) === 'session_redirect_mask';
}

export function sessionRequestHeaders() {
  return {
    'User-Agent': 'PostmanRuntime/7.43.0',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Postman-Token': crypto.randomUUID()
  };
}

export function classifyInventoryResponse(result = {}) {
  try {
    const body = JSON.parse(result.text || '');
    if (Array.isArray(body)) return 'section_availability_array';
    return body?.redirectMask ? 'session_redirect_mask' : 'json_object';
  } catch {
    return 'non_json';
  }
}

function redirectHost(location) {
  try { return location ? new URL(location).host : null; } catch { return null; }
}

// At most two requests: first obtains only server-issued state; second uses it
// within the same invocation. The returned diagnostics intentionally exclude
// cookie names and values. Persistence is not part of this initial proof.
export async function runEphemeralSessionBootstrap({ request }) {
  const first = await request({});
  const cookieHeader = buildServerIssuedCookieHeader(first?.setCookies);
  const firstSummary = {
    httpStatus: first?.status,
    resultKind: classifyInventoryResponse(first),
    setCookieCount: Array.isArray(first?.setCookies) ? first.setCookies.length : 0
  };
  if (!cookieHeader) {
    return {
      first: firstSummary,
      retried: false,
      conclusion: 'The first response did not issue a usable cookie for a same-invocation retry.'
    };
  }
  const second = await request({ Cookie: cookieHeader });
  const secondSummary = {
    httpStatus: second?.status,
    resultKind: classifyInventoryResponse(second)
  };
  return {
    first: firstSummary,
    retried: true,
    second: secondSummary,
    conclusion: secondSummary.resultKind === 'section_availability_array'
      ? 'Same-invocation server-issued session flow returned availability JSON.'
      : 'Same-invocation retry did not return availability JSON.'
  };
}

// Tests a known, permitted bootstrap endpoint (such as performance settings)
// before the protected availability endpoint. State stays in memory for this
// invocation only and is never logged or persisted.
export async function runEphemeralBootstrapThenTarget({ bootstrapRequest, targetRequest }) {
  const bootstrap = await bootstrapRequest();
  const cookieHeader = buildServerIssuedCookieHeader(bootstrap?.setCookies);
  const bootstrapSummary = {
    httpStatus: bootstrap?.status,
    resultKind: classifyInventoryResponse(bootstrap),
    setCookieCount: Array.isArray(bootstrap?.setCookies) ? bootstrap.setCookies.length : 0,
    redirectHost: redirectHost(bootstrap?.redirectLocation)
  };
  if (!cookieHeader) {
    return {
      bootstrap: bootstrapSummary,
      retried: false,
      conclusion: 'The bootstrap response did not issue a usable cookie for an availability request.'
    };
  }
  const target = await targetRequest({ Cookie: cookieHeader });
  const targetSummary = {
    httpStatus: target?.status,
    resultKind: classifyInventoryResponse(target)
  };
  return {
    bootstrap: bootstrapSummary,
    retried: true,
    second: targetSummary,
    conclusion: targetSummary.resultKind === 'section_availability_array'
      ? 'Bootstrap-issued session state returned availability JSON.'
      : 'Bootstrap-issued session state did not return availability JSON.'
  };
}
