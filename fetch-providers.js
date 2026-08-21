function redactSensitiveLogValue(value) {
  return String(value)
    .replace(/([?&](?:api[_-]?key|apikey|token|secret|authorization)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|apikey|token|secret|authorization)"\s*:\s*")[^"]*/gi, '$1[REDACTED]');
}

async function nativeFetchProvider(_env, targetUrlString, _targetRow, fetchOptions = {}) {
  console.log(`[FREE NETWORK] Running free native fetch -> ${redactSensitiveLogValue(targetUrlString)}`);
  const res = await fetch(targetUrlString, {
    method: fetchOptions.method || 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(fetchOptions.headers || {})
    },
    body: fetchOptions.body,
    // Inventory APIs must expose SeatMe's redirect decision to the caller.
    // Following a cart redirect turns a meaningful 303 into HTML and hides
    // the real upstream outcome.
    redirect: fetchOptions.redirect || 'follow'
  });
  return {
    text: await res.text(),
    status: res.status,
    contentType: res.headers.get('content-type') || null,
    redirectLocation: res.headers.get('location') || null,
    redirected: res.redirected,
    routedVia: 'nativeFetchProvider'
  };
}

// ScrapFly preserves the upstream method, body, and request headers. That is
// essential for Tessitura's form-encoded BuyButton POST endpoint; a browser
// proxy that turns it into a navigation would return the wrong response.
async function scrapflyProvider(env, targetUrlString, _targetRow, fetchOptions = {}) {
  const apiKey = env.SCRAPEFLY_API_KEY;
  if (!apiKey) throw new Error('Missing SCRAPEFLY_API_KEY for scrapflyProvider.');
  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrlString,
    asp: 'true',
    country: 'us',
    format: 'raw',
    retry: 'true',
    timeout: '25000'
  });
  for (const [headerName, headerValue] of Object.entries(fetchOptions.headers || {})) {
    params.append(`headers[${headerName}]`, String(headerValue));
  }
  console.log(`[SCRAPEFLY] Routing ${fetchOptions.method || 'GET'} via ScrapFly -> ${redactSensitiveLogValue(targetUrlString)}`);
  const response = await fetch(`https://api.scrapfly.io/scrape?${params.toString()}`, {
    method: fetchOptions.method || 'GET',
    body: fetchOptions.body
  });
  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return { text: responseText, status: response.status, routedVia: 'scrapflyProvider' };
  }
  const result = payload?.result || {};
  return {
    text: typeof result.content === 'string' ? result.content : responseText,
    status: Number(result.status_code) || response.status,
    routedVia: 'scrapflyProvider'
  };
}

async function executeCdpSession(providerName, provisioningDetails, targetUrlString) {
    console.log(`[${providerName.toUpperCase()} BROWSER] Routing via remote browser -> ${redactSensitiveLogValue(targetUrlString)}`);

    const { provisioningUrl, authHeaders } = provisioningDetails;

    let wsEndpoint;
    try {
        // 1. Provision a one-time browser profile.
        const profileResponse = await fetch(provisioningUrl, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' }
        });

        if (!profileResponse.ok) {
            if (profileResponse.status === 429) {
                return { text: `Rate limited by ${providerName} provisioning API`, status: 429, routedVia: providerName };
            }
            throw new Error(`Failed to provision ${providerName} browser profile: ${profileResponse.statusText} (${profileResponse.status})`);
        }
        const profileData = await profileResponse.json();

        wsEndpoint = profileData.ws_url || profileData.ws_endpoint;
        if (!wsEndpoint) {
            throw new Error('Provisioning response did not contain a ws_url.');
        }
    } catch (err) {
        console.error(`[${providerName.toUpperCase()} BROWSER] Provisioning failed: ${err.message}`);
        throw new Error(`${providerName} provisioning failed: ${err.message}`);
    }

    // 2. Connect to the browser and perform the navigation.
    let webSocket;
    try {
        const upgradeUrl = new URL(wsEndpoint);
        upgradeUrl.protocol = 'https';

        const wsResponse = await fetch(upgradeUrl.toString(), { headers: { Upgrade: "websocket" } });
        webSocket = wsResponse.webSocket;
        if (!webSocket) {
            throw new Error('Server did not respond with a WebSocket.');
        }
    } catch (err) {
        throw new Error(`Failed to establish WebSocket connection: ${err.message}`);
    }

    webSocket.accept();

    const cdpPromise = new Promise((resolve, reject) => {
        let commandId = 1;
        const inflightCommands = new Map();
        const BROWSER_TIMEOUT = 90000;
        let pageSessionId = null;
        let pageTargetId = null;
        let isSettled = false;
        const waitTime = Number(_env.ZENROWS_WAIT_TIME || 7373);

        const timeout = setTimeout(() => webSocket.close(1001, 'Timeout'), BROWSER_TIMEOUT);

        const cdpSend = (method, params = {}, sessionId = null) => {
            const id = commandId++;
            const command = { id, method, params };
            if (sessionId) {
                command.sessionId = sessionId;
            }
            webSocket.send(JSON.stringify(command));
            return new Promise((resolveCmd, rejectCmd) => {
                inflightCommands.set(id, { resolve: resolveCmd, reject: rejectCmd, method });
            });
        };

        webSocket.addEventListener('message', (event) => {
            const cdpMessage = JSON.parse(event.data);

            if (cdpMessage.id && inflightCommands.has(cdpMessage.id)) {
                const { resolve, reject, method } = inflightCommands.get(cdpMessage.id);
                inflightCommands.delete(cdpMessage.id);
                if (cdpMessage.error) {
                    reject(new Error(`CDP error for ${method}: ${cdpMessage.error.message}`));
                } else {
                    resolve(cdpMessage.result);
                }
            } else if (cdpMessage.method === 'Page.loadEventFired' && cdpMessage.sessionId === pageSessionId) {
                if (isSettled) return;

                // FIXED & ENHANCED: Injecting a 7-second browser pause inside the DOM 
                // execution frame before grabbing the hydrated page outerHTML code.
                cdpSend('Runtime.evaluate', { 
                    expression: `new Promise(resolve => setTimeout(() => resolve(document.documentElement.outerHTML), ${waitTime}))`,
                    awaitPromise: true 
                }, pageSessionId)
                    .then(result => {
                        if (isSettled) return;
                        const pageContent = result.result?.value || '';
                        let finalStatus = 200;
                        if (pageContent.toLowerCase().includes('rate limit') || pageContent.toLowerCase().includes('blocked')) {
                            finalStatus = 429;
                        }
                        isSettled = true;
                        clearTimeout(timeout);
                        resolve({ text: pageContent, status: finalStatus, routedVia: providerName });
                    })
                    .catch(reject);
            } else if (cdpMessage.method === 'Target.targetCrashed' && cdpMessage.params.targetId === pageTargetId) {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timeout);
                reject(new Error('Remote browser page crashed during operation.'));
            }
        });

        webSocket.addEventListener('error', () => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            reject(new Error('WebSocket connection error.'));
        });

        webSocket.addEventListener('close', (event) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            const reason = event.code === 1001 ? 'timed out' : `closed abnormally (Code: ${event.code})`;
            reject(new Error(`${providerName} browser operation ${reason}`));
        });

        const runBrowserFlow = async () => {
            try {
                const { targetInfos } = await cdpSend('Target.getTargets');
                const pageTarget = targetInfos.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
                if (!pageTarget) throw new Error('No page target found in remote browser.');
                pageTargetId = pageTarget.targetId;

                const attachResult = await cdpSend('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
                pageSessionId = attachResult.sessionId;

                await cdpSend('Runtime.getIsolateId', {}, pageSessionId);
                await cdpSend('Page.enable', {}, pageSessionId);
                await cdpSend('Runtime.enable', {}, pageSessionId);
                await cdpSend('Page.navigate', { url: targetUrlString }, pageSessionId);
            } catch (err) {
                reject(err);
            }
        };

        runBrowserFlow();
    });

    return await cdpPromise;
}

async function zenrowsApiProxyProvider(env, targetUrlString, _targetRow, fetchOptions = {}) {
    console.log(`[ZENROWS API PROXY] Routing via ZenRows proxy -> ${redactSensitiveLogValue(targetUrlString)}`);
    const apiUrl = env.ZENROWS_API_URL || 'https://api.zenrows.com/v1/';
    const apiToken = env.ZENROWS_API_TOKEN;
    if (!apiToken) {
        throw new Error('Missing ZENROWS_API_TOKEN for zenrowsApiProxyProvider.');
    }

    const zenrowsParams = {
        antibot: 'true',
        apikey: apiToken,
        custom_headers: 'true',
        original_status: 'true',
        premium_proxy: 'true',
        proxy_country: 'us',
        wait: 5000,
    };

    const requestBody = fetchOptions.body;
    const requestHeaders = fetchOptions.headers || {};

    // ZenRows forwards the request body unchanged.  In particular, do not wrap form
    // data in JSON: SCFTA's BuyButton endpoint requires URL-encoded form data.
    const proxyUrlParams = new URLSearchParams({ url: targetUrlString, ...zenrowsParams });
    const finalZenrowsUrl = `${apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl}/?${proxyUrlParams.toString()}`;

    console.log(`[ZENROWS DEBUG] Forwarding ${fetchOptions.method || 'POST'} request with Content-Type: ${requestHeaders['Content-Type'] || 'none'}`);

    const finalZenrowsOptions = {
        method: fetchOptions.method || 'POST',
        headers: requestHeaders,
        body: requestBody,
    };

    const res = await fetch(finalZenrowsUrl, finalZenrowsOptions);
    const responseText = await res.text();
    if (fetchOptions.debug) {
      console.log(`[ZENROWS DEBUG] Raw response text: ${redactSensitiveLogValue(responseText)}`);
    } else {
      console.log(`[ZENROWS DEBUG] Raw response text (first 500 chars): ${redactSensitiveLogValue(responseText.slice(0, 500))}`);
    }

    try {
        const zenrowsResponse = JSON.parse(responseText);

        let unwrappedText = '';
        const finalStatus = zenrowsResponse.status_code || res.status;

        // Intelligently detect the response structure.
        if (zenrowsResponse.data) {
          // If ZenRows wrapped the response (e.g., for browser rendering), unwrap it.
          unwrappedText = (typeof zenrowsResponse.data === 'string') ? zenrowsResponse.data : JSON.stringify(zenrowsResponse.data);
        } else {
          // Otherwise, the entire response is the payload we want.
          unwrappedText = JSON.stringify(zenrowsResponse);
        }
        return { text: unwrappedText, status: finalStatus, routedVia: 'zenrowsApiProxyProvider' };
    } catch (e) {
        return {
            text: responseText,
            status: res.status,
            routedVia: 'zenrowsApiProxyProvider'
        };
    }

}

async function zenrowsBrowserProvider(env, targetUrlString) {
    console.log(`[ZENROWS BROWSER] Routing via ZenRows proxy -> ${redactSensitiveLogValue(targetUrlString)}`);
    const apiUrl = env.ZENROWS_API_URL || 'https://api.zenrows.com/v1/';
    const apiToken = env.ZENROWS_API_TOKEN;
    if (!apiToken) throw new Error('Missing ZENROWS_API_TOKEN for zenrowsBrowserProvider.');

    const params = new URLSearchParams({
        apikey: apiToken,
        url: targetUrlString,
        js_render: 'true',
        antibot: 'true',
        premium_proxy: 'true',
        proxy_country: 'us',
        wait: 8000, // Use a generous fixed wait time for API endpoints that have browser-level checks.
    });

    const proxyUrl = `${apiUrl}?${params.toString()}`;
    const res = await fetch(proxyUrl);
    return { text: await res.text(), status: res.status, routedVia: 'zenrowsBrowserProvider' };
}

export const FETCH_PROVIDERS = {
  native: nativeFetchProvider,
  scrapfly: scrapflyProvider,
  zenrows_browser: zenrowsBrowserProvider,
  zenrows_api: zenrowsApiProxyProvider,
};

// Standard Cloudflare Workers entrypoint definition wrapper
export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const targetUrl = url.searchParams.get("target");
            const provider = url.searchParams.get("provider") || "native";

            if (!targetUrl) {
                return new Response(JSON.stringify({ error: "Missing '?target=' query parameter." }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                });
            }

            if (!FETCH_PROVIDERS[provider]) {
                return new Response(JSON.stringify({ error: `Provider '${provider}' not supported.` }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                });
            }

            // Execute the corresponding routing track safely
            const result = await FETCH_PROVIDERS[provider](env, targetUrl);

            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
    }
};
