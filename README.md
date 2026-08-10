# Ticket Agent

This project is a Cloudflare Worker for monitoring event inventory and validating live ticket availability across a curated set of venues and ticketing sources.

## Monitored targets

The worker is configured to track these venue targets during the initial validation pass:

- Segerstrom Center for the Arts
- Citizen Opera House
- ASU Gammage
- First Interstate Center for the Arts
- Orpheum Theatre Minneapolis
- Orpheum Theatre San Francisco
- Paramount Theatre Seattle
- Aronoff Center

Excluded from the current validation pass:

- Grand Ole Opry
- Broadway.com
- BroadwayDirect.com

## Local setup

Create a `.dev.vars` file at the root of this project folder and set the required environment variables for local development. The worker uses a Cloudflare D1 database, which should be configured in your `wrangler.toml` file.

```bash
# Example .dev.vars
FETCH_PROVIDER_POOL="zenrows"
ZENROWS_API_URL="https://api.zenrows.com/v1/"
ZENROWS_API_TOKEN="your_zenrows_api_token_here"
NOTIFICATION_OUTBOUND_URL="https://telegram.org..."
WEBHOOK_SHARED_SECRET="your_shared_secret_here"
```

`WEBHOOK_SHARED_SECRET` authenticates callers of the endpoints below. Requests must include it as an `X-Webhook-Secret` header; requests without a matching header are rejected with `401`. Generate a real value yourself — it's just a random secret, not tied to any external system — for example: `openssl rand -hex 32`. Whoever calls `/webhook/validate` or `/logs/recent` needs to be given that same value to send back as the header. Today that's limited to your own tooling and local testing, since there is no live Skybox integration yet (see [Hard boundaries](#hard-boundaries)).

Then initialize the database with the included seed file:

```bash
sqlite3 ticket-agent.db < database/schema.sql
sqlite3 ticket-agent.db < database/seed.sql
```

The Cloudflare D1 binding name used by the worker is `DB`, matching the code in [index.js](index.js).

For the deployed Cloudflare D1 database, use the equivalent SQL statements in the Wrangler console or run the same inserts through your database client.

Each listing stores its listed price as `price_cents` (integer cents) on the `listings` table. At validation time, the live-scraped price for that exact seat must match `price_cents` exactly, or the listing is rejected for a price-parity failure.

## Worker routes

- GET / — service status and configured target list
- GET /monitoring/targets — full JSON registry of monitored venues and sources
- GET /logs/recent — recent persisted worker logs (requires `X-Webhook-Secret`)
- POST /webhook/validate — live seat validation endpoint used by the gatekeeper flow (requires `X-Webhook-Secret`)

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
npx wrangler secret put WEBHOOK_SHARED_SECRET
```

These variables are required for the app to connect to your database, proxy gateway, and notification endpoint in both local and deployed environments. `WEBHOOK_SHARED_SECRET` must also be configured on whatever system calls `/webhook/validate` or `/logs/recent`, sent as the `X-Webhook-Secret` header.