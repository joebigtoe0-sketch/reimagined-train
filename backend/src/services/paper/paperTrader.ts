import type { CanonicalEvent, TokenState } from "../../types.js";

/**
 * Paper trading bot. Trades the live signals with fake money so we can watch how
 * they would actually perform — no real funds at risk.
 *
 * Strategy = the validated PLAYBOOK edge (scripts/playbook.mjs, the only config
 * that survived out-of-sample + slippage stress):
 *   ENTRY: token.playbookBuy — set by PlaybookStrategy when a cheap (≤$12k) coin
 *          crosses the top-5% winner-score and is NOT bundled / serial-sprayed.
 *   EXIT : take profit at 3×, hard stop at −10%, or token flagged dead.
 *
 * Position value is marked to market from the token's current market cap.
 * Round-trip cost is a conservative 6% (matches the validated backtest).
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
const EXIT_FEE = 0.94; // 6% round-trip fee+slippage (conservative; matches playbook backtest)
const TP_MULT = 3.0; // take profit at 3x
const SL_MULT = 0.9; // hard stop at -10%

interface Pos {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
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

  start(): void { this.enabled = true; }
  stop(): void { this.enabled = false; }
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
          solIn: BET_SIZE,
          entryAt: new Date().toISOString(),
        });
        this.traded.add(token.mint);
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

  /** Exit on take-profit (3x), hard stop (-10%), or dead. */
  private checkExit(pos: Pos, dead: boolean): void {
    const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 0;
    if (ratio >= TP_MULT) this.close(pos.mint, "tp");
    else if (ratio <= SL_MULT) this.close(pos.mint, "stop");
    else if (dead) this.close(pos.mint, "dead");
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
