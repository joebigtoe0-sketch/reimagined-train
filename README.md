# Pump.fun Probability MVP

Greenfield MVP for a real-time Pump.fun probability intelligence platform.

## Included
- Fastify backend with websocket stream at `ws://localhost:8080/ws`
- Simulated launch/trade ingestion worker loop
- Rule-based probability engine for continuation/migration/rug risk
- Alert generation for key risk/state transitions
- Periodic token snapshot writer (Redis Streams)
- Next.js dashboard with live token board and recent alerts
- Local infra compose for Timescale/Postgres + Redis

## Run
1. Start infra:
   - `docker compose -f infra/docker-compose.yml up -d`
2. Backend:
   - `copy backend\\.env.example backend\\.env`
   - `npm run dev -w backend`
3. Dashboard:
   - `npm run dev -w dashboard`
4. Open:
   - `http://localhost:3000`

## Key API
- `GET /health`
- `GET /api/tokens`
- `GET /api/alerts`
- `GET /ws` (websocket upgrade endpoint)

## Notes
- SQL schema is in `backend/src/db/schema.sql` and ready for Timescale migration/bootstrap.

## Setup Docs
- Full local setup (Redis, Postgres/Timescale, backend, dashboard, Helius, webhook): `docs/full-setup.md`
- Helius-specific live ingestion setup: `docs/helius-setup.md`
- Railway deployment (backend + dashboard + Postgres + Redis): `docs/railway-deploy.md`
