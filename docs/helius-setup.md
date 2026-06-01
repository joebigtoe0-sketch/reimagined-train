# Helius Live Setup

> **Current architecture (2026):** PumpPortal WebSocket is the only launch/trade feed.
> Helius should be used **only** for Jito-bundle retrocheck (standard JSON-RPC).
> Set `HELIUS_WEBHOOK_ENABLED=false` and **delete any Enhanced Webhook** in the
> Helius dashboard — webhook events are what burn millions of credits per hour.

This guide connects the backend to real Helius data using:
- RPC polling (`getSignaturesForAddress` + enhanced transaction decode)
- Webhook ingestion (`POST /webhooks/helius`)

## 1) Configure backend env

Create or update `backend/.env`:

```bash
PORT=8080
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://pump:pump@localhost:5432/pumpfun
SNAPSHOT_INTERVAL_MS=5000
INGEST_INTERVAL_MS=1200

HELIUS_API_KEY=YOUR_HELIUS_API_KEY
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=
HELIUS_MONITORED_WALLETS=walletA,walletB,walletC
HELIUS_WEBHOOK_SECRET=YOUR_RANDOM_SECRET
```

Notes:
- `HELIUS_RPC_URL` should remain exactly as above; the backend appends `HELIUS_API_KEY`.
- `HELIUS_MONITORED_WALLETS` must be a comma-separated list of valid Solana addresses.
- If `HELIUS_MONITORED_WALLETS` is empty, RPC polling yields no events.

## 2) Start local services

From repo root:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run dev -w backend
```

## 3) Expose backend for webhook delivery

Helius must reach your `/webhooks/helius` endpoint from the internet.
For local development, use ngrok:

```bash
ngrok http 8080
```

Copy the HTTPS URL (example: `https://abcd-1234.ngrok-free.app`).

## 4) Create Helius webhook

Use either Helius dashboard or API.

### Option A: Dashboard
- Open Helius dashboard webhooks section
- Target URL: `https://<your-ngrok-domain>/webhooks/helius`
- Add request header:
  - `x-helius-secret: YOUR_RANDOM_SECRET`
- Subscribe to transaction/enhanced transaction events for relevant wallets/programs

### Option B: API (example curl)

```bash
curl -X POST "https://api.helius.xyz/v0/webhooks?api-key=YOUR_HELIUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookURL": "https://<your-ngrok-domain>/webhooks/helius",
    "transactionTypes": ["Any"],
    "accountAddresses": ["walletA","walletB"],
    "webhookType": "enhanced",
    "authHeader": "YOUR_RANDOM_SECRET"
  }'
```

If you use `authHeader`, ensure Helius sends it as `x-helius-secret` (or configure your webhook provider accordingly).

## 5) Verify ingestion

### Health
```bash
curl http://localhost:8080/health
```

### Metrics and queue
```bash
curl http://localhost:8080/api/ops/metrics
```

### Tokens/alerts updates
```bash
curl http://localhost:8080/api/tokens
curl http://localhost:8080/api/alerts
```

### Webhook smoke test

Send a minimal payload to confirm auth + decode path:

```bash
curl -X POST "http://localhost:8080/webhooks/helius" \
  -H "Content-Type: application/json" \
  -H "x-helius-secret: YOUR_RANDOM_SECRET" \
  -d '[{
    "signature":"testsig",
    "slot":123,
    "timestamp":1710000000,
    "feePayer":"walletA",
    "type":"TRANSFER",
    "description":"test transfer",
    "tokenTransfers":[{"mint":"So11111111111111111111111111111111111111112","tokenAmount":1.2}]
  }]'
```

Expected response:

```json
{"ok":true,"accepted":1}
```

## 6) Common issues

- `accepted: 0` on webhook:
  - payload shape may not match enhanced transaction format
  - missing `signature` in payload rows
- `401 unauthorized`:
  - `x-helius-secret` does not match `HELIUS_WEBHOOK_SECRET`
- No polling events:
  - empty or invalid `HELIUS_MONITORED_WALLETS`
  - invalid `HELIUS_API_KEY`
- No DB persistence:
  - verify `DATABASE_URL` and Timescale/Postgres container health

