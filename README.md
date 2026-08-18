# Ticket Agent

This project is a Cloudflare Worker for monitoring event inventory and validating live ticket availability. Venue master data and runtime adapters are loaded from D1, not application code.

## Venue control plane

`venues` is the master venue list. `venue_runtime_configs` holds each venue's non-secret adapter configuration and lifecycle status (`draft`, `validated`, `active`, or `paused`). The Worker queries only `active` configurations at runtime, so adding or pausing a venue does not require a code deployment.

Strategy names are intentionally allowlisted in code; D1 selects an approved strategy but cannot execute arbitrary code. Secrets are never stored in D1: `credential_refs_json` contains only a Worker-secret name, such as `ALGOLIA_SEGERSTROM_API_KEY`.

## Local setup

Create a `.dev.vars` file at the root of this project folder and set the required environment variables for local development. The worker uses a Cloudflare D1 database, which should be configured in your `wrangler.toml` file.

```bash
# Example .dev.vars
FETCH_PROVIDER_POOL="native"
API_FETCH_PROVIDER_POOL="native"
DISCOVERY_MAX_PAGES="100"
DISCOVERY_BATCH_SIZE="30"
DISCOVERY_SUMMARY_NOTIFICATIONS="false"
ALGOLIA_SEGERSTROM_API_KEY="your_segerstrom_algolia_search_key"
SCRAPEFLY_API_KEY="your_scrapefly_api_key"
NOTIFICATION_OUTBOUND_URL="https://telegram.org..."
CRITICAL_NOTIFICATION_OUTBOUND_URL="https://telegram.org..."
WEBHOOK_SHARED_SECRET="your_shared_secret_here"
ALLOW_SKYBOX_LISTING="false"
ENABLE_AUTOMATED_APPROVAL="false"
```

`DISCOVERY_SUMMARY_NOTIFICATIONS` is optional and only governs the queue-completion discovery summary sent through the outbound notification channel. Leave it off during normal monitoring unless you want a Telegram summary after each discovery cycle. It is designed to be an explicit operational opt-in to avoid noisy alerts during routine scans.

`WEBHOOK_SHARED_SECRET` authenticates callers of the endpoints below. Requests must include it as an `X-Webhook-Secret` header; requests without a matching header are rejected with `401`. Generate a real value yourself — it's just a random secret, not tied to any external system — for example: `openssl rand -hex 32`. Whoever calls `/webhook/validate` or `/logs/recent` needs to be given that same value to send back as the header. Today that's limited to your own tooling and local testing, since there is no live Skybox integration yet (see [Hard boundaries](#hard-boundaries)).

Then initialize local D1 using the versioned migrations and seed file:

```bash
npx wrangler d1 migrations apply ticket-agent-db --local
npx wrangler d1 execute ticket-agent-db --local --file=database/seed.sql
```

### Reset local discovery progress

To rerun the full Segerstrom discovery queue after a parser or provider change, stop `wrangler dev` and run:

```bash
npx wrangler d1 execute ticket-agent-db --local --command "DELETE FROM system_state WHERE key_name = 'segerstrom_discovery_job';"
```

This clears only the saved discovery checkpoint. Existing venues, shows, events, and listings remain intact; repeated discoveries are duplicate-safe.

The Cloudflare D1 binding name used by the worker is `DB`, matching the code in [index.js](index.js).

### Run local scheduled jobs

Start one local Worker terminal first:

```bash
npx wrangler dev
```

Then, from a second terminal, trigger the desired bounded job:

```bash
# All-events inventory job: resumes its D1 checkpoint and processes one batch.
curl -i "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-inventory-scan"

# Runs only the high-priority sold-out drop-watch lane.
curl -i "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-drop-watch"

# Full discovery job: resumes its D1 checkpoint and processes one batch.
curl -i "http://localhost:8787/cdn-cgi/local/scheduled?cron=test-discovery-scan"
```

Run only one `npx wrangler dev` process at a time; a second local Worker can lock Wrangler's SQLite development state.

For deployed Cloudflare D1, apply migrations before deployment and seed once:

```bash
npx wrangler d1 migrations apply ticket-agent-db --remote
npx wrangler d1 execute ticket-agent-db --remote --file=database/seed.sql
```

Before enabling Segerstrom, set its credential as a Worker secret (not in `wrangler.jsonc` or D1):

```bash
npx wrangler secret put ALGOLIA_SEGERSTROM_API_KEY
```

For a new venue, insert its master row in `venues`, insert a `draft` adapter in `venue_runtime_configs`, validate the adapter, then change its status to `active`. `config_json` supports strategy names, endpoint templates, per-venue `businessHours`, rate limits, and `discoveryBatchSize`. Never put credential values in either table; use a named Worker-secret reference in `credential_refs_json`.

`ALLOW_SKYBOX_LISTING` and `ENABLE_AUTOMATED_APPROVAL` must both be explicitly enabled before the validation webhook can return an approval. Keep both `false` until a signed, replay-protected upstream integration has been implemented and reviewed.

Each listing stores its listed price as `price_cents` (integer cents) on the `listings` table. At validation time, the live-scraped price for that exact seat must match `price_cents` exactly, or the listing is rejected for a price-parity failure.

## Worker routes

- GET / — service status and configured target list
- GET /monitoring/targets — full JSON registry of monitored venues and sources
- GET /logs/recent — recent persisted worker logs (requires `X-Webhook-Secret`)
- POST /inventory/single-event — authenticated, exact-event monitoring-only scan (requires `X-Webhook-Secret`); `/inventory/test` remains a compatibility alias
- POST /operations/run — authenticated bounded operational pass; body `{"mode":"discovery_scan"}`, `{"mode":"drop_watch"}`, or `{"mode":"inventory_scan"}`
- POST /webhook/validate — live seat validation endpoint used by the gatekeeper flow (requires `X-Webhook-Secret`)

To test one saved upcoming event without letting the scheduler select a different one:

```bash
curl -X POST http://localhost:8787/inventory/single-event \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SHARED_SECRET" \
  --data '{"event_id":"30584","quantity":2}'
```

The endpoint is monitoring-only. For Segerstrom Hall, it saves only target blocks that have the configured number of contiguous, non-overlapping same-or-forward-row backup blocks at the same section, price level, and seat quality. `inventoryBufferBlockCount` lives in the venue runtime configuration and defaults to `2`; set it to `1` to allow one backup block. It never approves a listing or sends an outbound sale action. An optional `target` with `section`, `row`, `seat`, and `price_cents` additionally performs the exact-seat and price-parity checks used at final listing validation.

All-events inventory uses the same event scan path as `/inventory/single-event`. It resumes one leased D1 job per venue, processing up to `inventoryBatchSize` events or `inventoryMaxRunDurationMs` per cron invocation. Segerstrom defaults are `5` events, `45000` ms, target quantities `[2,6]`, and two backup blocks.

### Sold-out drop watch

High-priority drop watches are separate from resale candidate rules. Every successful inventory scan records a performance state. A scan with zero available seats records `sold_out`; that performance is then automatically promoted into the priority drop lane. A later successful scan with any available seat creates one durable D1 alert and immediately delivers it through `CRITICAL_NOTIFICATION_OUTBOUND_URL`. Failed deliveries stay in `inventory_drop_alerts` and retry with bounded backoff. The alert is re-armed only after that performance becomes sold out again.

Migration `0017_inventory_drop_watch.sql` seeds `Phantom of the Opera` at Segerstrom with a five-minute desired interval, so it receives priority immediately instead of waiting for its first broad scan. Drop watch has its own every-five-minute schedule (`*/5`) and does not run an all-events batch. Segerstrom's `dropWatchBatchSize` is `12`, enough to cover all currently discovered Phantom performances in one bounded pass. Other successfully observed sold-out performances are automatically prioritized at `automaticSoldOutIntervalMinutes` (5). General inventory runs separately at `9,29,59`; discovery runs every five minutes offset at `3-58/5`, completing the current 143-production catalog in about 75 minutes at ten productions per checkpoint. To add another exact show, insert an enabled `inventory_watch_rules` row with its venue ID, exact saved show name, and desired interval; do not put notification URLs or secrets in D1.

Add `"include_seat_samples":true` to return real contiguous seat blocks for manual review.

## Monitoring-only listing toggle

The worker supports a safety gate to keep the system in monitoring-only mode during the early validation phase.

Set one of the following environment values to true before turning on outbound listing approval:

- ALLOW_SKYBOX_LISTING=true
- SKYBOX_LISTING_ENABLED=true

If the flag is not enabled, the worker will continue monitoring and validating inventory, but it will reject any listing approval request with a MONITOR_ONLY response instead of sending a live Skybox approval.

This is the recommended default while the system is being tested in production-like conditions.

## Current milestone requirement

The current milestone explicitly requires a real venue adapter contract for each active venue before we consider the validation loop production-ready.

For each active venue, the adapter must define:

- source URL pattern or event landing base
- required inventory fields for section, row, seat, price level, and seat quality
- normalization rules for section/row/seat labels
- freshness check requirements
- smoke-test validation criteria for the active business window
- a non-live monitoring-only status while the validation pass is under review

This requirement remains active even though outbound approval stays disabled for this release.

## Hard boundaries

The following are explicit non-goals for this phase and must remain true:

- Do not build or depend on a real Skybox or Vivid Seats listing API integration in this project.
- Do not approve or publish live outbound listings while the system is in monitoring-only validation mode.

### Reserved variables (not yet used)

`SKYBOX_API_GATEWAY_URL` and `SKYBOX_API_TOKEN` may appear in your `.dev.vars` as placeholders. No code in this project currently reads either variable — per the hard boundaries above, this project does not build or depend on a real Skybox listing API in this phase. Leave them as placeholders; a real value would only come from Skybox directly, once a vetted, legally-reviewed integration is actually approved. Setting one today has no effect on the worker.

## Deploying Ticket Agent

```bash
npx wrangler deploy
```

After deployment returns a live confirmation URL, add the required secrets:

```bash
npx wrangler secret put FETCH_PROVIDER_POOL
npx wrangler secret put ZENROWS_API_URL
npx wrangler secret put ZENROWS_API_TOKEN
npx wrangler secret put NOTIFICATION_OUTBOUND_URL
npx wrangler secret put DISCOVERY_SUMMARY_NOTIFICATIONS
npx wrangler secret put WEBHOOK_SHARED_SECRET
```

These variables are required for the app to connect to your database, proxy gateway, and notification endpoint in both local and deployed environments. `DISCOVERY_SUMMARY_NOTIFICATIONS` is optional but recommended only when you want discovery-cycle summaries in Telegram; the worker will otherwise stay quiet unless a higher-priority alert is triggered. `WEBHOOK_SHARED_SECRET` must also be configured on whatever system calls `/webhook/validate` or `/logs/recent`, sent as the `X-Webhook-Secret` header.
