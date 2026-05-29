import type { AlertEvent, AlertRule, CanonicalEvent, DeveloperProfile, ProbabilityRecord, TokenState, WalletProfile } from "../../types.js";
type QueryablePool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export class RuntimeRepo {
  constructor(private readonly pool: QueryablePool | null) {}

  async insertEvent(event: CanonicalEvent): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO raw_events (event_id, source, event_type, mint, wallet, signature, ts, amount_sol, token_amount, market_cap, side, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id,
        event.source,
        event.type,
        event.mint,
        event.wallet,
        event.signature,
        event.timestamp,
        event.amountSol,
        event.tokenAmount ?? null,
        event.marketCap,
        event.side ?? null,
        JSON.stringify(event.metadata ?? {})
      ]
    );
  }

  /** Append a buy/sell trade for forensic study (who, side, size, MC, when). */
  async insertTrade(event: CanonicalEvent): Promise<void> {
    if (!this.pool || event.type !== "trade" || !event.side) return;
    await this.pool.query(
      `INSERT INTO trades (mint, wallet, side, amount_sol, token_amount, market_cap, signature, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        event.mint,
        event.wallet,
        event.side,
        event.amountSol,
        event.tokenAmount ?? 0,
        event.marketCap,
        event.signature,
        event.timestamp
      ]
    );
  }

  /** Persist a wallet's per-token position so cost basis survives restarts. */
  async upsertWalletPosition(row: {
    wallet: string;
    mint: string;
    totalBought: number;
    totalSold: number;
    avgEntryMc: number;
    avgExitMc: number;
    realizedPnl: number;
    lastActivityAt: string;
  }): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO wallet_token_positions (wallet, mint, total_bought, total_sold, avg_entry_mc, avg_exit_mc, realized_pnl, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (wallet, mint) DO UPDATE SET
         total_bought=EXCLUDED.total_bought, total_sold=EXCLUDED.total_sold,
         avg_entry_mc=EXCLUDED.avg_entry_mc, avg_exit_mc=EXCLUDED.avg_exit_mc,
         realized_pnl=EXCLUDED.realized_pnl, last_activity_at=EXCLUDED.last_activity_at`,
      [row.wallet, row.mint, row.totalBought, row.totalSold, row.avgEntryMc, row.avgExitMc, row.realizedPnl, row.lastActivityAt]
    );
  }

  async upsertToken(token: TokenState): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO tokens (mint, name, symbol, dev_wallet, created_at, current_mc, ath_mc, holder_count, buy_count, sell_count, volume, smart_wallet_count, smart_wallet_net_flow, insider_concentration, lifecycle, last_trade_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (mint) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name != '' AND EXCLUDED.name NOT LIKE 'Token %' THEN EXCLUDED.name ELSE tokens.name END,
         symbol = CASE WHEN EXCLUDED.symbol != '' AND length(EXCLUDED.symbol) > 4 THEN EXCLUDED.symbol ELSE tokens.symbol END,
         current_mc = EXCLUDED.current_mc, ath_mc = EXCLUDED.ath_mc, holder_count = EXCLUDED.holder_count,
         buy_count = EXCLUDED.buy_count, sell_count = EXCLUDED.sell_count, volume = EXCLUDED.volume,
         smart_wallet_count = EXCLUDED.smart_wallet_count, smart_wallet_net_flow = EXCLUDED.smart_wallet_net_flow,
         insider_concentration = EXCLUDED.insider_concentration, lifecycle = EXCLUDED.lifecycle,
         last_trade_at = COALESCE(EXCLUDED.last_trade_at, tokens.last_trade_at)`,
      [
        token.mint,
        token.name,
        token.symbol,
        token.devWallet,
        token.createdAt,
        token.marketCap,
        token.athMarketCap,
        token.holderCount,
        token.buyCount,
        token.sellCount,
        token.volume,
        token.smartWalletCount,
        token.smartWalletNetFlow,
        token.insiderConcentration,
        token.lifecycle,
        token.lastTradeAt && token.lastTradeAt !== token.createdAt ? token.lastTradeAt : null
      ]
    );
  }

  /** Mark tokens with no trade within `deadAfterMs` as dead (DB-side sweep). */
  async markStaleTokensDead(deadAfterMs: number): Promise<number> {
    if (!this.pool) return 0;
    const minutes = Math.max(1, Math.round(deadAfterMs / 60_000));
    const result = await this.pool.query(
      `UPDATE tokens
       SET lifecycle = 'dead'
       WHERE lifecycle NOT IN ('dead','migrated')
         AND COALESCE(last_trade_at, created_at) < now() - ($1 || ' minutes')::interval`,
      [String(minutes)]
    );
    return (result as { rowCount?: number }).rowCount ?? 0;
  }

  async upsertWallet(profile: WalletProfile): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO wallet_scores (wallet, win_rate, avg_return_multiple, confidence, category, avg_entry_mc, avg_exit_mc, avg_hold_minutes, migration_success_rate, rug_exposure_rate, total_trades, realized_pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (wallet) DO UPDATE SET win_rate=EXCLUDED.win_rate, avg_return_multiple=EXCLUDED.avg_return_multiple, confidence=EXCLUDED.confidence,
         category=EXCLUDED.category, avg_entry_mc=EXCLUDED.avg_entry_mc, avg_exit_mc=EXCLUDED.avg_exit_mc, avg_hold_minutes=EXCLUDED.avg_hold_minutes,
         migration_success_rate=EXCLUDED.migration_success_rate, rug_exposure_rate=EXCLUDED.rug_exposure_rate, total_trades=EXCLUDED.total_trades,
         realized_pnl=EXCLUDED.realized_pnl`,
      [
        profile.wallet,
        profile.winRate,
        profile.avgReturnMultiple,
        profile.confidence,
        profile.category,
        profile.avgEntryMc,
        profile.avgExitMc,
        profile.avgHoldMinutes,
        profile.migrationSuccessRate,
        profile.rugExposureRate,
        profile.totalTrades,
        profile.realizedPnl
      ]
    );
  }

  async upsertDeveloper(profile: DeveloperProfile): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO developers (dev_wallet, total_launches, migration_count, rug_count, average_ath, average_lifespan_minutes, average_holder_growth, repeat_buyer_overlap, dev_sell_rate, insider_flags, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (dev_wallet) DO UPDATE SET total_launches=EXCLUDED.total_launches, migration_count=EXCLUDED.migration_count, rug_count=EXCLUDED.rug_count,
         average_ath=EXCLUDED.average_ath, average_lifespan_minutes=EXCLUDED.average_lifespan_minutes, average_holder_growth=EXCLUDED.average_holder_growth,
         repeat_buyer_overlap=EXCLUDED.repeat_buyer_overlap, dev_sell_rate=EXCLUDED.dev_sell_rate, insider_flags=EXCLUDED.insider_flags, score=EXCLUDED.score`,
      [
        profile.devWallet,
        profile.totalLaunches,
        profile.migrationCount,
        profile.rugCount,
        profile.averageAth,
        profile.averageLifespanMinutes,
        profile.averageHolderGrowth,
        profile.repeatBuyerOverlap,
        profile.devSellRate,
        profile.insiderFlags,
        profile.score
      ]
    );
  }

  async insertProbability(record: ProbabilityRecord): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO probability_history (mint, ts, continuation, migration, rug, hit25k_before10k, hit100k_before25k, hit30k_before10k, local_top, local_top_within_n_minutes, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.mint,
        record.timestamp,
        record.continuation,
        record.migration,
        record.rug,
        record.hit25kBefore10k,
        record.hit100kBefore25k,
        record.hit30kBefore10k,
        record.localTop,
        record.localTopWithinNMinutes,
        record.score
      ]
    );
  }

  /**
   * Record observed milestones for a token. `reached_*` is based on the real
   * all-time-high market cap; `migrated` comes from real migration events.
   * Rug + local-top are NOT set here — they're computed from observed price
   * action by relabelMaturedOutcomes() so the label is never circular.
   */
  async upsertTokenOutcome(mint: string, athMc: number, migrated: boolean): Promise<void> {
    if (!this.pool) return;
    const reached25k = athMc >= 25_000;
    const reached100k = athMc >= 100_000;
    await this.pool.query(
      `INSERT INTO token_outcomes (mint, reached_25k, reached_100k, migrated, rugged, evaluated_at)
       VALUES ($1,$2,$3,$4,FALSE,now())
       ON CONFLICT (mint) DO UPDATE SET reached_25k = token_outcomes.reached_25k OR EXCLUDED.reached_25k,
         reached_100k = token_outcomes.reached_100k OR EXCLUDED.reached_100k,
         migrated = token_outcomes.migrated OR EXCLUDED.migrated,
         evaluated_at = now()`,
      [mint, reached25k, reached100k, migrated]
    );
  }

  /**
   * Label matured tokens with REAL, observed outcomes (no model feedback loop):
   *  - rugged: token had a real peak then collapsed (current MC <= 15% of ATH)
   *  - local_top_at: timestamp of the highest observed market cap (best exit)
   * Only tokens older than `maturityMinutes` are evaluated so we don't label
   * coins that simply haven't played out yet. One set-based query covers all.
   */
  async relabelMaturedOutcomes(maturityMinutes = 15, minRelevantMc = 4_000, rugDropFraction = 0.15): Promise<number> {
    if (!this.pool) return 0;
    const result = await this.pool.query(
      `INSERT INTO token_outcomes (mint, reached_25k, reached_100k, migrated, rugged, local_top_at, evaluated_at)
       SELECT t.mint,
              t.ath_mc >= 25000,
              t.ath_mc >= 100000,
              (t.lifecycle = 'migrated'),
              (t.ath_mc >= $2 AND t.current_mc <= t.ath_mc * $3),
              (SELECT s.ts FROM token_snapshots s WHERE s.mint = t.mint ORDER BY s.market_cap DESC, s.ts ASC LIMIT 1),
              now()
       FROM tokens t
       WHERE t.created_at < now() - ($1 || ' minutes')::interval
       ON CONFLICT (mint) DO UPDATE SET
         reached_25k = token_outcomes.reached_25k OR EXCLUDED.reached_25k,
         reached_100k = token_outcomes.reached_100k OR EXCLUDED.reached_100k,
         migrated = token_outcomes.migrated OR EXCLUDED.migrated,
         rugged = EXCLUDED.rugged,
         local_top_at = COALESCE(EXCLUDED.local_top_at, token_outcomes.local_top_at),
         evaluated_at = now()`,
      [String(maturityMinutes), minRelevantMc, rugDropFraction]
    );
    return (result as { rowCount?: number }).rowCount ?? 0;
  }

  async insertAlert(alert: AlertEvent): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`INSERT INTO alerts (id, mint, severity, alert_type, message, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      alert.id,
      alert.tokenMint,
      alert.severity,
      alert.type,
      alert.message,
      alert.createdAt
    ]);
  }

  async checkpoint(workerName: string, value: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO checkpoints (worker_name, checkpoint_value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (worker_name) DO UPDATE SET checkpoint_value=EXCLUDED.checkpoint_value, updated_at=now()`,
      [workerName, value]
    );
  }

  async upsertSignalObservation(
    mint: string,
    timestamp: string,
    signal: { accumulationStrength: number; distributionRisk: number; holderGrowthQuality: number; insiderRisk: number; smartWalletConviction: number }
  ): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO signal_observations (mint, ts, accumulation_strength, distribution_risk, holder_growth_quality, insider_risk, smart_wallet_conviction)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [mint, timestamp, signal.accumulationStrength, signal.distributionRisk, signal.holderGrowthQuality, signal.insiderRisk, signal.smartWalletConviction]
    );
  }

  async listAlertRules(): Promise<AlertRule[]> {
    const rows = await this.rawQuery<{
      id: number;
      name: string;
      enabled: boolean;
      severity: "info" | "warning" | "critical";
      config: Record<string, number | string | boolean>;
      cooldown_seconds: number;
      updated_at: string;
    }>(
      `SELECT id, name, enabled, severity, config, cooldown_seconds, updated_at
       FROM alert_rules ORDER BY id ASC`
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      severity: r.severity,
      config: r.config ?? {},
      cooldownSeconds: r.cooldown_seconds,
      updatedAt: r.updated_at
    }));
  }

  async upsertAlertRule(input: Omit<AlertRule, "id" | "updatedAt"> & { id?: number }): Promise<void> {
    if (!this.pool) return;
    if (input.id) {
      await this.pool.query(
        `UPDATE alert_rules
         SET name=$2, enabled=$3, severity=$4, config=$5, cooldown_seconds=$6, updated_at=now()
         WHERE id=$1`,
        [input.id, input.name, input.enabled, input.severity, JSON.stringify(input.config), input.cooldownSeconds]
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO alert_rules (name, enabled, severity, config, cooldown_seconds)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE SET enabled=EXCLUDED.enabled, severity=EXCLUDED.severity, config=EXCLUDED.config, cooldown_seconds=EXCLUDED.cooldown_seconds, updated_at=now()`,
      [input.name, input.enabled, input.severity, JSON.stringify(input.config), input.cooldownSeconds]
    );
  }

  async rawQuery<T = unknown>(text: string, values?: unknown[]): Promise<T[]> {
    if (!this.pool) return [];
    const result = await this.pool.query(text, values);
    return result.rows as T[];
  }

  async listTokens(limit = 100): Promise<TokenState[]> {
    const rows = await this.rawQuery<{
      mint: string;
      name: string;
      symbol: string;
      dev_wallet: string;
      created_at: string;
      current_mc: number;
      ath_mc: number;
      holder_count: number;
      buy_count: number;
      sell_count: number;
      volume: number;
      smart_wallet_count: number;
      smart_wallet_net_flow: number;
      insider_concentration: number;
      lifecycle: TokenState["lifecycle"];
      last_trade_at?: string | null;
      continuation?: number;
      migration?: number;
      rug?: number;
      hit25k_before10k?: number;
      hit100k_before25k?: number;
      hit30k_before10k?: number;
      local_top?: number;
      local_top_within_n_minutes?: number;
      score?: number;
    }>(
      `SELECT t.mint, COALESCE(t.name, '') AS name, t.symbol, t.dev_wallet, t.created_at, t.current_mc, t.ath_mc, t.holder_count, t.buy_count, t.sell_count, t.volume,
              t.smart_wallet_count, t.smart_wallet_net_flow, t.insider_concentration, t.lifecycle, t.last_trade_at,
              ph.continuation, ph.migration, ph.rug, ph.hit25k_before10k, ph.hit100k_before25k, ph.hit30k_before10k, ph.local_top, ph.local_top_within_n_minutes, ph.score
       FROM tokens t
       LEFT JOIN LATERAL (
         SELECT continuation, migration, rug, hit25k_before10k, hit100k_before25k, hit30k_before10k, local_top, local_top_within_n_minutes, score
         FROM probability_history p
         WHERE p.mint = t.mint
         ORDER BY p.ts DESC
         LIMIT 1
       ) ph ON TRUE
       ORDER BY COALESCE(t.last_trade_at, t.created_at) DESC
       LIMIT $1`,
      [limit]
    );

    return rows.map((r) => {
      // Dead/rugged tokens can't grow or migrate — show those outcomes as 0
      // even though the last stored probability row predates the death.
      const terminal = r.lifecycle === "dead" || r.lifecycle === "failed";
      return {
      mint: r.mint,
      name: r.name || `Token ${r.mint.slice(0, 6)}`,
      symbol: r.symbol,
      devWallet: r.dev_wallet,
      createdAt: r.created_at,
      marketCap: Number(r.current_mc ?? 0),
      athMarketCap: Number(r.ath_mc ?? 0),
      holderCount: Number(r.holder_count ?? 0),
      buyCount: Number(r.buy_count ?? 0),
      sellCount: Number(r.sell_count ?? 0),
      volume: Number(r.volume ?? 0),
      smartWalletCount: Number(r.smart_wallet_count ?? 0),
      smartWalletNetFlow: Number(r.smart_wallet_net_flow ?? 0),
      devScore: 50,
      insiderConcentration: Number(r.insider_concentration ?? 0),
      probabilityContinuation: terminal ? 0 : Number(r.continuation ?? 0),
      probabilityMigration: terminal ? 0 : Number(r.migration ?? 0),
      probabilityRug: terminal ? Math.max(Number(r.rug ?? 0), 90) : Number(r.rug ?? 0),
      probabilityHit25kBefore10k: Number(r.hit25k_before10k ?? 0),
      probabilityHit100kBefore25k: Number(r.hit100k_before25k ?? 0),
      probabilityHit30kBefore10k: Number(r.hit30k_before10k ?? 0),
      probabilityLocalTop: Number(r.local_top ?? 0),
      probabilityLocalTopWithinNMinutes: Number(r.local_top_within_n_minutes ?? 0),
      score: Number(r.score ?? 0),
      lifecycle: r.lifecycle ?? "new",
      entryScore: 0,
      entrySignal: "avoid",
      exitSignal: terminal ? "dead" : "accumulate",
      earlyUniqueBuyers: 0,
      earlyNetSol: 0,
      peakAt: r.created_at,
      lastTradeAt: r.last_trade_at ?? r.created_at
      } as TokenState;
    });
  }

  /**
   * Real developer intelligence, aggregated directly from observed tokens —
   * completely separate from per-wallet trading stats. Synthetic placeholder
   * dev wallets (DEV_*) are excluded so only real creators show up.
   */
  async listDeveloperStats(limit = 200): Promise<Array<{
    devWallet: string;
    tokens: number;
    migrated: number;
    hits25k: number;
    rugged: number;
    avgAth: number;
    bestAth: number;
    lastLaunch: string;
    reputation: number;
  }>> {
    const rows = await this.rawQuery<{
      dev_wallet: string;
      tokens: number;
      migrated: number;
      hits25k: number;
      rugged: number;
      avg_ath: number;
      best_ath: number;
      last_launch: string;
    }>(
      `SELECT t.dev_wallet,
              count(*)::int AS tokens,
              count(*) FILTER (WHERE t.lifecycle = 'migrated')::int AS migrated,
              count(*) FILTER (WHERE t.ath_mc >= 25000)::int AS hits25k,
              count(*) FILTER (WHERE o.rugged)::int AS rugged,
              COALESCE(round(avg(t.ath_mc)),0)::float8 AS avg_ath,
              COALESCE(round(max(t.ath_mc)),0)::float8 AS best_ath,
              max(t.created_at) AS last_launch
       FROM tokens t
       LEFT JOIN token_outcomes o ON o.mint = t.mint
       WHERE t.dev_wallet IS NOT NULL AND t.dev_wallet <> '' AND t.dev_wallet NOT LIKE 'DEV\\_%'
       GROUP BY t.dev_wallet
       ORDER BY tokens DESC, best_ath DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => {
      const tokens = Number(r.tokens) || 0;
      const migrated = Number(r.migrated) || 0;
      const hits25k = Number(r.hits25k) || 0;
      const rugged = Number(r.rugged) || 0;
      const rate = (x: number) => (tokens > 0 ? x / tokens : 0);
      const reputation = Math.max(
        1,
        Math.min(99, Math.round(50 + rate(migrated) * 30 + rate(hits25k) * 20 - rate(rugged) * 45))
      );
      return {
        devWallet: r.dev_wallet,
        tokens,
        migrated,
        hits25k,
        rugged,
        avgAth: Number(r.avg_ath) || 0,
        bestAth: Number(r.best_ath) || 0,
        lastLaunch: r.last_launch,
        reputation
      };
    });
  }

  async listAlerts(limit = 100): Promise<AlertEvent[]> {
    const rows = await this.rawQuery<{
      id: string;
      mint: string;
      severity: "info" | "warning" | "critical";
      alert_type: string;
      message: string;
      created_at: string;
    }>(
      `SELECT id, mint, severity, alert_type, message, created_at
       FROM alerts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      id: r.id,
      tokenMint: r.mint,
      severity: r.severity,
      type: r.alert_type,
      message: r.message,
      createdAt: r.created_at
    }));
  }

  async listProbabilities(limit = 200): Promise<ProbabilityRecord[]> {
    const rows = await this.rawQuery<{
      mint: string;
      ts: string;
      continuation: number;
      migration: number;
      rug: number;
      hit25k_before10k: number;
      hit100k_before25k: number;
      hit30k_before10k: number;
      local_top: number;
      local_top_within_n_minutes: number;
      score: number;
    }>(
      `SELECT mint, ts, continuation, migration, rug, hit25k_before10k, hit100k_before25k, hit30k_before10k, local_top, local_top_within_n_minutes, score
       FROM probability_history
       ORDER BY ts DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      mint: r.mint,
      timestamp: r.ts,
      continuation: Number(r.continuation ?? 0),
      migration: Number(r.migration ?? 0),
      rug: Number(r.rug ?? 0),
      hit25kBefore10k: Number(r.hit25k_before10k ?? 0),
      hit100kBefore25k: Number(r.hit100k_before25k ?? 0),
      hit30kBefore10k: Number(r.hit30k_before10k ?? 0),
      localTop: Number(r.local_top ?? 0),
      localTopWithinNMinutes: Number(r.local_top_within_n_minutes ?? 0),
      score: Number(r.score ?? 0)
    }));
  }

  async countRawEvents(): Promise<number> {
    const rows = await this.rawQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM raw_events`);
    return Number(rows[0]?.count ?? "0");
  }

  async insertTokenSnapshots(
    rows: Array<{ ts: string; mint: string; marketCap: number; holders: number; buySellRatio: number; smartWalletExposure: number; insiderConcentration: number; continuation: number }>
  ): Promise<void> {
    if (!this.pool || rows.length === 0) return;
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO token_snapshots (ts, mint, market_cap, holder_count, buy_sell_ratio, smart_wallet_exposure, insider_concentration, probability_continuation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.ts, r.mint, r.marketCap, r.holders, r.buySellRatio, r.smartWalletExposure, r.insiderConcentration, r.continuation]
      );
    }
  }

  async listTradesByMint(mint: string, limit = 500): Promise<Array<{ wallet: string; side: string; amountSol: number; tokenAmount: number; marketCap: number; signature: string; ts: string }>> {
    const rows = await this.rawQuery<{ wallet: string; side: string; amount_sol: number; token_amount: number; market_cap: number; signature: string; ts: string }>(
      `SELECT wallet, side, amount_sol, token_amount, market_cap, signature, ts
       FROM trades WHERE mint = $1 ORDER BY ts DESC LIMIT $2`,
      [mint, limit]
    );
    return rows.map((r) => ({
      wallet: r.wallet,
      side: r.side,
      amountSol: Number(r.amount_sol ?? 0),
      tokenAmount: Number(r.token_amount ?? 0),
      marketCap: Number(r.market_cap ?? 0),
      signature: r.signature,
      ts: r.ts
    }));
  }

  async listTradesByWallet(wallet: string, limit = 500): Promise<Array<{ mint: string; side: string; amountSol: number; tokenAmount: number; marketCap: number; signature: string; ts: string }>> {
    const rows = await this.rawQuery<{ mint: string; side: string; amount_sol: number; token_amount: number; market_cap: number; signature: string; ts: string }>(
      `SELECT mint, side, amount_sol, token_amount, market_cap, signature, ts
       FROM trades WHERE wallet = $1 ORDER BY ts DESC LIMIT $2`,
      [wallet, limit]
    );
    return rows.map((r) => ({
      mint: r.mint,
      side: r.side,
      amountSol: Number(r.amount_sol ?? 0),
      tokenAmount: Number(r.token_amount ?? 0),
      marketCap: Number(r.market_cap ?? 0),
      signature: r.signature,
      ts: r.ts
    }));
  }

  async listWalletPositions(wallet: string, limit = 500): Promise<Array<{ mint: string; totalBought: number; totalSold: number; avgEntryMc: number; avgExitMc: number; realizedPnl: number; lastActivityAt: string }>> {
    const rows = await this.rawQuery<{ mint: string; total_bought: number; total_sold: number; avg_entry_mc: number; avg_exit_mc: number; realized_pnl: number; last_activity_at: string }>(
      `SELECT mint, total_bought, total_sold, avg_entry_mc, avg_exit_mc, realized_pnl, last_activity_at
       FROM wallet_token_positions WHERE wallet = $1 ORDER BY last_activity_at DESC LIMIT $2`,
      [wallet, limit]
    );
    return rows.map((r) => ({
      mint: r.mint,
      totalBought: Number(r.total_bought ?? 0),
      totalSold: Number(r.total_sold ?? 0),
      avgEntryMc: Number(r.avg_entry_mc ?? 0),
      avgExitMc: Number(r.avg_exit_mc ?? 0),
      realizedPnl: Number(r.realized_pnl ?? 0),
      lastActivityAt: r.last_activity_at
    }));
  }

  async listWallets(limit = 500): Promise<WalletProfile[]> {
    const rows = await this.rawQuery<{
      wallet: string;
      win_rate: number;
      avg_return_multiple: number;
      confidence: number;
      category: string;
      avg_entry_mc: number;
      avg_exit_mc: number;
      avg_hold_minutes: number;
      migration_success_rate: number;
      rug_exposure_rate: number;
      total_trades: number;
      realized_pnl: number;
    }>(
      // Order by activity (most trades first), NOT by PnL — ordering by PnL and
      // capping would only ever return the winners and hide every losing wallet.
      // Activity gives a representative set spanning the full PnL spectrum.
      `SELECT wallet, win_rate, avg_return_multiple, confidence, category,
              avg_entry_mc, avg_exit_mc, avg_hold_minutes, migration_success_rate,
              rug_exposure_rate, total_trades, realized_pnl
       FROM wallet_scores
       WHERE total_trades > 0
       ORDER BY total_trades DESC, abs(realized_pnl) DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      wallet: r.wallet,
      winRate: Number(r.win_rate ?? 0),
      avgReturnMultiple: Number(r.avg_return_multiple ?? 0),
      confidence: Number(r.confidence ?? 0),
      category: (r.category ?? "unknown") as WalletProfile["category"],
      avgEntryMc: Number(r.avg_entry_mc ?? 0),
      avgExitMc: Number(r.avg_exit_mc ?? 0),
      avgHoldMinutes: Number(r.avg_hold_minutes ?? 0),
      migrationSuccessRate: Number(r.migration_success_rate ?? 0),
      rugExposureRate: Number(r.rug_exposure_rate ?? 0),
      totalTrades: Number(r.total_trades ?? 0),
      realizedPnl: Number(r.realized_pnl ?? 0)
    }));
  }
}
