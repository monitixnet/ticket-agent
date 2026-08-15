async function nativeFetchProvider(_env, targetUrlString) {
  console.log(`[FREE NETWORK] Running free native fetch -> ${targetUrlString}`);
  const res = await fetch(targetUrlString, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  return { text: await res.text(), status: res.status, routedVia: 'nativeFetchProvider' };
}

async function executeCdpSession(providerName, provisioningDetails, targetUrlString) {
    console.log(`[${providerName.toUpperCase()} BROWSER] Routing via remote browser -> ${targetUrlString}`);

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
        const waitTime = _env.ZENROWS_WAIT_TIME || '7373'; // Default wait time of 7 seconds

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
                    expression: 'new Promise(resolve => setTimeout(() => resolve(document.documentElement.outerHTML), waitTime))',
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

async function zenrowsProvider(env, targetUrlString) {
    console.log(`[ZENROWS BROWSER] Routing via ZenRows proxy -> ${targetUrlString}`);
    const apiUrl = env.ZENROWS_API_URL || 'https://zenrows.com';
    const apiToken = env.ZENROWS_API_TOKEN;
    const waitTime = env.ZENROWS_WAIT_TIME || '7373'; // Default wait time of 7 seconds
    if (!apiToken) {
        throw new Error('Missing ZENROWS_API_TOKEN environment variable.');
    }

    const params = new URLSearchParams({
        antibot: 'true',
        apikey: apiToken,
        block_resources: 'image,font',
        js_render: 'true',
        original_status: 'true',
        premium_proxy: 'true',
        proxy_country: 'us',
        wait: waitTime,
        url: targetUrlString,
    });

    const cleanBaseUrl = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
    const proxyUrl = `${cleanBaseUrl}?${params.toString()}`;

    const res = await fetch(proxyUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        }
    });
    return { text: await res.text(), status: res.status, routedVia: 'zenrowsProvider' };
}

export const FETCH_PROVIDERS = {
  native: nativeFetchProvider,
  zenrows: zenrowsProvider,
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
