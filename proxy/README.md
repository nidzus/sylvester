# The Sylvester server

A small Cloudflare Worker for the iPhone app's **invite-code** mode: invited people use the Coach on your Anthropic account, each with a monthly allowance. It also does the two Oura sign-in steps that need Oura's client secret.

It keeps invites, hashed tokens and monthly totals, nothing else. Requests (which carry people's health data) are passed to Anthropic and back, never logged or stored. People who use their own API key never touch it, except to sign in to Oura.

## Deploy (about 10 minutes, free tier is enough)

You need a Cloudflare account and an Anthropic API key with billing set up (console.anthropic.com). Set a monthly spend limit there too: it's the backstop if anything here goes wrong.

```
cd proxy
npm install
npx wrangler login
npx wrangler kv namespace create SYLVESTER        # paste the id into wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY          # your key
npx wrangler secret put ADMIN_TOKEN                # any long random string; you use it to make invites
npx wrangler deploy                                # prints https://sylvester.<you>.workers.dev
```

Put that address in `mobile/app.json` → `expo.extra.serverUrl` before you build the app, so people only type the invite code.

## Invites

```
curl -X POST https://sylvester.<you>.workers.dev/admin/invites \
  -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"monthly_usd": 5, "uses": 1, "label": "a friend"}'
# -> {"code": "..."}   send the code to your friend; it works once
```

`GET /admin/users` (same header) lists who joined and what they used this month. Allowances reset on the 1st (UTC). Totals are estimated from token counts at list prices, and Cloudflare KV is eventually consistent, so two requests at the same moment can go slightly over: keep the Anthropic console limit as the hard cap.

What a person can do with a token: call the models in `ALLOWED_MODELS`, non-streaming, at most `MAX_TOKENS` per request, with the app's own tools only (no web search, MCP servers or code execution on your account).

## Oura (optional)

1. Register an API application at cloud.ouraring.com (Developer). Redirect URI: `https://sylvester.<you>.workers.dev/oura/callback`.
2. `npx wrangler secret put OURA_CLIENT_ID` and `OURA_CLIENT_SECRET`.
3. In the app: Settings → Connect Oura.

Oura limits how many people an unreviewed application can connect; check their developer terms before inviting many.

## Tests

`npm test` runs the server against an in-memory store with stand-ins for Anthropic and Oura (no keys, no network).
