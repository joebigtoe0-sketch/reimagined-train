import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket as WsWebSocket } from "ws";
import { Redis } from "ioredis";
import { env } from "./config/env.js";
import { RuntimeRepo } from "./db/repositories/runtimeRepo.js";
import { getDbPool } from "./db/client.js";
import { RuntimeEngine } from "./workers/runtimeEngine.js";
import { getMetrics } from "./services/observability/metrics.js";
import { assertRequiredTables, runStartupMigrations } from "./db/migrate.js";
import { evaluateAlerts } from "./services/alerts/alertsEngine.js";
import type { TokenState } from "./types.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

let dbPoolAvailable = true;
let repo: RuntimeRepo;
try {
  await runStartupMigrations();
  repo = new RuntimeRepo(getDbPool());
  await assertRequiredTables(repo);
  await repo.upsertAlertRule({
    name: "continuation_drop",
    enabled: true,
    severity: "critical",
    config: { continuationFloor: 38 },
    cooldownSeconds: 60
  });
  await repo.upsertAlertRule({
    name: "insider_risk",
    enabled: true,
    severity: "warning",
    config: { insiderThreshold: 0.35 },
    cooldownSeconds: 90
  });
} catch (error) {
  dbPoolAvailable = false;
  app.log.error({ err: error }, "Database unavailable, running in degraded mode");
  repo = new RuntimeRepo(null);
}

let redis: Redis | null = null;
try {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => {
    app.log.warn("Redis unavailable, running in degraded mode");
    redis = null;
  });
} catch {
  app.log.warn("Redis bootstrap failed, running in degraded mode");
}

const wsClients = new Set<WsWebSocket>();
const engine = new RuntimeEngine(dbPoolAvailable, redis, env.INGEST_INTERVAL_MS, env.SNAPSHOT_INTERVAL_MS, repo);

app.get("/health", async () => ({ ok: true }));
app.get("/api/tokens", async () => {
  const tokens = await repo.listTokens(200);
  return { tokens: tokens.length > 0 ? tokens : engine.listTokens() };
});
app.get("/api/alerts", async () => {
  const alerts = await repo.listAlerts(200);
  return { alerts: alerts.length > 0 ? alerts : engine.listAlerts() };
});
app.get("/api/probabilities", async () => {
  const probabilities = await repo.listProbabilities(500);
  return { probabilities: probabilities.length > 0 ? probabilities : engine.listProbabilities() };
});
app.get("/api/wallets", async () => {
  const wallets = await repo.listWallets(500);
  return { wallets };
});
app.get("/api/backtest/calibration", async () => ({ report: engine.calibrationReport() }));
app.get("/api/backtest/replay", async () => ({ replay: engine.listReplay() }));
app.get("/api/ops/metrics", async () => {
  const metrics = getMetrics();
  const persistedEvents = await repo.countRawEvents();
  return {
    metrics: { ...metrics, eventsProcessed: Math.max(metrics.eventsProcessed, persistedEvents) },
    queue: engine.queueStats()
  };
});
app.get("/api/ops/coverage", async () => ({ coverage: engine.coverage() }));
app.get("/api/ops/webhook-check", async () => engine.selfCheck());
app.get("/api/ops/deadletters", async () => ({ deadLetters: engine.deadLetters(100) }));
app.post("/api/ops/deadletters/replay", async (request) => {
  const body = (request.body ?? {}) as { limit?: number };
  const limit = Math.max(1, Math.min(500, body.limit ?? 50));
  const replayed = engine.replayDeadLetters(limit);
  return { ok: true, replayed };
});
app.get("/api/alerts/rules", async () => ({ rules: await engine.listAlertRules() }));
app.post("/api/alerts/rules", async (request) => {
  const body = request.body as {
    id?: number;
    name: string;
    enabled?: boolean;
    severity: "info" | "warning" | "critical";
    config?: Record<string, number | string | boolean>;
    cooldownSeconds?: number;
  };
  await engine.saveAlertRule({
    id: body.id,
    name: body.name,
    enabled: body.enabled ?? true,
    severity: body.severity,
    config: body.config ?? {},
    cooldownSeconds: body.cooldownSeconds ?? 60
  });
  return { ok: true };
});
app.post("/api/alerts/simulate", async (request) => {
  const body = request.body as { token: TokenState };
  return { alerts: evaluateAlerts(body.token) };
});
app.post("/webhooks/helius", async (request, reply) => {
  const webhookSecret = env.HELIUS_WEBHOOK_SECRET;
  const xHeliusSecret = request.headers["x-helius-secret"];
  const authorization = request.headers["authorization"];
  const authToken =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : authorization;
  const incomingSecret =
    (typeof xHeliusSecret === "string" ? xHeliusSecret : undefined) ??
    (typeof authToken === "string" ? authToken : undefined);
  if (webhookSecret && incomingSecret !== webhookSecret) {
    return reply.status(401).send({ ok: false, error: "unauthorized" });
  }

  const count = await engine.ingestWebhookPayload(request.body);
  return { ok: true, accepted: count };
});

app.get("/ws", { websocket: true }, async (socket) => {
  wsClients.add(socket);
  const [tokens, alerts, probabilities] = await Promise.all([repo.listTokens(200), repo.listAlerts(200), repo.listProbabilities(200)]);
  socket.send(
    JSON.stringify({
      type: "bootstrap",
      tokens,
      alerts,
      probabilities: probabilities.slice(0, 20),
      metrics: getMetrics()
    })
  );
  socket.on("close", () => wsClients.delete(socket));
});

function broadcast(type: string, payload: unknown): void {
  const event = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of wsClients) {
    try {
      if (client?.readyState === 1) client.send(event);
    } catch {
      wsClients.delete(client);
    }
  }
}

engine.start((type, payload) => broadcast(type, payload));

const close = async (): Promise<void> => {
  engine.stop();
  await app.close();
  if (redis) await redis.quit();
};

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await app.listen({ port: env.PORT, host: "0.0.0.0" });
