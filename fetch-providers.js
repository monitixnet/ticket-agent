function redactSensitiveLogValue(value) {
  return String(value)
    .replace(/([?&](?:api[_-]?key|apikey|token|secret|authorization)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|apikey|token|secret|authorization)"\s*:\s*")[^"]*/gi, '$1[REDACTED]');
}

// SeatMe inventory uses native Worker fetches with the venue session manager.
// Keep this provider deliberately narrow: no proxy or browser egress paths can
// be enabled through D1 configuration.
async function nativeFetchProvider(_env, targetUrlString, _targetRow, fetchOptions = {}) {
  console.log(`[FREE NETWORK] Running free native fetch -> ${redactSensitiveLogValue(targetUrlString)}`);
  const response = await fetch(targetUrlString, {
    method: fetchOptions.method || 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(fetchOptions.headers || {})
    },
    body: fetchOptions.body,
    redirect: fetchOptions.redirect || 'follow'
  });
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (typeof response.headers.getAll === 'function' ? response.headers.getAll('Set-Cookie') : []);
  return {
    text: await response.text(),
    status: response.status,
    contentType: response.headers.get('content-type') || null,
    redirectLocation: response.headers.get('location') || null,
    redirected: response.redirected,
    setCookies,
    routedVia: 'nativeFetchProvider'
  };
}

export const FETCH_PROVIDERS = Object.freeze({ native: nativeFetchProvider });
