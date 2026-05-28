# Full Setup Guide (Windows) - Pump.fun Platform

This is the complete setup from zero to live data.

## What you need installed

- Node.js 20+ (includes npm)
- Docker Desktop (running)
- Git (optional but recommended)
- ngrok (for webhook tunneling to local machine)
- Helius account + API key

You do **not** need to manually install Redis or PostgreSQL on your machine if you use Docker Compose in this project.

## Redis and PostgreSQL: what this project uses

- **Redis**: used for streams/hot state (`redis://localhost:6379`)
- **PostgreSQL/Timescale**: used for durable storage (`postgresql://pump:pump@localhost:5432/pumpfun`)
- Both are provided by `infra/docker-compose.yml`

So your default path is:
- run Docker containers (recommended)
- do not install external Redis/Postgres unless you specifically want managed/external infra

## 1) Start infrastructure (Redis + Postgres/Timescale)

From repo root:

```powershell
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

Expected:
- `postgres` container is up on port `5432`
- `redis` container is up on port `6379`

If ports are already in use, stop local services using those ports or change compose mappings.

## 2) Install dependencies

From repo root:

```powershell
npm install
npm install -w backend
npm install -w dashboard
```

## 3) Configure backend env

Create `backend/.env` (copy from example):

```powershell
copy backend\.env.example backend\.env
```

Set values in `backend/.env`:

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
- `HELIUS_RPC_URL` must stay as-is; app appends your API key.
- `HELIUS_MONITORED_WALLETS` is required for polling path.
- If you only want webhook ingestion, you can still keep `HELIUS_MONITORED_WALLETS` empty.

## 4) Apply database schema

Use the SQL in `backend/src/db/schema.sql`.

### Option A (Docker container psql)

```powershell
docker exec -i $(docker compose -f infra/docker-compose.yml ps -q postgres) psql -U pump -d pumpfun < backend/src/db/schema.sql
```

### Option B (local psql client)

```powershell
psql "postgresql://pump:pump@localhost:5432/pumpfun" -f backend/src/db/schema.sql
```

## 5) Start backend and dashboard

Terminal 1:

```powershell
npm run dev -w backend
```

Terminal 2:

```powershell
npm run dev -w dashboard
```

Open:
- Dashboard: `http://localhost:3000`
- Backend health: `http://localhost:8080/health`

## 6) Expose local backend for Helius webhook

Run:

```powershell
ngrok http 8080
```

Copy HTTPS URL, example:
- `https://abcd-1234.ngrok-free.app`

Webhook target:
- `https://abcd-1234.ngrok-free.app/webhooks/helius`

## 7) Create webhook in Helius

In Helius dashboard:
- webhook URL = your ngrok URL + `/webhooks/helius`
- event source = enhanced transaction webhooks
- include relevant wallet/program filters
- set secret/header value equal to `HELIUS_WEBHOOK_SECRET`

Backend expects header:
- `x-helius-secret`

## 8) Verify full system

Run checks:

```powershell
curl http://localhost:8080/health
curl http://localhost:8080/api/ops/metrics
curl http://localhost:8080/api/tokens
curl http://localhost:8080/api/alerts
curl http://localhost:8080/api/probabilities
curl http://localhost:8080/api/backtest/calibration
```

If metrics queue and token data are increasing, ingestion is working.

## 9) Optional: test webhook path manually

```powershell
curl -X POST "http://localhost:8080/webhooks/helius" `
  -H "Content-Type: application/json" `
  -H "x-helius-secret: YOUR_RANDOM_SECRET" `
  -d "[{`"signature`":`"testsig`",`"slot`":123,`"timestamp`":1710000000,`"feePayer`":`"walletA`",`"type`":`"TRANSFER`",`"description`":`"test transfer`",`"tokenTransfers`":[{`"mint`":`"So11111111111111111111111111111111111111112`",`"tokenAmount`":1.2}]}]"
```

Expected:

```json
{"ok":true,"accepted":1}
```

## 10) If you already have Redis/Postgres on your machine

You can use them instead of Docker by changing:
- `REDIS_URL`
- `DATABASE_URL`

But keep versions compatible:
- Redis 7+
- PostgreSQL 16 + Timescale extension available

If Timescale extension is missing, schema steps for hypertables will fail.

## 11) Common failures and fixes

- Docker containers not running:
  - start Docker Desktop
  - rerun compose up
- DB connection errors:
  - check `DATABASE_URL`
  - ensure schema was applied
- Redis errors:
  - check `REDIS_URL`
  - ensure port `6379` is free
- No live data:
  - bad `HELIUS_API_KEY`
  - empty `HELIUS_MONITORED_WALLETS`
  - webhook not configured to your ngrok URL
- 401 on webhook:
  - `x-helius-secret` does not match `HELIUS_WEBHOOK_SECRET`

## 12) Operations checklist

- Monitor:
  - `GET /api/ops/metrics`
  - `GET /api/ops/deadletters`
- If dead letters accumulate:
  - replay with `POST /api/ops/deadletters/replay`
- Before major deploys:
  - confirm schema is applied
  - verify backend env and Redis/Postgres health

