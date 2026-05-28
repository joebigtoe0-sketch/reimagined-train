import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { Redis } from "ioredis";
import { env } from "./config/env.js";
import { RuntimeRepo } from "./db/repositories/runtimeRepo.js";
import { getDbPool } from "./db/client.js";
import { RuntimeEngine } from "./workers/runtimeEngine.js";
import { getMetrics } from "./services/observability/metrics.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

let dbPoolAvailable = true;
let repo: RuntimeRepo;
try {
  repo = new RuntimeRepo(getDbPool());
} catch {
  dbPoolAvailable = false;
  app.log.warn("Database unavailable, running in degraded mode");
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

const wsClients = new Set<WebSocket>();
const engine = new RuntimeEngine(dbPoolAvailable, redis, env.INGEST_INTERVAL_MS, env.SNAPSHOT_INTERVAL_MS, repo);

app.get("/health", async () => ({ ok: true }));
app.get("/api/tokens", async () => ({ tokens: engine.listTokens() }));
app.get("/api/alerts", async () => ({ alerts: engine.listAlerts() }));
app.get("/api/probabilities", async () => ({ probabilities: engine.listProbabilities() }));
app.get("/api/backtest/calibration", async () => ({ report: engine.calibrationReport() }));
app.get("/api/backtest/replay", async () => ({ replay: engine.listReplay() }));
app.get("/api/ops/metrics", async () => ({ metrics: getMetrics(), queue: engine.queueStats() }));
app.post("/webhooks/helius", async (request, reply) => {
  const webhookSecret = env.HELIUS_WEBHOOK_SECRET;
  const incomingSecret = request.headers["x-helius-secret"];
  if (webhookSecret && incomingSecret !== webhookSecret) {
    return reply.status(401).send({ ok: false, error: "unauthorized" });
  }

  const count = await engine.ingestWebhookPayload(request.body);
  return { ok: true, accepted: count };
});

app.get("/ws", { websocket: true }, (connection) => {
  wsClients.add(connection.socket);
  connection.socket.send(
    JSON.stringify({
      type: "bootstrap",
      tokens: engine.listTokens(),
      alerts: engine.listAlerts(),
      probabilities: engine.listProbabilities().slice(0, 20),
      metrics: getMetrics()
    })
  );
  connection.socket.onclose = () => wsClients.delete(connection.socket);
});

function broadcast(type: string, payload: unknown): void {
  const event = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(event);
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
