# Ticket Agent

This project is a Cloudflare Worker for monitoring event inventory and validating live ticket availability. Venue master data and runtime adapters are loaded from D1, not application code.

## Venue control plane

`venues` is the master venue list. `venue_runtime_configs` holds each venue's non-secret adapter configuration and lifecycle status (`draft`, `validated`, `active`, or `paused`). The Worker queries only `active` configurations at runtime, so adding or pausing a venue does not require a code deployment.

Strategy names are intentionally allowlisted in code; D1 selects an approved strategy but cannot execute arbitrary code. Secrets are never stored in D1: `credential_refs_json` contains only a Worker-secret name, such as `ALGOLIA_SEGERSTROM_API_KEY`.

### Configuration boundaries

Operational controls belong in `venue_runtime_configs.config_json` in D1: adapter endpoint templates, fetch-provider policy, discovery limits, batch sizes, monitoring hours, inventory rules, listing gates, and diagnostic flags. This makes D1 the auditable control plane and avoids committing venue policy to the Worker deployment. Some legacy environment-variable reads are being migrated into this control plane; do not rely on a missing D1 value falling back to a deployment variable.

Each venue Worker keeps only its bootstrap identity and D1 binding in `wrangler.jsonc`:

```jsonc
"vars": {
  "WORKER_VENUE_ID": "segerstrom_center"
},
"d1_databases": [{
  "binding": "DB",
  "database_name": "ticket-agent-db",
  "database_id": "...",
  "migrations_dir": "migrations"
}]
```

`WORKER_VENUE_ID` is intentionally outside D1. It scopes one deployed Worker to one tenant/venue, so a configuration error cannot cause it to operate across all active venues. Keep secret values—API keys, webhook credentials, and notification URLs—in Cloudflare Worker Secrets, never in D1 or Git.

Discovery persists every production's latest sale outcome in D1, including the overall status, sale-start timestamp, and sub-item status counts. Past, not-on-sale, and free-no-ticket productions are recorded as exclusions and removed from recurring discovery. On-sale productions are refreshed every six hours; future-sale productions are rechecked at their advertised sale start; sold-out productions are retained and rechecked hourly until they are linked into the separate drop-watch lane.

## Local setup

Create a `.dev.vars` file at the root of this project folder and set only the required secrets and bootstrap venue identity for local development. The Worker uses a Cloudflare D1 database configured in `wrangler.jsonc`; operational policy is progressively loaded from D1.

```bash
# Example .dev.vars
WORKER_VENUE_ID="segerstrom_center"
ALGOLIA_SEGERSTROM_API_KEY="your_segerstrom_algolia_search_key"
NOTIFICATION_OUTBOUND_URL="https://telegram.org..."
CRITICAL_NOTIFICATION_OUTBOUND_URL="https://telegram.org..."
WEBHOOK_SHARED_SECRET="your_shared_secret_here"
VENUE_SESSION_ENCRYPTION_KEY="base64_encoded_32_byte_key"
```

When D1 debug telemetry is enabled for a venue, inventory requests record response metadata in `inventory_endpoint_telemetry`: event/job, endpoint type, provider, HTTP status, content type, redirect indicator, outcome, and duration. It never stores cookies, request headers, URLs with query data, or response bodies. Rows are retained for 30 days. This diagnostic control is independent of Telegram debug notifications.

### Venue validation recovery

SeatMe can return a human-validation HTML page with HTTP `200`, rather than JSON. The Worker recognizes the page from its explicit validation markers, records an endpoint-telemetry outcome of `venue_validation_challenge`, sends one critical operational notification, and sets a venue-wide cooldown. The inventory event is returned to the front of its leased queue; the job is checkpointed and cannot be marked complete during that cooldown. The Worker never attempts to read or submit a CAPTCHA or validation code.

`WEBHOOK_SHARED_SECRET` authenticates callers of the endpoints below. Requests must include it as an `X-Webhook-Secret` header; requests without a matching header are rejected with `401`. Generate a real value yourself — it's just a random secret, not tied to any external system — for example: `openssl rand -hex 32`. Whoever calls `/webhook/validate` or `/logs/recent` needs to be given that same value to send back as the header. Today that's limited to your own tooling and local testing, since there is no live Skybox integration yet (see [Hard boundaries](#hard-boundaries)).

Then initialize local D1 using the versioned migrations and seed file:

```bash
npx wrangler d1 migrations apply ticket-agent-db --local
npx wrangler d1 execute ticket-agent-db --local --file=database/seed.sql
```

### Inspect venue runtime configuration

Venue policy is stored in D1, not in source code. To inspect Segerstrom's active runtime configuration locally:

```bash
npx wrangler d1 execute ticket-agent-db --local --command "
SELECT
  c.venue_id,
  c.status,
  json_extract(c.config_json, '$.apiFetchProviderPool') AS api_fetch_provider_pool,
  json_extract(c.config_json, '$.fetchProviderPool') AS fetch_provider_pool,
  json_extract(c.config_json, '$.discoveryMaxPages') AS discovery_max_pages,
  json_extract(c.config_json, '$.discoveryBatchSize') AS discovery_batch_size,
  json_extract(c.config_json, '$.inventoryMaxEventsPerRun') AS inventory_max_events_per_run,
  json_extract(c.config_json, '$.inventoryExternalRequestBudget') AS inventory_request_budget,
  json_extract(c.config_json, '$.checkoutFeeRule') AS checkout_fee_rule,
  json_extract(c.config_json, '$.debugTelemetryEnabled') AS debug_telemetry_enabled,
  json_extract(c.config_json, '$.discoveryAllowedHalls') AS discovery_allowed_halls
FROM venue_runtime_configs c
WHERE c.venue_id = 'segerstrom_center';
"
```

Use the same command with `--remote` to inspect production. To view the complete non-secret configuration JSON, run:

```bash
npx wrangler d1 execute ticket-agent-db --remote --command "
SELECT venue_id, status, config_json
FROM venue_runtime_configs
WHERE venue_id = 'segerstrom_center';
"
```

`credential_refs_json` may be inspected to see secret *names*, but never contains secret values.

### Native SeatMe session bootstrap

Segerstrom can require a normal SCFTA cart bootstrap before SeatMe inventory APIs return JSON. The Worker supports an opt-in, venue-scoped session manager: it stores only server-issued cookies encrypted with AES-GCM in `system_state`, reuses them for native SeatMe API calls, and performs one cart bootstrap plus one retry when SeatMe returns a session redirect. It never imports browser/Postman cookies, logs values, or sends those cookies through a proxy provider.

Generate the required secret locally with `openssl rand -base64 32` and set it as `VENUE_SESSION_ENCRYPTION_KEY` in `.dev.vars`; set the same value as a Worker secret before enabling the feature remotely. Enable it only in the relevant venue's D1 `config_json`:

```sql
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.sessionBootstrapEnabled', true,
  '$.sessionTtlMinutes', 15
)
WHERE venue_id = 'segerstrom_center';
```

The manager activates only when that venue uses the native API provider pool exclusively. Test `/operations/session-smoke-test` first; do not enable scheduled use until the isolated test returns `section_availability_array`.

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
npm run dev:segerstrom
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

Run only one local Worker process at a time; a second Worker can lock Wrangler's SQLite development state.

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
- POST /discovery/single-production — authenticated, exact Tessitura production discovery that does not advance the scheduled discovery job (requires `X-Webhook-Secret`)
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

To test one Tessitura production without changing the scheduled discovery checkpoint:

```bash
curl -X POST http://localhost:8787/discovery/single-production \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SHARED_SECRET" \
  --data '{"production_id":"30573","title":"Phantom of the Opera"}'
```

All-events inventory uses the same event scan path as `/inventory/single-event`. It resumes one leased D1 job per venue and processes as many events as fit within the configured external-request and runtime budgets. `inventoryMaxEventsPerRun` is only a ceiling for cheap availability-only checks; it is not a fixed batch size. Segerstrom uses a 48-request shared invocation budget (below Cloudflare's 50-subrequest limit), a `45000` ms runtime budget, target quantity packs `[2,4,6,8,10]`, and two backup blocks. Broad inventory scans only events most recently classified by discovery as `on_sale` or `sold_out`; all other classifications are excluded. If its venue-local monitoring window is closed, the scheduler records a curfew audit entry and starts no job, lease, cleanup, external request, or notification work.

### Sold-out drop watch

High-priority drop watches are separate from resale candidate rules. Every successful inventory scan records a performance state. A scan with zero available seats records `sold_out`; that performance is then automatically promoted into the priority drop lane. A later successful scan with any available seat creates one durable D1 alert and immediately delivers it through `CRITICAL_NOTIFICATION_OUTBOUND_URL`. Failed deliveries stay in `inventory_drop_alerts` and retry with bounded backoff. The alert is re-armed only after that performance becomes sold out again.

Qualified candidate alerts use `NOTIFICATION_OUTBOUND_URL`. A deep scan sends one concise message when its best actionable candidate set is new or materially changed. It contains only the target block—quantity, section, row, seats, and price. The two qualifying backup blocks remain an internal safety rule and are never included in Telegram. Alerts are durable and deduplicated per event; a later scan that finds no candidates marks any undelivered candidate alert obsolete.

#### Checkout-fee rules

`checkoutFeeRule` is venue-scoped D1 policy used only to calculate the displayed candidate economics; it never adds a seat to a cart or places an order. Migration `0036_add_segerstrom_checkout_fee_rule.sql` sets Segerstrom's verified rule to 18% per ticket, rounded to cents per ticket. Candidate Telegram messages then show ticket price, checkout fee, all-in per-ticket price, and all-in quantity total. Do not copy this rule to another venue without verifying that venue's own checkout response.

Migration `0017_inventory_drop_watch.sql` seeds `Phantom of the Opera` at Segerstrom as a critical five-minute watch. Drop alerts currently fire for every confirmed ticket drop regardless of price; each Telegram includes observed price ranges and seat details. Drop watch has its own every-five-minute schedule (`*/5`) and does not run an all-events batch. Newly discovered sold-out events default to `medium` priority (30 minutes); `high` runs every 10 minutes, `low` every 60 minutes, and critical runs every five minutes. Explicit rules are always scoped by venue ID and exact saved show name; automatic sold-out monitoring needs no explicit rule. Segerstrom's `dropWatchBatchSize` is 20, enough to cover all current Phantom performances in one bounded pass. General inventory runs at `:07, :17, :27, :37, :47, :57`; listing watch runs at `:12, :32, :52`; discovery runs hourly at `:03` (`3 * * * *`). The Worker uses each venue's D1-configured local monitoring window as a hard curfew and records a structured no-work audit log when it is closed.

Before every drop-watch pass, the Worker audits enabled `critical` rules. If any future watched performance has not had a successful inventory observation within twice its interval (10 minutes for a five-minute rule), it writes a structured error log and sends a throttled critical Telegram alert. The health alert never blocks the recovery scan; notification failure is logged and retried on the next pass. This protects against stale legacy data, scheduler gaps, and silent venue-access failures.

#### Set an eligible-drop price rule

`inventory_watch_rules.max_price_cents` is an **optional maximum ticket price**. `NULL` means every available ticket is eligible. A cap applies only to alerts for that exact `venue_id` and exact saved `show_name`; it never affects another venue or show.

`enabled = 0` disables that rule's priority and price override; it does not opt a currently sold-out event out of automatic drop monitoring. Automatic monitoring is deliberately driven by the latest discovery status.

Use the following command for a $170-or-less rule (replace the show and price as needed):

```bash
npx wrangler d1 execute ticket-agent-db --remote --command "
INSERT INTO inventory_watch_rules (
  id, venue_id, show_name, enabled, scan_interval_minutes, max_price_cents, priority
) VALUES (
  'segerstrom_center:watch:phantom-of-the-opera',
  'segerstrom_center', 'Phantom of the Opera', 1, 5, 17000, 'critical'
)
ON CONFLICT(venue_id, show_name) DO UPDATE SET
  enabled = 1,
  max_price_cents = excluded.max_price_cents,
  priority = excluded.priority,
  updated_at = CURRENT_TIMESTAMP;
"
```

To alert for **all prices** again, keep the same venue and show name and set the cap to `NULL`:

```bash
npx wrangler d1 execute ticket-agent-db --remote --command "
UPDATE inventory_watch_rules
SET max_price_cents = NULL, updated_at = CURRENT_TIMESTAMP
WHERE venue_id = 'segerstrom_center'
  AND show_name = 'Phantom of the Opera';
"
```

The price must be stored in cents: `$170.00` is `17000`, `$99.50` is `9950`. `scan_interval_minutes` is retained for schema compatibility; priority determines the active drop-watch cadence. The Telegram alert always includes the observed price range, even when the rule has no cap.

Add `"include_seat_samples":true` to return real contiguous seat blocks for manual review.

## Monitoring-only listing toggle

The worker supports a safety gate to keep the system in monitoring-only mode during the early validation phase.

Set one of the following environment values to true before turning on outbound listing approval:

- ALLOW_SKYBOX_LISTING=true
- SKYBOX_LISTING_ENABLED=true

If the flag is not enabled, the worker will continue monitoring and validating inventory, but it will reject any listing approval request with a MONITOR_ONLY response instead of sending a live Skybox approval.

This is the recommended default while the system is being tested in production-like conditions.

### Skybox venue mapping (required before listing)

Discovery uses the internal venue and hall pair `segerstrom_center` / `Segerstrom Hall`. Before any Skybox listing workflow is enabled, use Skybox's venue-name automation to search for **Segerstrom Hall**, manually confirm the returned venue once, and save its stable Skybox venue ID against that exact internal pair.

Use the saved Skybox venue ID for all later listing actions. Do not perform a fuzzy venue-name search for every listing, and fail closed if the saved mapping is missing or ambiguous. This mapping is a setup record only; it does not enable outbound listings.

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

### Segerstrom Worker

`wrangler.jsonc` is the deployment configuration for the Segerstrom Worker. It names that Worker `ticket-agent-segerstrom` and binds it to only `segerstrom_center` through `WORKER_VENUE_ID`.

```bash
npm run deploy:segerstrom
```

### Additional venue Workers

Each venue gets an independent Worker deployment from this same repository. Copy [wrangler.venue.example.jsonc](wrangler.venue.example.jsonc), set its Worker name and `WORKER_VENUE_ID`, then connect the new Cloudflare Worker to this repository with:

```text
Build command:  npm test
Deploy command: npx wrangler deploy --config wrangler.<venue>.jsonc
```

The configuration must use the same D1 binding while every Worker has its own secret bindings, schedules, provider budget, and venue ID. Do not deploy a multi-venue Worker without a `WORKER_VENUE_ID`; the application fails closed and loads no venues.

After creating a Worker, add its required secrets in that Worker's Cloudflare settings:

```bash
npx wrangler secret put ALGOLIA_SEGERSTROM_API_KEY
npx wrangler secret put VENUE_SESSION_ENCRYPTION_KEY
npx wrangler secret put NOTIFICATION_OUTBOUND_URL
npx wrangler secret put WEBHOOK_SHARED_SECRET
```

Secrets are Worker-specific and never belong in Git or `wrangler*.jsonc`. A venue only needs the secrets referenced by its active D1 runtime configuration. `WEBHOOK_SHARED_SECRET` must also be configured on whatever system calls `/webhook/validate` or `/logs/recent`, sent as the `X-Webhook-Secret` header.
