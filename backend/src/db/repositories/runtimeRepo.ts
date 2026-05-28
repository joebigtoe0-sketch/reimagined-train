import type { AlertEvent, AlertRule, CanonicalEvent, DeveloperProfile, ProbabilityRecord, TokenState, WalletProfile } from "../../types.js";
type QueryablePool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export class RuntimeRepo {
  constructor(private readonly pool: QueryablePool | null) {}

  async insertEvent(event: CanonicalEvent): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO raw_events (event_id, source, event_type, mint, wallet, signature, ts, amount_sol, market_cap, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id,
        event.source,
        event.type,
        event.mint,
        event.wallet,
        event.signature,
        event.timestamp,
        event.amountSol,
        event.marketCap,
        JSON.stringify(event.metadata ?? {})
      ]
    );
  }

  async upsertToken(token: TokenState): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO tokens (mint, symbol, dev_wallet, created_at, current_mc, ath_mc, holder_count, buy_count, sell_count, volume, smart_wallet_count, smart_wallet_net_flow, insider_concentration, lifecycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (mint) DO UPDATE SET current_mc = EXCLUDED.current_mc, ath_mc = EXCLUDED.ath_mc, holder_count = EXCLUDED.holder_count,
         buy_count = EXCLUDED.buy_count, sell_count = EXCLUDED.sell_count, volume = EXCLUDED.volume, smart_wallet_count = EXCLUDED.smart_wallet_count,
         smart_wallet_net_flow = EXCLUDED.smart_wallet_net_flow, insider_concentration = EXCLUDED.insider_concentration, lifecycle = EXCLUDED.lifecycle`,
      [
        token.mint,
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
        token.lifecycle
      ]
    );
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

  async upsertTokenOutcome(mint: string, currentMc: number, lifecycle: string): Promise<void> {
    if (!this.pool) return;
    const reached25k = currentMc >= 25_000;
    const reached100k = currentMc >= 100_000;
    const migrated = lifecycle === "migrated";
    const rugged = lifecycle === "failed";
    await this.pool.query(
      `INSERT INTO token_outcomes (mint, reached_25k, reached_100k, migrated, rugged, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (mint) DO UPDATE SET reached_25k = token_outcomes.reached_25k OR EXCLUDED.reached_25k,
         reached_100k = token_outcomes.reached_100k OR EXCLUDED.reached_100k,
         migrated = token_outcomes.migrated OR EXCLUDED.migrated,
         rugged = token_outcomes.rugged OR EXCLUDED.rugged,
         evaluated_at = now()`,
      [mint, reached25k, reached100k, migrated, rugged]
    );
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
}
