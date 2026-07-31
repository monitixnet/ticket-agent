// Generic abstraction helper to handle asynchronous execution pauses
const delayExecution = ms => new Promise(res => setTimeout(res, ms));

// =====================================================================
// GLOBAL DATA ABSTRACTION LAYER (Universal REST Bridge)
// =====================================================================
async function queryDatabaseCache(env, command, key, value = null) {
  if (!env || !env.DATABASE_REST_URL) {
    console.log("[LOCAL CRITICAL] env.DATABASE_REST_URL is completely undefined! Your .dev.vars file is not being read.");
    return null;
  }

  let url = `${env.DATABASE_REST_URL}/${command}/${key}`;
  if (value) url += `/${value}`;
  
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.DATABASE_REST_TOKEN}` }
    });
    
    const rawText = await response.text();
    console.log(`[UPSTASH DEBUG] Raw payload received for [${command} ${key}]: ${rawText}`);
    
    const data = JSON.parse(rawText);
    return data.result;
  } catch (e) {
    console.log(`[LOCAL DEBUG] Upstash REST endpoint handshake crashed: ${e.message}`);
    return null;
  }
}

async function fetchLocationConfiguration(env, locationId) {
  const raw = await queryDatabaseCache(env, 'GET', `ticket_agent:config:${locationId}`);
  return raw ? JSON.parse(raw) : null;
}

// =====================================================================
// UNIVERSAL ALERTS & COMMUNICATIONS LAYER
// =====================================================================
async function emitSystemActivityLog(env, locationId, message, logType = "SCAN") {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const logLine = `[${timestamp}] ${logType}: ${message}`;
  console.log(`[LOCAL LOG] Writing cache row: ${logLine}`);
  await queryDatabaseCache(env, 'LPUSH', `ticket_agent:${locationId}:activity_log`, encodeURIComponent(logLine));
  await queryDatabaseCache(env, 'LTRIM', `ticket_agent:${locationId}:activity_log`, '0/49');
}

async function dispatchSystemNotification(env, locationName, payloadLabel) {
  console.log(`[LOCAL NOTIFICATION] Dispatching alert message for ${locationName} -> ${payloadLabel}`);
  if (!env.NOTIFICATION_OUTBOUND_URL) return;
  const message = `INVENTORY MATRIX CHANGE\nLocation: ${locationName}\nTarget: ${payloadLabel}`;
  try {
    await fetch(`${env.NOTIFICATION_OUTBOUND_URL}${encodeURIComponent(message)}`);
  } catch (e) {
    console.log(`[LOCAL DEBUG] Notification endpoint failed: ${e}`);
  }
}

// =====================================================================
// VENDOR-AGNOSTIC NETWORK UTILITIES
// =====================================================================
async function executeSecureFetch(env, config, currentSecurityTier) {
  if (currentSecurityTier === "high" || config.requires_residential === true || config.security_tier === "high") {
    console.log(`[LOCAL NETWORK] Executing proxy request -> ${config.location_url}`);
    const targetUrl = encodeURIComponent(config.location_url);
    const proxyApiUrl = `${env.RESIDENTIAL_PROXY_GATEWAY}?apikey=${env.PROXY_GATEWAY_TOKEN}&url=${targetUrl}&js_render=true&premium_proxy=true`;
    
    const res = await fetch(proxyApiUrl);
    return { text: await res.text(), status: res.status, routedVia: "RESIDENTIAL_PROXY_GATEWAY" };
  }

  console.log(`[LOCAL NETWORK] Executing free edge fetch -> ${config.location_url}`);
  const res = await fetch(config.location_url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    redirect: "manual"
  });
  
  return { text: await res.text(), status: res.status, routedVia: "EDGE_NATIVE_FETCH" };
}

// =====================================================================
// MAIN ENGINE AUTOMATION LOOP
// =====================================================================
export default {
  async fetch(request, env, ctx) {
    return new Response("Local developer sandbox active. Trigger cron loops using /__scheduled");
  },

  async scheduled(event, env, ctx) {
    console.log("\n====================================================");
    console.log("[LOCAL ENGINE] Webhook trigger detected! Initializing tracking workflow...");
    console.log("====================================================");

    const randomInitialDelay = Math.floor(Math.random() * 100);
    await delayExecution(randomInitialDelay);

    console.log("[LOCAL ENGINE] Verifying environment configurations inside database...");
    
    const locationId = await queryDatabaseCache(env, 'GET', 'ticket_agent:active_location_id');
    
    if (!locationId) {
      console.log("[LOCAL ERROR] Could not read active pointer from database! Script terminating early.");
      return;
    }
    console.log(`[LOCAL ENGINE] Database returned active operational pointer target: ${locationId}`);

    const config = await fetchLocationConfiguration(env, locationId);
    
    const activeStatus = await queryDatabaseCache(env, 'GET', `ticket_agent:${locationId}:status`);
    if (!config || activeStatus === 'OFF') {
      console.log(`[LOCAL ENGINE] Location status for ID "${locationId}" is toggled OFF. Exiting cycle.`);
      return;
    }

    // TIME CURFEW EVALUATION
    const targetTimezone = config.timezone || "America/Los_Angeles";
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: targetTimezone, hour: 'numeric', minute: 'numeric', hour12: false });
    const parts = formatter.formatToParts(new Date());
    let hour = 0, minute = 0;
    for (const part of parts) {
      if (part.type === 'hour') hour = parseInt(part.value, 10);
      if (part.type === 'minute') minute = parseInt(part.value, 10);
    }
    const decimalTime = hour + (minute / 60.0);
    console.log(`[LOCAL ENGINE] Venue local time is currently ${hour}:${minute.toString().padStart(2, '0')} (Decimal: ${decimalTime.toFixed(2)})`);
    if (decimalTime >= 23.0 || decimalTime < 6.5) {
      console.log("[LOCAL ENGINE] Venue is currently inside sleeping hour curfews. Exiting cycle to save credits.");
      return;
    }

    await emitSystemActivityLog(env, locationId, "Monitoring active - Self-healing data engine online.", "SYSTEM");

    let networkPayload;
    try {
      let currentSecurityTier = await queryDatabaseCache(env, 'GET', `ticket_agent:security_tier:${locationId}`);
      if (!currentSecurityTier) currentSecurityTier = "low";
      console.log(`[LOCAL ENGINE] Active security level read from database cache: ${currentSecurityTier}`);

      networkPayload = await executeSecureFetch(env, config, currentSecurityTier);
      
      // AUTO-DETECTION HEURISTICS: Catches hidden server upgrades completely dynamically
      if (networkPayload.routedVia === "EDGE_NATIVE_FETCH") {
        const lowerText = (networkPayload.text || "").toLowerCase();
        const isAccessDenied = networkPayload.status === 403 || 
                               networkPayload.status === 401 ||
                               networkPayload.status === 302 ||
                               networkPayload.status === 301 ||
                               lowerText.includes("datadome") || 
                               lowerText.includes("akamai") || 
                               lowerText.includes("queue-it") ||
                               lowerText.includes("captcha");

        if (isAccessDenied) {
          console.log("[LOCAL ALERT] Native fetch caught an active bot firewall or redirect wall block!");
          await emitSystemActivityLog(env, locationId, "Firewall intercept triggered. Executing dynamic failover routing...", "MUTATION");
          
          // 🛡️ PROACTIVE LOCKDOWN: We commit your exact database logic instantly BEFORE initiating the fetch
          await queryDatabaseCache(env, "SET", `ticket_agent:security_tier:${locationId}`, "high");
          console.log("[LOCAL ENGINE] Database configuration successfully auto-healed and locked onto high tier proxies.");

          const targetUrl = encodeURIComponent(config.location_url);
          const proxyApiUrl = `${env.RESIDENTIAL_PROXY_GATEWAY}?apikey=${env.PROXY_GATEWAY_TOKEN}&url=${targetUrl}&js_render=true&premium_proxy=true`;

          console.log("[LOCAL ENGINE] Rerouting data fetch through premium browser proxy lines...");
          const failoverRes = await fetch(proxyApiUrl);
          networkPayload = { text: await failoverRes.text(), status: failoverRes.status, routedVia: "RESIDENTIAL_PROXY_GATEWAY" };
        }
      }

    } catch (err) {
      console.log(`[LOCAL FATAL] Critical script exception encountered: ${err.message}`);
      return;
    }

    const isMatchingSignature = config.sold_out_signatures.some(sig => networkPayload.text.includes(sig));
    if (isMatchingSignature) {
      await emitSystemActivityLog(env, locationId, `Scan verified via ${networkPayload.routedVia}: Target Sold Out`, "SCAN");
      console.log("[LOCAL ENGINE] Scan completed successfully. Target is currently SOLD OUT.");
    } else {
      await dispatchSystemNotification(env, config.name, "Available Allocation Verified Open");
      await emitSystemActivityLog(env, locationId, `Scan verified via ${networkPayload.routedVia}: Target Elements Found!`, "INVENTORY");
      console.log("[LOCAL ENGINE] Scan completed successfully. TICKETS DETECTED!");
    }
  }
};
