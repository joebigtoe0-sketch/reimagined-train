# Railway Deployment Guide (Backend + Dashboard)

This repo is a monorepo with:
- `backend` (Fastify API + websockets)
- `dashboard` (Next.js frontend)

Deploy both as separate Railway services in one project.

## 1) Prepare Git repository

Railway deploys from GitHub/GitLab repos. Ensure this folder is a real git repo and pushed.

## 2) Create Railway project and services

In Railway:
- Create a new project from your repo
- Add service **A** from root directory `backend`
- Add service **B** from root directory `dashboard`
- Add **PostgreSQL** plugin service
- Add **Redis** plugin service

Both app services include `railway.json` in their own directories.

## 3) Backend environment variables

Set these on backend service:

- `PORT` = Railway-provided automatically
- `DATABASE_URL` = reference Railway Postgres `DATABASE_URL`
- `REDIS_URL` = reference Railway Redis `REDIS_URL`
- `SNAPSHOT_INTERVAL_MS` = `5000`
- `INGEST_INTERVAL_MS` = `1200`
- `HELIUS_API_KEY` = your Helius key
- `HELIUS_RPC_URL` = `https://mainnet.helius-rpc.com/?api-key=`
- `HELIUS_MONITORED_WALLETS` = comma-separated wallets
- `HELIUS_WEBHOOK_SECRET` = random secret string

## 4) Dashboard environment variables

Set this on dashboard service:

- `PORT` = Railway-provided automatically
- `NEXT_PUBLIC_API_BASE` = public URL of backend service (for example `https://your-backend.up.railway.app`)

## 5) Apply schema once

Use Railway Postgres connect/psql and run:

- `backend/src/db/schema.sql`

If Timescale extension is unavailable on your Postgres plan, schema still proceeds with fallback notices.

## 6) Configure Helius webhook

Webhook URL:
- `https://<backend-public-domain>/webhooks/helius`

Header:
- `x-helius-secret: <HELIUS_WEBHOOK_SECRET>`

## 7) Verify

Backend:
- `GET /health`
- `GET /api/ops/metrics`
- `GET /api/tokens`

Dashboard:
- opens and loads token data
- websocket updates stream live from backend

## 8) Safe rollout and rollback

- Deploy order:
  1. backend (migrations run at startup)
  2. dashboard
- If backend fails startup:
  - check backend logs for missing env/migration errors
  - verify Postgres connectivity and schema presence
- Rollback:
  - in Railway deployment history, rollback backend to previous healthy deployment
  - keep dashboard pinned to previous `NEXT_PUBLIC_API_BASE` if backend domain changed
- Post-deploy smoke checks:
  - `/health`
  - `/api/ops/metrics`
  - `/api/ops/deadletters`
  - `/api/tokens`
