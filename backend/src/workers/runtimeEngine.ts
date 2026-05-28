import type { Redis } from "ioredis";
import type { CalibrationReport } from "../contracts/dto.js";
import { normalizeHeliusEvent } from "../domain/events/normalizer.js";
import { RuntimeRepo } from "../db/repositories/runtimeRepo.js";
import { scoreToken } from "../scoring/rules.js";
import { evaluateAlerts } from "../services/alerts/alertsEngine.js";
import { runBacktest } from "../services/backtest/backtestRunner.js";
import { replayTokenTimeline } from "../services/backtest/replayEngine.js";
import { buildWalletGraph } from "../services/graph/walletGraph.js";
import { scoreClusterRisk } from "../services/graph/clusterRisk.js";
import { HeliusAdapter } from "../services/ingestion/heliusAdapter.js";
import { enqueueMeta } from "../services/ingestion/tokenMetadata.js";
import { updateDeveloperProfile } from "../services/intelligence/developerIntelligence.js";
import { updateWalletProfile } from "../services/intelligence/walletIntelligence.js";
import { buildFeatureRows } from "../services/ml/featurePipeline.js";
import { runShadowInference } from "../services/ml/inference.js";
import { updateMetrics } from "../services/observability/metrics.js";
import { EventQueue } from "../services/queue/eventQueue.js";
import { ClickHouseReadySink, LocalAnalyticsSink } from "../services/scale/analyticsSink.js";
import { KafkaReadyQueueAdapter, RedisStreamsQueueAdapter } from "../services/scale/queueAdapter.js";
import { detectMarketSignals } from "../services/signals/marketSignals.js";
import { RuntimeState } from "../state/runtimeState.js";
import type { CanonicalEvent, ProbabilityRecord, TokenState } from "../types.js";

function randomDev(wallet: string): string {
  return `DEV_${wallet.slice(-8)}`;
}

export class RuntimeEngine {
  private readonly state = new RuntimeState();
  private readonly queue = new EventQueue();
  private readonly queueAdapter = new KafkaReadyQueueAdapter(new RedisStreamsQueueAdapter(this.queue));
  private readonly analyticsSink = new ClickHouseReadySink(new LocalAnalyticsSink());
  private readonly heliusAdapter = new HeliusAdapter();
  private readonly repo: RuntimeRepo;
  private ingestTimer: NodeJS.Timeout | null = null;
  private parseTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private calibration: CalibrationReport = { sampleSize: 0, brierScore: 0, precision: 0, recall: 0, driftDelta: 0 };

  constructor(poolAvailable: boolean, private readonly redis: Redis | null, private readonly ingestIntervalMs: number, private readonly snapshotIntervalMs: number, repo: RuntimeRepo) {
    this.repo = poolAvailable ? repo : new RuntimeRepo(null);
  }

  start(onBroadcast: (type: string, payload: unknown) => void): void {
    if (this.ingestTimer || this.parseTimer || this.snapshotTimer) return;

    this.ingestTimer = setInterval(() => {
      void this.ingest(onBroadcast);
    }, this.ingestIntervalMs);

    this.parseTimer = setInterval(() => {
      void this.parseAndProcess(onBroadcast);
    }, 450);

    this.snapshotTimer = setInterval(() => {
      void this.snapshot();
    }, this.snapshotIntervalMs);
  }

  stop(): void {
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    if (this.parseTimer) clearInterval(this.parseTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.ingestTimer = null;
    this.parseTimer = null;
    this.snapshotTimer = null;
  }

  listTokens(): TokenState[] {
    return [...this.state.tokens.values()].sort((a, b) => b.marketCap - a.marketCap);
  }

  listAlerts() {
    return this.state.alerts.slice(0, 40);
  }

  listProbabilities(): ProbabilityRecord[] {
    return this.state.probabilities.slice(0, 200);
  }

  listReplay(): Record<string, ReturnType<typeof replayTokenTimeline>> {
    const result: Record<string, ReturnType<typeof replayTokenTimeline>> = {};
    for (const token of this.listTokens().slice(0, 12)) {
      result[token.mint] = replayTokenTimeline(this.state.events, token);
    }
    return result;
  }

  calibrationReport(): CalibrationReport {
    return this.calibration;
  }

  async listAlertRules() {
    return this.repo.listAlertRules();
  }

  async saveAlertRule(input: { id?: number; name: string; enabled: boolean; severity: "info" | "warning" | "critical"; config: Record<string, number | string | boolean>; cooldownSeconds: number }) {
    await this.repo.upsertAlertRule(input);
  }

  queueStats(): { queued: number; deadLetters: number; seenIds: number } {
    return this.queue.stats();
  }

  deadLetters(limit = 100): CanonicalEvent[] {
    return this.queue.listDeadLetters(limit);
  }

  replayDeadLetters(limit = 50): number {
    return this.queue.requeueDeadLetters(limit);
  }

  coverage() {
    return {
      ...this.heliusAdapter.coverage(),
      knownTokens: this.state.tokens.size,
      knownWallets: this.state.wallets.size,
      knownDevelopers: this.state.developers.size,
      queue: this.queue.stats()
    };
  }

  async selfCheck() {
    return this.heliusAdapter.selfCheck();
  }

  async ingestWebhookPayload(payload: unknown): Promise<number> {
    const rawEvents = this.heliusAdapter.decodeWebhookPayload(payload);
    if (rawEvents.length === 0) return 0;
    this.fanoutDiscovery(rawEvents);
    const canonical = rawEvents.map(normalizeHeliusEvent);
    await this.queueAdapter.publish(canonical);
    await this.repo.checkpoint("helius-webhook", canonical.at(-1)?.signature ?? "");
    return canonical.length;
  }

  private fanoutDiscovery(rawEvents: ReadonlyArray<{ wallet: string; participants?: string[]; mint: string; mints?: string[]; devWallet?: string }>): void {
    for (const ev of rawEvents) {
      this.heliusAdapter.addDiscoveredWallet(ev.wallet);
      if (ev.devWallet) this.heliusAdapter.addDiscoveredWallet(ev.devWallet);
      if (ev.participants && ev.participants.length > 0) this.heliusAdapter.addDiscoveredWallets(ev.participants);
      this.heliusAdapter.addDiscoveredMint(ev.mint);
      if (ev.mints && ev.mints.length > 0) this.heliusAdapter.addDiscoveredMints(ev.mints);
    }
  }

  private async ingest(onBroadcast: (type: string, payload: unknown) => void): Promise<void> {
    const start = Date.now();
    const rawEvents = await this.heliusAdapter.poll();
    if (rawEvents.length > 0) this.fanoutDiscovery(rawEvents);
    const canonical = rawEvents.map(normalizeHeliusEvent);
    await this.queueAdapter.publish(canonical);
    await this.repo.checkpoint("ingestion-worker", canonical.at(-1)?.signature ?? "");
    updateMetrics({ ingestionLagMs: Date.now() - start });
    onBroadcast("ingestionBatch", { size: canonical.length });
  }

  private async parseAndProcess(onBroadcast: (type: string, payload: unknown) => void): Promise<void> {
    const start = Date.now();
    const events = await this.queueAdapter.consume(180);
    if (events.length === 0) return;

    for (const event of events) {
      try {
        await this.repo.insertEvent(event);
        this.state.events.unshift(event);
        if (this.state.events.length > 5000) this.state.events.length = 5000;
        const token = this.applyEvent(event);
        if (!token) continue; // trade on unknown mint — skip
        const alerts = evaluateAlerts(token);
        for (const alert of alerts) {
          this.state.alerts.unshift(alert);
          await this.repo.insertAlert(alert);
        }
        if (this.state.alerts.length > 250) this.state.alerts.length = 250;
        onBroadcast("tokenUpdate", token);
      } catch {
        this.queue.markDeadLetter(event);
      }
    }

    this.calibration = runBacktest(this.state.probabilities);
    await this.analyticsSink.write(this.state.probabilities.slice(0, 50));
    await this.repo.checkpoint("parser-worker", events.at(-1)?.signature ?? "");
    updateMetrics({ scoringLatencyMs: Date.now() - start, eventsProcessed: this.state.events.length });
  }

  private applyEvent(event: CanonicalEvent): TokenState | null {
    // Only launch events may create a new token entry.
    // Trade/transfer/funding events on unknown mints are from tokens that launched
    // before we started — drop them so historical tokens don't pollute the dashboard.
    const existing = this.state.tokens.get(event.mint);
    if (!existing && event.type !== "launch") return null;

    this.heliusAdapter.addDiscoveredWallet(event.wallet);
    if (event.devWallet) this.heliusAdapter.addDiscoveredWallet(event.devWallet);
    if (event.participants && event.participants.length > 0) this.heliusAdapter.addDiscoveredWallets(event.participants);
    this.heliusAdapter.addDiscoveredMint(event.mint);
    if (event.mints && event.mints.length > 0) this.heliusAdapter.addDiscoveredMints(event.mints);

    const inferredDev = event.devWallet ?? (event.type === "launch" ? event.wallet : undefined);
    const token: TokenState =
      existing ??
      {
        mint: event.mint,
        name: `Token ${event.mint.slice(0, 6)}`,
        symbol: event.mint.slice(0, 6).toUpperCase(),
        devWallet: inferredDev ?? randomDev(event.wallet),
        createdAt: event.timestamp,
        marketCap: Math.max(1_000, event.marketCap || 3_000),
        athMarketCap: Math.max(1_000, event.marketCap || 3_000),
        holderCount: 1,
        buyCount: 0,
        sellCount: 0,
        volume: 0,
        smartWalletCount: 0,
        smartWalletNetFlow: 0,
        devScore: 35,
        insiderConcentration: 0.08,
        probabilityContinuation: 50,
        probabilityMigration: 35,
        probabilityRug: 20,
        probabilityHit25kBefore10k: 40,
        probabilityHit100kBefore25k: 25,
        probabilityHit30kBefore10k: 45,
        probabilityLocalTop: 35,
        probabilityLocalTopWithinNMinutes: 30,
        score: 0,
        lifecycle: "new"
      };

    if (existing && inferredDev && token.devWallet.startsWith("DEV_")) {
      token.devWallet = inferredDev;
    }

    // Fetch on-chain name/symbol if we still have a placeholder
    if (!existing || token.name.startsWith("Token ")) {
      enqueueMeta(event.mint, (meta) => {
        const t = this.state.tokens.get(meta.mint);
        if (t) {
          t.name = meta.name;
          t.symbol = meta.symbol;
          this.state.tokens.set(meta.mint, t);
          void this.repo.upsertToken(t);
        }
      });
    }

    token.marketCap = event.marketCap > 0 ? event.marketCap : token.marketCap;
    token.athMarketCap = Math.max(token.athMarketCap, token.marketCap);
    if (event.type === "trade") {
      token.volume += event.amountSol;
      if (event.side === "buy") {
        token.buyCount += 1;
        token.holderCount += 1;
        token.smartWalletNetFlow += 0.4;
      } else {
        token.sellCount += 1;
        token.holderCount = Math.max(1, token.holderCount - 1);
        token.smartWalletNetFlow -= 0.35;
      }
    }
    if (event.type === "migration") token.lifecycle = "migrated";
    if (event.type === "funding" || event.type === "transfer") token.insiderConcentration = Math.min(1, token.insiderConcentration + 0.01);
    token.smartWalletCount = Math.max(0, token.smartWalletCount + (event.type === "trade" && event.side === "buy" ? 1 : 0));

    const primaryWallet = updateWalletProfile(this.state.wallets.get(event.wallet), event);
    this.state.wallets.set(primaryWallet.wallet, primaryWallet);
    void this.repo.upsertWallet(primaryWallet);

    if (event.participants && event.participants.length > 0) {
      for (const participant of event.participants) {
        if (!participant || participant === event.wallet || participant === "UNKNOWN_WALLET") continue;
        const participantEvent: CanonicalEvent = { ...event, wallet: participant };
        const participantProfile = updateWalletProfile(this.state.wallets.get(participant), participantEvent);
        this.state.wallets.set(participantProfile.wallet, participantProfile);
        void this.repo.upsertWallet(participantProfile);
      }
    }

    const dev = updateDeveloperProfile(this.state.developers.get(token.devWallet), event, token);
    this.state.developers.set(dev.devWallet, dev);
    token.devScore = dev.score;
    void this.repo.upsertDeveloper(dev);

    const signals = detectMarketSignals(token, [...this.state.wallets.values()].slice(0, 150));
    void this.repo.upsertSignalObservation(token.mint, event.timestamp, signals);
    const scored = scoreToken(token, signals);
    this.state.tokens.set(scored.mint, scored);
    void this.repo.upsertToken(scored);

    const probability: ProbabilityRecord = {
      mint: scored.mint,
      timestamp: event.timestamp,
      continuation: scored.probabilityContinuation,
      migration: scored.probabilityMigration,
      rug: scored.probabilityRug,
      hit25kBefore10k: scored.probabilityHit25kBefore10k,
      hit100kBefore25k: scored.probabilityHit100kBefore25k,
      hit30kBefore10k: scored.probabilityHit30kBefore10k,
      localTop: scored.probabilityLocalTop,
      localTopWithinNMinutes: scored.probabilityLocalTopWithinNMinutes,
      score: scored.score
    };
    this.state.probabilities.unshift(probability);
    if (this.state.probabilities.length > 5000) this.state.probabilities.length = 5000;
    void this.repo.insertProbability(probability);
    void this.repo.upsertTokenOutcome(scored.mint, scored.marketCap, scored.lifecycle);

    const graph = buildWalletGraph(this.state.events.slice(0, 1200));
    const clusterRisk = scoreClusterRisk(graph);
    const highestClusterRisk = clusterRisk.reduce((max, c) => Math.max(max, c.insiderRisk), 0);
    scored.insiderConcentration = Number(Math.max(scored.insiderConcentration, highestClusterRisk * 0.8).toFixed(3));
    this.state.tokens.set(scored.mint, scored);

    const features = buildFeatureRows(this.listTokens().slice(0, 100), [...this.state.wallets.values()].slice(0, 200), this.state.probabilities.slice(0, 300));
    const ml = runShadowInference(features).find((m) => m.mint === scored.mint);
    if (ml) {
      scored.probabilityContinuation = Math.round(scored.probabilityContinuation * 0.75 + ml.continuation * 0.25);
      scored.probabilityMigration = Math.round(scored.probabilityMigration * 0.75 + ml.migration * 0.25);
      scored.probabilityRug = Math.round(scored.probabilityRug * 0.75 + ml.rug * 0.25);
    }
    this.state.tokens.set(scored.mint, scored);

    return scored;
  }

  private async snapshot(): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      tokens: this.listTokens().slice(0, 100).map((t) => ({
        mint: t.mint,
        marketCap: t.marketCap,
        holders: t.holderCount,
        buySellRatio: t.sellCount === 0 ? t.buyCount : Number((t.buyCount / t.sellCount).toFixed(2)),
        smartWalletExposure: t.smartWalletCount,
        insiderConcentration: t.insiderConcentration,
        continuation: t.probabilityContinuation
      }))
    };
    if (this.redis) await this.redis.xadd("token:snapshots", "*", "data", JSON.stringify(payload));
    await this.repo.checkpoint("snapshot-worker", payload.timestamp);
    updateMetrics({ websocketFreshnessMs: 250, alertDelayMs: 300 });
  }
}
