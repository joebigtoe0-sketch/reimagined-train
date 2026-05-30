import type { CanonicalEvent, TokenState } from "../../types.js";

/**
 * Paper trading bot. Trades the live signals with fake money so we can watch how
 * they would actually perform — no real funds at risk.
 *
 * Strategy = the validated COPY-TRADE edge (scripts/copytrade.mjs):
 *   ENTRY: ACTION = BUY, i.e. ≥2 proven-profitable "leader" wallets bought the
 *          coin while still fresh. Fixed size, once per mint.
 *   EXIT : whichever comes first —
 *          • leader sell  — a tracked leader wallet sells the coin (copy exit)
 *          • time-stop    — held longer than HOLD_STOP_MS without a leader exit
 *          • dead         — token flagged dead/failed
 *
 * Position value is marked to market from the token's current market cap.
 */

export interface PaperPosition {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
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
  exitAt: string;
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
const EXIT_FEE = 0.96; // 4% round-trip fee+slippage (matches the copytrade backtest)
const HOLD_STOP_MS = 120_000; // exit if no leader has sold within 2 minutes

interface Pos {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  solIn: number;
  entryAt: string;
  entryTsMs: number;
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

  start(): void { this.enabled = true; }
  stop(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  reset(): void {
    this.enabled = false;
    this.cash = STARTING_BALANCE;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.positions.clear();
    this.traded.clear();
    this.trades.length = 0;
  }

  /** Tick (every few seconds): entries on BUY + time-stop / dead exits. */
  onToken(token: TokenState): void {
    const pos = this.positions.get(token.mint);
    if (pos) {
      if (token.marketCap > 0) pos.currentMc = token.marketCap;
      if (token.lifecycle === "dead" || token.lifecycle === "failed" || token.action === "DEAD") {
        this.close(token.mint, "dead");
      } else if (Date.now() - pos.entryTsMs >= HOLD_STOP_MS) {
        this.close(token.mint, "timestop");
      }
      return;
    }
    if (this.enabled && token.action === "BUY" && !this.traded.has(token.mint) && token.marketCap > 0) {
      if (this.cash >= BET_SIZE && this.positions.size < MAX_OPEN) {
        this.cash -= BET_SIZE;
        this.positions.set(token.mint, {
          mint: token.mint,
          symbol: token.symbol || token.mint.slice(0, 6),
          entryMc: token.marketCap,
          currentMc: token.marketCap,
          solIn: BET_SIZE,
          entryAt: new Date().toISOString(),
          entryTsMs: Date.now(),
        });
        this.traded.add(token.mint);
      }
    }
  }

  /** Per-trade copy exit: bail when a tracked leader wallet sells the coin. */
  onTrade(token: TokenState, event: CanonicalEvent, leaderSell: boolean): void {
    const pos = this.positions.get(event.mint);
    if (!pos) return;
    if (token.marketCap > 0) pos.currentMc = token.marketCap;
    if (leaderSell) this.close(pos.mint, "leadersell");
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
    this.trades.unshift({
      mint: pos.mint,
      symbol: pos.symbol,
      solIn: round(pos.solIn),
      solOut: round(solOut),
      pnl: round(pnl),
      pnlPct: pos.solIn > 0 ? round((pnl / pos.solIn) * 100) : 0,
      entryMc: Math.round(pos.entryMc),
      exitMc: Math.round(pos.currentMc),
      reason,
      exitAt: new Date().toISOString(),
    });
    if (this.trades.length > 60) this.trades.length = 60;
    this.positions.delete(mint);
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
