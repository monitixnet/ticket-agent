# Ticket Agent

## Run Ticket Agent locally

Create a .dev.vars file at the root of this project folder.

Set the required environment variables before starting the app:

```bash
DATABASE_REST_URL="https://your-upstash-database-link.com"
DATABASE_REST_TOKEN="your_upstash_secret_token_here"
RESIDENTIAL_PROXY_GATEWAY="https://scrapingdog.com"
PROXY_GATEWAY_TOKEN="your_scrapingdog_api_key_here"
NOTIFICATION_OUTBOUND_URL="https://telegram.org..."
```

## Deploying Ticket Agent

```bash
npx wrangler deploy
```

After deployment returns a live confirmation URL, add these five secrets to finish setup:

```bash
npx wrangler secret put DATABASE_REST_URL
npx wrangler secret put DATABASE_REST_TOKEN
npx wrangler secret put RESIDENTIAL_PROXY_GATEWAY
npx wrangler secret put PROXY_GATEWAY_TOKEN
npx wrangler secret put NOTIFICATION_OUTBOUND_URL
```

These variables are required for the app to connect to your Upstash database, proxy gateway, and notification endpoint in both local and deployed environments.