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
            // If our provider is rate-limiting us, this is a transient operational error, not a venue block.
            if (profileResponse.status === 429) {
                return { text: `Rate limited by ${providerName} provisioning API`, status: 429, routedVia: providerName };
            }
            throw new Error(`Failed to provision ${providerName} browser profile: ${profileResponse.statusText} (${profileResponse.status})`);
        }
        const profileData = await profileResponse.json();

        // Surfsky uses 'ws_url', others might use 'ws_endpoint' or similar.
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
        // The Cloudflare Workers fetch API requires using https:// for WebSocket upgrades.
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
                cdpSend('Runtime.evaluate', { expression: 'document.documentElement.outerHTML' }, pageSessionId)
                    .then(result => {
                        if (isSettled) return;
                        const pageContent = result.result.value || '';
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

                // Send an initial command to the new session to "warm it up" and prevent premature closure.
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
    const apiUrl = env.ZENROWS_API_URL || 'https://api.zenrows.com/v1/';
    const apiToken = env.ZENROWS_API_TOKEN;
    const waitTime = env.ZENROWS_WAIT_TIME || '7373';
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
    const proxyUrl = `${apiUrl}?${params.toString()}`;
    const res = await fetch(proxyUrl, {
        headers: {
            // Sending a realistic User-Agent is crucial for many sites.
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        }
    });
    return { text: await res.text(), status: res.status, routedVia: 'zenrowsProvider' };
}

export const FETCH_PROVIDERS = {
  native: nativeFetchProvider,
  zenrows: zenrowsProvider,
};