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
import { BitqueryAdapter } from "../services/ingestion/bitqueryAdapter.js";
import { PumpPortalAdapter } from "../services/ingestion/pumpPortalAdapter.js";
import type { IngestionSource } from "../services/ingestion/ingestionSource.js";
import { detectMayhemMints } from "../services/ingestion/mayhemFilter.js";
import { env } from "../config/env.js";
import { updateDeveloperProfile } from "../services/intelligence/developerIntelligence.js";
import { applyEventToAccount, createWalletAccount, deriveWalletProfile, positionRowFor } from "../services/intelligence/walletIntelligence.js";
import { applyTradeToWindow, computeAction, computeEntry, computeExit, createEarlyWindow, EARLY_WINDOW_MS } from "../services/intelligence/entryExit.js";
import { buildFeatureRows } from "../services/ml/featurePipeline.js";
import { runShadowInference } from "../services/ml/inference.js";
import { updateMetrics } from "../services/observability/metrics.js";
import { EventQueue } from "../services/queue/eventQueue.js";
import { ClickHouseReadySink, LocalAnalyticsSink } from "../services/scale/analyticsSink.js";
import { KafkaReadyQueueAdapter, RedisStreamsQueueAdapter } from "../services/scale/queueAdapter.js";
import { detectMarketSignals } from "../services/signals/marketSignals.js";
import { PaperTrader } from "../services/paper/paperTrader.js";
import { RuntimeState } from "../state/runtimeState.js";
import type { CanonicalEvent, ProbabilityRecord, TokenState } from "../types.js";

function randomDev(wallet: string): string {
  return `DEV_${wallet.slice(-8)}`;
}

/** Take the first n values from a Map without materializing the whole array. */
function takeValues<K, V>(map: Map<K, V>, n: number): V[] {
  const out: V[] = [];
  for (const v of map.values()) {
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

// Max tokens we keep an active (metered) trade subscription for at once.
const MAX_TRADE_SUBSCRIPTIONS = 400;
// A token with no observed trade within this window is considered dead and we
// stop paying to track it. New tokens count from launch (lastTradeAt=createdAt).
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;
// No trade for this long ⇒ the token is dead (UI + probabilities reflect it).
const DEAD_AFTER_MS = 2 * 60 * 1000;
// How often we recompute the proven-predictive ("alpha") wallet set from outcomes.
const ALPHA_REFRESH_MS = 10 * 60 * 1000;
// Heavy O(N) analytics (graph clustering + ML) run at most this often, not per event.
const HEAVY_ANALYTICS_MS = 2_500;
// Non-critical per-token DB writes (dev/signal/probability/outcome history) are
// persisted at most this often per token to keep DB write volume sane. The live
// token row (upsertToken) + raw event/trade are still written every event.
const AUX_PERSIST_MS = 4_000;

export class RuntimeEngine {
  private readonly state = new RuntimeState();
  private readonly queue = new EventQueue();
  private readonly queueAdapter = new KafkaReadyQueueAdapter(new RedisStreamsQueueAdapter(this.queue));
  private readonly analyticsSink = new ClickHouseReadySink(new LocalAnalyticsSink());
  // HeliusAdapter is kept only as an in-memory discovery tracker for coverage
  // stats (it makes no network calls anymore). Bitquery is the sole data source.
  private readonly heliusAdapter = new HeliusAdapter();
  private readonly bitquery = new BitqueryAdapter();
  private readonly pumpPortal = new PumpPortalAdapter();
  // Active ingestion provider, selected by INGEST_SOURCE. Toggle freely.
  private readonly source: IngestionSource = env.INGEST_SOURCE === "bitquery" ? this.bitquery : this.pumpPortal;
  private readonly repo: RuntimeRepo;
  private ingestTimer: NodeJS.Timeout | null = null;
  private parseTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private labelTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private alphaTimer: NodeJS.Timeout | null = null;
  private paperTimer: NodeJS.Timeout | null = null;
  private lastHeavyAt = 0;
  private readonly lastAuxAt = new Map<string, number>();
  private readonly paper = new PaperTrader();
  private calibration: CalibrationReport = { sampleSize: 0, brierScore: 0, precision: 0, recall: 0, driftDelta: 0 };

  constructor(poolAvailable: boolean, private readonly redis: Redis | null, private readonly ingestIntervalMs: number, private readonly snapshotIntervalMs: number, repo: RuntimeRepo) {
    this.repo = poolAvailable ? repo : new RuntimeRepo(null);
  }

  start(onBroadcast: (type: string, payload: unknown) => void): void {
    if (this.ingestTimer || this.parseTimer || this.snapshotTimer) return;

    console.log(`[RuntimeEngine] ingest source: ${this.source.name.toUpperCase()} (available=${this.source.available})`);
    void this.source.verify();

    this.ingestTimer = setInterval(() => {
      void this.ingest(onBroadcast);
    }, this.ingestIntervalMs);

    this.parseTimer = setInterval(() => {
      void this.parseAndProcess(onBroadcast);
    }, 450);

    this.snapshotTimer = setInterval(() => {
      void this.snapshot();
    }, this.snapshotIntervalMs);

    // Label matured tokens with real observed outcomes for learning/backtests.
    this.labelTimer = setInterval(() => {
      void this.repo.relabelMaturedOutcomes().catch((err) => console.warn("[label] relabel error:", err instanceof Error ? err.message : err));
    }, 60_000);

    // Mark tokens with no trades for DEAD_AFTER_MS as dead (single source of
    // truth — avoids the UI flip-flopping on a client-side clock).
    this.reaperTimer = setInterval(() => {
      this.reapDeadTokens(onBroadcast);
    }, 15_000);

    // Refresh the proven-predictive ("alpha") wallet set from real outcomes so
    // "smart money bought" reflects who's actually been picking winners lately.
    void this.refreshAlphaWallets();
    this.alphaTimer = setInterval(() => {
      void this.refreshAlphaWallets();
    }, ALPHA_REFRESH_MS);

    // Paper trading bot: act on live ACTION signals and mark positions to market.
    this.paperTimer = setInterval(() => {
      for (const token of this.state.tokens.values()) this.paper.onToken(token);
      onBroadcast("paperUpdate", this.paper.state());
    }, 3_000);
  }

  startPaper(): void { this.paper.start(); }
  stopPaper(): void { this.paper.stop(); }
  resetPaper(): void { this.paper.reset(); }
  paperState() { return this.paper.state(); }

  private async refreshAlphaWallets(): Promise<void> {
    try {
      const alpha = await this.repo.listPredictiveWallets();
      if (alpha.length === 0) return;
      this.state.alphaWallets.clear();
      for (const a of alpha) this.state.alphaWallets.add(a.wallet);
      console.log(`[alpha] tracking ${this.state.alphaWallets.size} proven-predictive wallets`);
    } catch (err) {
      console.warn("[alpha] refresh error:", err instanceof Error ? err.message : err);
    }
  }

  stop(): void {
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    if (this.parseTimer) clearInterval(this.parseTimer);
    if (this.labelTimer) clearInterval(this.labelTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    if (this.alphaTimer) clearInterval(this.alphaTimer);
    if (this.paperTimer) clearInterval(this.paperTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.ingestTimer = null;
    this.parseTimer = null;
    this.snapshotTimer = null;
    this.labelTimer = null;
    this.reaperTimer = null;
    this.alphaTimer = null;
    this.paperTimer = null;
  }

  /**
   * Mark tokens that have gone quiet (no trade for DEAD_AFTER_MS) as dead. A
   * dead token can't keep growing or migrate, so we zero those probabilities.
   * Runs over the in-memory set (broadcasting live updates) and also sweeps the
   * DB so tokens that aged out / survived a redeploy are labelled consistently.
   */
  private reapDeadTokens(onBroadcast: (type: string, payload: unknown) => void): void {
    const now = Date.now();
    for (const token of this.state.tokens.values()) {
      if (token.lifecycle === "dead" || token.lifecycle === "migrated") continue;
      const last = Date.parse(token.lastTradeAt) || Date.parse(token.createdAt) || now;
      if (now - last <= DEAD_AFTER_MS) continue;
      token.lifecycle = "dead";
      token.probabilityContinuation = 0;
      token.probabilityMigration = 0;
      token.probabilityRug = Math.max(token.probabilityRug, 90);
      token.exitSignal = "dead";
      token.action = "DEAD";
      this.state.tokens.set(token.mint, token);
      void this.repo.upsertToken(token);
      onBroadcast("tokenUpdate", token);
    }
    // Sweep the DB for tokens not currently in memory (e.g. after a redeploy).
    void this.repo.markStaleTokensDead(DEAD_AFTER_MS).catch((err) =>
      console.warn("[reaper] DB sweep error:", err instanceof Error ? err.message : err)
    );
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
      queue: this.queue.stats(),
      launchSource: this.source.available ? this.source.name : "disabled",
      bitqueryActive: this.source.name === "bitquery" && this.source.available,
      pumpportalActive: this.source.name === "pumpportal" && this.source.available,
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

    if (!this.source.available) {
      console.warn(`[ingest] Skipping — ingest source ${this.source.name} is not available.`);
      return;
    }

    // ── Step 1: new Pump.fun token launches ─────────────────────────────────
    let bqTokens = await this.source.pollNewLaunches();

    // Drop Mayhem Mode launches (Token-2022 mints with an AI trading agent).
    if (env.FILTER_MAYHEM && bqTokens.length > 0) {
      const mayhem = await detectMayhemMints(bqTokens.map((t) => t.mint));
      if (mayhem.size > 0) {
        bqTokens = bqTokens.filter((t) => !mayhem.has(t.mint));
        console.log(`[ingest] filtered ${mayhem.size} Mayhem Mode token(s)`);
      }
    }

    for (const pt of bqTokens) {
      const launchEvent: CanonicalEvent = {
        id: `bq-launch:${pt.mint}`,
        source: "helius",
        type: "launch",
        mint: pt.mint,
        wallet: pt.devWallet || "unknown",
        devWallet: pt.devWallet || undefined,
        timestamp: pt.createdAt,
        signature: `bq-launch:${pt.mint}`,
        amountSol: 0,
        marketCap: pt.initialMarketCapUsd ?? 0,
        participants: pt.devWallet ? [pt.devWallet] : [],
        mints: [pt.mint],
        metadata: { name: pt.name, symbol: pt.symbol }
      };
      await this.queueAdapter.publish([launchEvent]);

      // Patch name/symbol immediately so UI shows correct values right away.
      const existing = this.state.tokens.get(pt.mint);
      if (existing) {
        existing.name = pt.name;
        existing.symbol = pt.symbol;
        this.state.tokens.set(pt.mint, existing);
      }
    }

    // ── Step 2: live trades for tracked mints (bonding-curve feed) ───────────
    // "Track until dead": we keep a (metered) trade subscription for a token only
    // while it's still alive — i.e. it traded within ACTIVE_WINDOW_MS. A token
    // that goes quiet for that long is considered dead and dropped, freeing the
    // budget for live ones. New tokens get the full window from launch (their
    // lastTradeAt starts at createdAt) to show their first trades.
    const now = Date.now();
    const trackedMints = [...this.state.tokens.values()]
      .filter((t) => now - (Date.parse(t.lastTradeAt) || Date.parse(t.createdAt) || now) < ACTIVE_WINDOW_MS)
      .sort((a, b) => (Date.parse(b.lastTradeAt) || 0) - (Date.parse(a.lastTradeAt) || 0))
      .map((t) => t.mint)
      .slice(0, MAX_TRADE_SUBSCRIPTIONS);
    if (trackedMints.length > 0) {
      const bqTrades = await this.source.pollTrades(trackedMints);
      const tradeEvents: CanonicalEvent[] = bqTrades.map((t) => ({
        id: `bq-trade:${t.signature}:${t.mint}:${t.side}`,
        source: "helius" as const,
        type: "trade" as const,
        mint: t.mint,
        wallet: t.traderWallet,
        timestamp: t.timestamp,
        signature: t.signature,
        amountSol: t.amountSol,
        tokenAmount: t.tokenAmount,
        marketCap: t.marketCap,
        side: t.side,
        participants: t.traderWallet ? [t.traderWallet] : []
      }));
      if (tradeEvents.length > 0) await this.queueAdapter.publish(tradeEvents);
    }

    await this.repo.checkpoint("ingestion-worker", new Date().toISOString());
    updateMetrics({ ingestionLagMs: Date.now() - start });
    onBroadcast("ingestionBatch", { size: bqTokens.length });
  }

  private async parseAndProcess(onBroadcast: (type: string, payload: unknown) => void): Promise<void> {
    const start = Date.now();
    const events = await this.queueAdapter.consume(180);
    if (events.length === 0) return;

    for (const event of events) {
      try {
        this.state.events.unshift(event);
        if (this.state.events.length > 5000) this.state.events.length = 5000;
        const token = this.applyEvent(event);
        // Persistence is fire-and-forget: a slow/saturated DB must NEVER block
        // processing or cause us to drop events (esp. launches) from the feed.
        void this.repo.insertEvent(event);
        if (event.type === "trade") void this.repo.insertTrade(event);
        if (!token) continue; // trade on unknown mint — skip
        if (event.type === "trade") this.paper.onTrade(token, event);
        const alerts = evaluateAlerts(token);
        for (const alert of alerts) {
          this.state.alerts.unshift(alert);
          void this.repo.insertAlert(alert);
        }
        if (this.state.alerts.length > 250) this.state.alerts.length = 250;
        onBroadcast("tokenUpdate", token);
      } catch {
        this.queue.markDeadLetter(event);
      }
    }

    this.calibration = runBacktest(this.state.probabilities);
    void this.analyticsSink.write(this.state.probabilities.slice(0, 50));
    void this.repo.checkpoint("parser-worker", events.at(-1)?.signature ?? "");
    updateMetrics({ scoringLatencyMs: Date.now() - start, eventsProcessed: this.state.events.length });
  }

  private applyEvent(event: CanonicalEvent): TokenState | null {
    // Only launch events may create a new token entry.
    // Trade/transfer/funding events on unknown mints are from tokens that launched
    // before we started — drop them so historical tokens don't pollute the dashboard.
    const existing = this.state.tokens.get(event.mint);
    if (!existing && event.type !== "launch") return null;
    const prevAth = existing?.athMarketCap ?? 0; // captured before any mutation below

    this.heliusAdapter.addDiscoveredWallet(event.wallet);
    if (event.devWallet) this.heliusAdapter.addDiscoveredWallet(event.devWallet);
    if (event.participants && event.participants.length > 0) this.heliusAdapter.addDiscoveredWallets(event.participants);
    this.heliusAdapter.addDiscoveredMint(event.mint);
    if (event.mints && event.mints.length > 0) this.heliusAdapter.addDiscoveredMints(event.mints);

    const inferredDev = event.devWallet ?? (event.type === "launch" ? event.wallet : undefined);
    const metaName = typeof event.metadata?.name === "string" ? event.metadata.name : "";
    const metaSymbol = typeof event.metadata?.symbol === "string" ? event.metadata.symbol : "";
    const token: TokenState =
      existing ??
      {
        mint: event.mint,
        name: metaName || `Token ${event.mint.slice(0, 6)}`,
        symbol: metaSymbol || event.mint.slice(0, 6).toUpperCase(),
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
        lifecycle: "new",
        entryScore: 0,
        entrySignal: "avoid",
        exitSignal: "accumulate",
        earlyUniqueBuyers: 0,
        earlyNetSol: 0,
        peakAt: event.timestamp,
        lastTradeAt: event.timestamp,
        smartMoneyBuys: 0,
        action: "WATCH"
      };

    if (existing && inferredDev && token.devWallet.startsWith("DEV_")) {
      token.devWallet = inferredDev;
    }

    // Bitquery supplies the real name/symbol on the launch event, so no
    // separate metadata lookup is needed. Patch in case a real name arrived later.
    if (existing && metaName && token.name.startsWith("Token ")) {
      token.name = metaName;
      token.symbol = metaSymbol || token.symbol;
    }

    token.marketCap = event.marketCap > 0 ? event.marketCap : token.marketCap;
    if (token.marketCap > token.athMarketCap) {
      token.athMarketCap = token.marketCap;
      token.peakAt = event.timestamp;
    }
    if (event.type === "trade") {
      token.lastTradeAt = event.timestamp;
      token.volume += event.amountSol;
      if (event.side === "buy") {
        token.buyCount += 1;
        token.smartWalletNetFlow += event.amountSol;
      } else {
        token.sellCount += 1;
        token.smartWalletNetFlow -= event.amountSol;
      }
    }
    if (event.type === "migration") token.lifecycle = "migrated";
    if (event.type === "funding" || event.type === "transfer") token.insiderConcentration = Math.min(1, token.insiderConcentration + 0.01);

    // Wallet stats are derived only from real trades, so every wallet starts
    // at zero and only moves on observed buys/sells.
    if (event.type === "trade") {
      this.updateWallet(event.wallet, event);
      if (event.participants && event.participants.length > 0) {
        for (const participant of event.participants) {
          if (!participant || participant === event.wallet || participant === "UNKNOWN_WALLET") continue;
          this.updateWallet(participant, { ...event, wallet: participant });
        }
      }

      // Holder + smart-wallet counts are derived from real open positions
      // (wallets currently holding the token), not naive per-trade counters.
      const holders = this.state.tokenHolders.get(event.mint);
      if (holders) {
        token.holderCount = holders.size;
        let smart = 0;
        for (const holder of holders) {
          const category = this.state.wallets.get(holder)?.category;
          if (category === "elite_early" || category === "continuation") smart += 1;
        }
        token.smartWalletCount = smart;
      }
    }

    // Smart-money detection: a proven-predictive wallet buying THIS coin is a
    // strong live signal. Count distinct alpha buyers per mint.
    if (event.type === "trade" && event.side === "buy" && this.state.alphaWallets.has(event.wallet)) {
      let set = this.state.smartMoneyByMint.get(token.mint);
      if (!set) {
        set = new Set();
        this.state.smartMoneyByMint.set(token.mint, set);
      }
      set.add(event.wallet);
      token.smartMoneyBuys = set.size;
    } else {
      token.smartMoneyBuys = this.state.smartMoneyByMint.get(token.mint)?.size ?? token.smartMoneyBuys ?? 0;
    }

    // Entry/exit intelligence: maintain the first-5-min participation window and
    // derive a live "should I ape / should I bail" read from observed action.
    let win = this.state.earlyWindows.get(token.mint);
    if (!win) {
      win = createEarlyWindow(Date.parse(token.createdAt) || Date.now(), token.marketCap);
      this.state.earlyWindows.set(token.mint, win);
    }
    if (event.type === "trade") applyTradeToWindow(win, event);
    const entry = computeEntry(win);
    token.entryScore = entry.entryScore;
    token.entrySignal = entry.entrySignal;
    token.earlyUniqueBuyers = entry.earlyUniqueBuyers;
    token.earlyNetSol = entry.earlyNetSol;
    // Smart money is the strongest live confirmation we have — boost the entry
    // read when proven pickers are in (1 ⇒ at least moderate, 2+ ⇒ strong).
    if (token.smartMoneyBuys > 0) {
      token.entryScore = Math.min(100, token.entryScore + Math.min(30, token.smartMoneyBuys * 15));
      if (token.smartMoneyBuys >= 2) token.entrySignal = "strong";
      else if (token.entrySignal === "avoid" || token.entrySignal === "weak") token.entrySignal = "moderate";
    }
    const ageMinutes = (Date.now() - (Date.parse(token.createdAt) || Date.now())) / 60_000;
    token.exitSignal = computeExit(token, win.entryMc || token.marketCap, ageMinutes);
    token.action = computeAction({
      lifecycle: token.lifecycle,
      athMarketCap: token.athMarketCap,
      entryMc: win.entryMc || token.marketCap,
      ageMinutes,
      entryScore: token.entryScore,
      entrySignal: entry.entrySignal,
      qualified: entry.qualified,
      smartMoneyBuys: token.smartMoneyBuys,
      exitSignal: token.exitSignal
    });

    // Per-token write throttle for non-critical history tables.
    const auxNow = Date.now();
    const persistAux = auxNow - (this.lastAuxAt.get(token.mint) ?? 0) > AUX_PERSIST_MS;
    if (persistAux) {
      this.lastAuxAt.set(token.mint, auxNow);
      if (this.lastAuxAt.size > 50_000) {
        let i = 0;
        for (const k of this.lastAuxAt.keys()) {
          this.lastAuxAt.delete(k);
          if (++i >= 25_000) break;
        }
      }
    }

    const dev = updateDeveloperProfile(this.state.developers.get(token.devWallet), event, token);
    this.state.developers.set(dev.devWallet, dev);
    token.devScore = dev.score;
    if (persistAux) void this.repo.upsertDeveloper(dev);

    const signals = detectMarketSignals(token, takeValues(this.state.wallets, 150));
    if (persistAux) void this.repo.upsertSignalObservation(token.mint, event.timestamp, signals);
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
    if (persistAux) void this.repo.insertProbability(probability);
    // Outcome (ATH/migrated) is needed per token for learning — persist on the
    // throttle, and always when a new ATH is set so peaks aren't missed.
    if (persistAux || scored.athMarketCap > prevAth) {
      void this.repo.upsertTokenOutcome(scored.mint, scored.athMarketCap, scored.lifecycle === "migrated");
    }

    // Heavy analytics (wallet-graph clustering + ML shadow inference) are O(N)
    // over the whole state. Running them on EVERY event makes ingestion fall
    // behind real time as the dataset grows (the dashboard then shows stale
    // "newest" tokens). Throttle them to run at most every HEAVY_ANALYTICS_MS;
    // the hot path stays light so launches/trades are processed promptly.
    const now = Date.now();
    if (now - this.lastHeavyAt > HEAVY_ANALYTICS_MS) {
      this.lastHeavyAt = now;
      const graph = buildWalletGraph(this.state.events.slice(0, 1200));
      const clusterRisk = scoreClusterRisk(graph);
      const highestClusterRisk = clusterRisk.reduce((max, c) => Math.max(max, c.insiderRisk), 0);
      scored.insiderConcentration = Number(Math.max(scored.insiderConcentration, highestClusterRisk * 0.8).toFixed(3));

      const features = buildFeatureRows(takeValues(this.state.tokens, 100), takeValues(this.state.wallets, 200), this.state.probabilities.slice(0, 300));
      const ml = runShadowInference(features).find((m) => m.mint === scored.mint);
      if (ml) {
        scored.probabilityContinuation = Math.round(scored.probabilityContinuation * 0.75 + ml.continuation * 0.25);
        scored.probabilityMigration = Math.round(scored.probabilityMigration * 0.75 + ml.migration * 0.25);
        scored.probabilityRug = Math.round(scored.probabilityRug * 0.75 + ml.rug * 0.25);
      }
      this.state.tokens.set(scored.mint, scored);
    }

    return scored;
  }

  private updateWallet(wallet: string, event: CanonicalEvent): void {
    if (!wallet || wallet === "UNKNOWN_WALLET" || wallet === "unknown") return;
    let account = this.state.walletAccounts.get(wallet);
    if (!account) {
      account = createWalletAccount(wallet);
      this.state.walletAccounts.set(wallet, account);
    }
    const heldBefore = (account.positions.get(event.mint)?.tokens ?? 0) > 0;
    applyEventToAccount(account, event);
    const heldAfter = (account.positions.get(event.mint)?.tokens ?? 0) > 0;

    if (event.type === "trade") {
      let holders = this.state.tokenHolders.get(event.mint);
      if (!holders) {
        holders = new Set();
        this.state.tokenHolders.set(event.mint, holders);
      }
      if (!heldBefore && heldAfter) holders.add(wallet);
      else if (heldBefore && !heldAfter) holders.delete(wallet);
    }

    const profile = deriveWalletProfile(account);
    this.state.wallets.set(wallet, profile);
    void this.repo.upsertWallet(profile);
    if (event.type === "trade") {
      const position = positionRowFor(account, event.mint);
      if (position) void this.repo.upsertWalletPosition(position);
    }
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
    // Durable MC/holder time-series per token so history is queryable later.
    await this.repo.insertTokenSnapshots(payload.tokens.map((t) => ({ ts: payload.timestamp, ...t })));
    await this.repo.checkpoint("snapshot-worker", payload.timestamp);
    updateMetrics({ websocketFreshnessMs: 250, alertDelayMs: 300 });

    // Drop early-window state once well past the scoring window to bound memory.
    const staleBefore = Date.now() - EARLY_WINDOW_MS - 60 * 60 * 1000;
    for (const [mint, w] of this.state.earlyWindows) {
      if (w.startMs < staleBefore) this.state.earlyWindows.delete(mint);
    }
  }
}
