import type { CanonicalEvent, TokenState } from "../../types.js";

/**
 * Paper trading bot. Trades the live signals with fake money so we can watch how
 * they would actually perform — no real funds at risk.
 *
 * Strategy = the validated PLAYBOOK edge (scripts/strathunt.mjs, the only config
 * that survived out-of-sample + slippage stress):
 *   ENTRY: token.playbookBuy — set by PlaybookStrategy when a cheap (≤$12k) coin
 *          crosses the top-20% winner-score and is NOT serial-sprayed.
 *   EXIT : ride to 2×, then trail 30% off the peak; hard stop at −10%; or dead.
 *          (+6.9%/trade out-of-sample on the 20-day, 620k-token validation set:
 *          ~15% win rate, fat-tailed — a few 2×+ runners carry the average.)
 *
 * Position value is marked to market from the token's current market cap.
 * Round-trip cost is a conservative 6% (matches the validated backtest).
 */

export interface PaperPosition {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  riding: boolean;
  solIn: number;
  value: number;
  pnlPct: number;
  entryAt: string;
}

export interface PaperTrade {
  mint: string;
  symbol: string;
  solIn: number;
  solOut: number;
  pnl: number;
  pnlPct: number;
  entryMc: number;
  exitMc: number;
  reason: string;
  entryAt: string;
  exitAt: string;
}

/** Snapshot persisted to the DB so a restart resumes the run instead of resetting. */
export interface PaperPersistedState {
  enabled: boolean;
  cash: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  positions: PaperPosition[];
}

/**
 * Durable store for paper results. Implemented by the runtime engine over the
 * Postgres repo; kept as a narrow interface here so the trader stays decoupled
 * from the DB layer. All methods are fire-and-forget (errors swallowed upstream).
 */
export interface PaperStore {
  persistTrade(trade: PaperTrade): void;
  persistState(state: PaperPersistedState): void;
}

export interface PaperState {
  enabled: boolean;
  startingBalance: number;
  betSize: number;
  cash: number;
  openValue: number;
  equity: number;
  realizedPnl: number;
  totalReturnPct: number;
  openCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  positions: PaperPosition[];
  trades: PaperTrade[];
}

const STARTING_BALANCE = 10; // SOL
const BET_SIZE = 0.5; // SOL per position
const MAX_OPEN = 12;
const EXIT_FEE = 0.94; // 6% round-trip fee+slippage (conservative; matches playbook backtest)
const RIDE_TRIGGER = 2.0; // start trailing once we're up 2x
const TRAIL_FRAC = 0.30; // after the trigger, exit on a 30% give-back from the peak
const SL_MULT = 0.9; // hard stop at -10%

interface Pos {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  riding: boolean;
  solIn: number;
  entryAt: string;
}

export class PaperTrader {
  private enabled = false;
  private cash = STARTING_BALANCE;
  private realizedPnl = 0;
  private wins = 0;
  private losses = 0;
  private readonly positions = new Map<string, Pos>();
  private readonly traded = new Set<string>();
  private readonly trades: PaperTrade[] = [];
  private store: PaperStore | null = null;

  /** Wire the durable store (Postgres-backed). Optional; trader works without it. */
  setStore(store: PaperStore): void { this.store = store; }

  start(): void { this.enabled = true; this.saveState(); }
  stop(): void { this.enabled = false; this.saveState(); }
  isEnabled(): boolean { return this.enabled; }

  /** Mints we currently hold — must keep tracking their trades for TP/SL exits. */
  openMints(): string[] { return [...this.positions.keys()]; }

  reset(): void {
    this.enabled = false;
    this.cash = STARTING_BALANCE;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.positions.clear();
    this.traded.clear();
    this.trades.length = 0;
    this.saveState();
  }

  /** Restore a persisted run on boot so a redeploy resumes instead of resetting. */
  hydrate(saved: PaperPersistedState, recentTrades: PaperTrade[]): void {
    this.enabled = saved.enabled;
    this.cash = saved.cash;
    this.realizedPnl = saved.realizedPnl;
    this.wins = saved.wins;
    this.losses = saved.losses;
    this.positions.clear();
    this.traded.clear();
    for (const p of saved.positions) {
      this.positions.set(p.mint, {
        mint: p.mint, symbol: p.symbol, entryMc: p.entryMc, currentMc: p.currentMc,
        peakMc: p.peakMc, riding: p.riding, solIn: p.solIn, entryAt: p.entryAt,
      });
      this.traded.add(p.mint); // don't re-enter a coin we still hold
    }
    this.trades.length = 0;
    for (const t of recentTrades) {
      if (this.trades.length < 60) this.trades.push(t);
      this.traded.add(t.mint); // don't re-enter a coin we already traded
    }
  }

  /** Persist the current run snapshot (fire-and-forget via the store). */
  saveState(): void {
    if (!this.store) return;
    const positions: PaperPosition[] = [];
    for (const p of this.positions.values()) {
      const ratio = p.entryMc > 0 ? p.currentMc / p.entryMc : 0;
      const value = p.solIn * ratio;
      positions.push({
        mint: p.mint, symbol: p.symbol, entryMc: Math.round(p.entryMc), currentMc: Math.round(p.currentMc),
        peakMc: Math.round(p.peakMc), riding: p.riding, solIn: p.solIn, value: round(value),
        pnlPct: p.solIn > 0 ? round(((value - p.solIn) / p.solIn) * 100) : 0, entryAt: p.entryAt,
      });
    }
    this.store.persistState({ enabled: this.enabled, cash: this.cash, realizedPnl: this.realizedPnl, wins: this.wins, losses: this.losses, positions });
  }

  /** Tick (every few seconds): entries on playbook BUY + exit checks. */
  onToken(token: TokenState): void {
    const pos = this.positions.get(token.mint);
    if (pos) {
      if (token.marketCap > 0) pos.currentMc = token.marketCap;
      this.checkExit(pos, token.lifecycle === "dead" || token.lifecycle === "failed" || token.action === "DEAD");
      return;
    }
    if (this.enabled && token.playbookBuy && !this.traded.has(token.mint)) {
      const entryMc = token.playbookEntryMc && token.playbookEntryMc > 0 ? token.playbookEntryMc : token.marketCap;
      if (entryMc > 0 && this.cash >= BET_SIZE && this.positions.size < MAX_OPEN) {
        this.cash -= BET_SIZE;
        this.positions.set(token.mint, {
          mint: token.mint,
          symbol: token.symbol || token.mint.slice(0, 6),
          entryMc,
          currentMc: token.marketCap > 0 ? token.marketCap : entryMc,
          peakMc: token.marketCap > 0 ? token.marketCap : entryMc,
          riding: false,
          solIn: BET_SIZE,
          entryAt: new Date().toISOString(),
        });
        this.traded.add(token.mint);
        this.saveState();
      }
    }
  }

  /** Per-trade: mark to market and check TP/SL immediately (faster than the tick). */
  onTrade(token: TokenState, event: CanonicalEvent): void {
    const pos = this.positions.get(event.mint);
    if (!pos) return;
    if (token.marketCap > 0) pos.currentMc = token.marketCap;
    this.checkExit(pos, token.lifecycle === "dead" || token.lifecycle === "failed");
  }

  /** Exit: ride to 2x then trail 30% off the peak; hard stop -10%; or dead. */
  private checkExit(pos: Pos, dead: boolean): void {
    if (pos.currentMc > pos.peakMc) pos.peakMc = pos.currentMc;
    const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 0;
    if (ratio <= SL_MULT) { this.close(pos.mint, "stop"); return; }
    if (!pos.riding && ratio >= RIDE_TRIGGER) pos.riding = true;
    if (pos.riding && pos.currentMc <= pos.peakMc * (1 - TRAIL_FRAC)) { this.close(pos.mint, "trail"); return; }
    if (dead) this.close(pos.mint, "dead");
  }

  private close(mint: string, reason: string): void {
    const pos = this.positions.get(mint);
    if (!pos) return;
    const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 0;
    const solOut = pos.solIn * ratio * EXIT_FEE;
    const pnl = solOut - pos.solIn;
    this.cash += solOut;
    this.realizedPnl += pnl;
    if (pnl >= 0) this.wins += 1;
    else this.losses += 1;
    const trade: PaperTrade = {
      mint: pos.mint,
      symbol: pos.symbol,
      solIn: round(pos.solIn),
      solOut: round(solOut),
      pnl: round(pnl),
      pnlPct: pos.solIn > 0 ? round((pnl / pos.solIn) * 100) : 0,
      entryMc: Math.round(pos.entryMc),
      exitMc: Math.round(pos.currentMc),
      reason,
      entryAt: pos.entryAt,
      exitAt: new Date().toISOString(),
    };
    this.trades.unshift(trade);
    if (this.trades.length > 60) this.trades.length = 60;
    this.positions.delete(mint);
    // Durably log the closed trade + the new balance/positions snapshot.
    this.store?.persistTrade(trade);
    this.saveState();
  }

  state(): PaperState {
    let openValue = 0;
    const positions: PaperPosition[] = [];
    for (const p of this.positions.values()) {
      const ratio = p.entryMc > 0 ? p.currentMc / p.entryMc : 0;
      const value = p.solIn * ratio;
      openValue += value;
      positions.push({
        mint: p.mint,
        symbol: p.symbol,
        entryMc: Math.round(p.entryMc),
        currentMc: Math.round(p.currentMc),
        peakMc: Math.round(p.peakMc),
        riding: p.riding,
        solIn: p.solIn,
        value: round(value),
        pnlPct: p.solIn > 0 ? round(((value - p.solIn) / p.solIn) * 100) : 0,
        entryAt: p.entryAt,
      });
    }
    positions.sort((a, b) => b.pnlPct - a.pnlPct);
    const tradeCount = this.wins + this.losses;
    const equity = this.cash + openValue;
    return {
      enabled: this.enabled,
      startingBalance: STARTING_BALANCE,
      betSize: BET_SIZE,
      cash: round(this.cash),
      openValue: round(openValue),
      equity: round(equity),
      realizedPnl: round(this.realizedPnl),
      totalReturnPct: round(((equity - STARTING_BALANCE) / STARTING_BALANCE) * 100),
      openCount: this.positions.size,
      tradeCount,
      wins: this.wins,
      losses: this.losses,
      winRate: tradeCount ? round(this.wins / tradeCount) : 0,
      positions,
      trades: this.trades.slice(0, 30),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
