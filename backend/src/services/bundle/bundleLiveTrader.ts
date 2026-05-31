/**
 * BundleLiveTrader — real-money execution for the Bundle Sniper strategy.
 *
 * Completely separate from the Playbook LiveTrader so they can be armed/disarmed
 * independently. Entry is triggered by BundleTracker detecting a ≥7 SOL gang-wallet
 * buy (score ≥ 60). Exit uses a 25% trailing stop from peak (no fixed MC target),
 * which the backtest showed is optimal: 73.6% win rate, +106% avg P&L over 417 trades.
 *
 * Hard stop: -30% from entry (protects the downside on the ~27% of trades that die).
 *
 * Bet size: 0.4 SOL per trade (configurable via BUNDLE_BET_SIZE env var).
 */

import type { TokenState } from "../../types.js";
import { env } from "../../config/env.js";
import { PumpPortalExecutor } from "../live/pumpPortalExecutor.js";
import type { BundleSuspect } from "./bundleTracker.js";

// ─── constants ────────────────────────────────────────────────────────────────
const BET_SIZE = env.BUNDLE_BET_SIZE ?? 0.4;
const MAX_OPEN = 5;                   // max simultaneous bundle positions
const TRAIL_FRAC = 0.25;             // exit when MC drops 25% from peak
const HARD_STOP_FRAC = 0.70;        // hard stop at -30% from entry
// Migration exit: sell before the gang can dump on Raydium.
// pump.fun migration threshold moves with SOL price. At $82/SOL it's ~$34k.
// We exit slightly below that to guarantee a fill inside the bonding curve.
// Adjust BUNDLE_MIGRATION_MC in env if SOL price changes significantly.
const MIGRATION_EXIT_MC = env.BUNDLE_MIGRATION_MC ?? 30_000;
const MAX_SELL_ATTEMPTS = 5;
const SELL_BACKOFF_BASE_MS = 8_000;

function round(n: number) { return Math.round(n * 1000) / 1000; }

// ─── types ────────────────────────────────────────────────────────────────────
interface BundlePos {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  solIn: number;
  entryAt: string;
  txBuy?: string;
  selling: boolean;
  sellAttempts: number;
  nextSellAt: number;
}

export interface BundleLivePosition {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  solIn: number;
  value: number;
  pnlPct: number;
  entryAt: string;
  txBuy?: string;
}

export interface BundleLiveTrade {
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
  txBuy?: string;
  txSell?: string;
}

export interface BundleLiveState {
  available: boolean;
  armed: boolean;
  betSize: number;
  openCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  dailyPnl: number;
  positions: BundleLivePosition[];
  trades: BundleLiveTrade[];
}

// ─── trader ──────────────────────────────────────────────────────────────────
export class BundleLiveTrader {
  private armed = false;
  private dailyPnl = 0;
  private wins = 0;
  private losses = 0;
  private readonly positions = new Map<string, BundlePos>();
  private readonly traded = new Set<string>();
  private readonly trades: BundleLiveTrade[] = [];
  private readonly executor: PumpPortalExecutor | null;
  private onTradeLog?: (t: BundleLiveTrade) => void;

  setOnTradeLog(cb: (t: BundleLiveTrade) => void): void { this.onTradeLog = cb; }

  constructor() {
    if (env.LIVE_WALLET_PRIVATE_KEY) {
      try {
        this.executor = new PumpPortalExecutor();
        console.log(`[BundleLive] wallet: ${this.executor.publicKey}`);
      } catch (err) {
        console.error("[BundleLive] failed to load wallet:", err instanceof Error ? err.message : err);
        this.executor = null;
      }
    } else {
      this.executor = null;
    }
  }

  get available(): boolean { return this.executor !== null; }

  arm(): void {
    if (!this.available) { console.warn("[BundleLive] cannot arm — no wallet key"); return; }
    this.armed = true;
    console.log("[BundleLive] ARMED — bundle trades will execute (0.4 SOL/trade, 25% trail)");
  }

  disarm(): void { this.armed = false; console.log("[BundleLive] disarmed"); }
  isArmed(): boolean { return this.armed; }

  reset(): void {
    this.armed = false;
    this.dailyPnl = 0; this.wins = 0; this.losses = 0;
    this.positions.clear(); this.traded.clear(); this.trades.length = 0;
  }

  openMints(): string[] { return [...this.positions.keys()]; }

  /**
   * Called by BundleTracker when a new high-confidence suspect is detected
   * (score ≥ 60, meaning a ≥7 SOL gang-wallet buy was seen pre-bundle).
   */
  onSuspect(suspect: BundleSuspect): void {
    if (!this.armed || !this.executor) return;
    if (this.traded.has(suspect.mint)) return;
    if (this.positions.size >= MAX_OPEN) return;
    if (suspect.currentMc <= 0 || suspect.currentMc >= 25_000) return;

    this.traded.add(suspect.mint);
    void this.executeBuy(suspect);
  }

  /** Called on every token tick — update MC and check trailing/hard stop exits. */
  onToken(token: TokenState): void {
    const pos = this.positions.get(token.mint);
    if (!pos) return;
    if (token.marketCap > 0) {
      pos.currentMc = token.marketCap;
      if (token.symbol) pos.symbol = token.symbol;
    }
    this.checkExit(pos, token.lifecycle === "dead" || token.lifecycle === "failed");
  }

  private async executeBuy(suspect: BundleSuspect): Promise<void> {
    if (!this.executor) return;
    try {
      const result = await this.executor.execute("buy", suspect.mint, BET_SIZE);
      const mc = suspect.currentMc || suspect.detectionMc;
      this.positions.set(suspect.mint, {
        mint: suspect.mint,
        symbol: suspect.symbol,
        entryMc: mc,
        currentMc: mc,
        peakMc: mc,
        solIn: BET_SIZE,
        entryAt: new Date().toISOString(),
        txBuy: result.signature,
        selling: false,
        sellAttempts: 0,
        nextSellAt: 0,
      });
      console.log(`[BundleLive] BUY  $${suspect.symbol} @ $${Math.round(mc)}  score=${suspect.score}  tx:${result.signature.slice(0, 12)}…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BundleLive] BUY failed $${suspect.symbol}: ${msg}`);
      if (!msg.includes("429")) this.traded.delete(suspect.mint);
    }
  }

  private checkExit(pos: BundlePos, dead: boolean): void {
    if (pos.selling) return;
    if (Date.now() < pos.nextSellAt) return;

    if (pos.currentMc > pos.peakMc) pos.peakMc = pos.currentMc;

    let reason: string | null = null;
    // Migration exit: sell before token migrates to Raydium (where gang will dump).
    // This is the primary profit-taking exit for bundle-pump tokens.
    if (pos.currentMc >= MIGRATION_EXIT_MC) reason = "migration";
    // Hard stop: -30% from entry
    else if (pos.currentMc <= pos.entryMc * HARD_STOP_FRAC) reason = "stop";
    // Trailing stop: 25% off peak (catches reversals mid-bonding-curve)
    else if (pos.peakMc > pos.entryMc && pos.currentMc <= pos.peakMc * (1 - TRAIL_FRAC)) reason = "trail";
    else if (dead) reason = "dead";

    if (reason) void this.executeSell(pos, reason);
  }

  private async executeSell(pos: BundlePos, reason: string): Promise<void> {
    if (!this.executor || pos.selling) return;
    pos.selling = true;
    pos.sellAttempts++;

    try {
      const result = await this.executor.execute("sell", pos.mint, "100%");
      const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 1;
      const solOut = round(pos.solIn * ratio * 0.94);
      const pnl = round(solOut - pos.solIn);
      this.dailyPnl += pnl;
      if (pnl >= 0) this.wins++; else this.losses++;
      const trade: BundleLiveTrade = {
        mint: pos.mint, symbol: pos.symbol,
        solIn: round(pos.solIn), solOut, pnl,
        pnlPct: round((pnl / pos.solIn) * 100),
        entryMc: Math.round(pos.entryMc), exitMc: Math.round(pos.currentMc),
        reason, entryAt: pos.entryAt, exitAt: new Date().toISOString(),
        txBuy: pos.txBuy, txSell: result.signature,
      };
      this.trades.unshift(trade);
      if (this.trades.length > 60) this.trades.length = 60;
      this.positions.delete(pos.mint);
      if (this.onTradeLog) this.onTradeLog(trade);
      console.log(`[BundleLive] SELL $${pos.symbol} (${reason})  pnl:${pnl > 0 ? "+" : ""}${pnl.toFixed(3)}◎  tx:${result.signature.slice(0, 12)}…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes("429");

      if (pos.sellAttempts >= MAX_SELL_ATTEMPTS) {
        console.error(`[BundleLive] SELL $${pos.symbol} — gave up after ${pos.sellAttempts} attempts`);
        const trade: BundleLiveTrade = {
          mint: pos.mint, symbol: pos.symbol,
          solIn: round(pos.solIn), solOut: 0, pnl: round(-pos.solIn),
          pnlPct: -100,
          entryMc: Math.round(pos.entryMc), exitMc: Math.round(pos.currentMc),
          reason: `${reason}:abandoned`, entryAt: pos.entryAt, exitAt: new Date().toISOString(),
          txBuy: pos.txBuy,
        };
        this.dailyPnl += trade.pnl;
        this.losses++;
        this.trades.unshift(trade);
        if (this.trades.length > 60) this.trades.length = 60;
        this.positions.delete(pos.mint);
        return;
      }

      const backoffMs = Math.min(
        is429 ? 60_000 : 30_000,
        SELL_BACKOFF_BASE_MS * Math.pow(2, pos.sellAttempts - 1)
      );
      pos.nextSellAt = Date.now() + backoffMs;
      pos.selling = false;
      console.warn(`[BundleLive] SELL failed $${pos.symbol} attempt ${pos.sellAttempts}/${MAX_SELL_ATTEMPTS} (retry in ${backoffMs / 1000}s): ${msg}`);
    }
  }

  state(): BundleLiveState {
    const positions: BundleLivePosition[] = [];
    for (const p of this.positions.values()) {
      const ratio = p.entryMc > 0 ? p.currentMc / p.entryMc : 1;
      const value = p.solIn * ratio;
      positions.push({
        mint: p.mint, symbol: p.symbol,
        entryMc: Math.round(p.entryMc), currentMc: Math.round(p.currentMc), peakMc: Math.round(p.peakMc),
        solIn: p.solIn, value: round(value),
        pnlPct: p.solIn > 0 ? round(((value - p.solIn) / p.solIn) * 100) : 0,
        entryAt: p.entryAt, txBuy: p.txBuy,
      });
    }
    positions.sort((a, b) => b.pnlPct - a.pnlPct);
    const tradeCount = this.wins + this.losses;
    return {
      available: this.available,
      armed: this.armed,
      betSize: BET_SIZE,
      openCount: this.positions.size,
      tradeCount, wins: this.wins, losses: this.losses,
      winRate: tradeCount > 0 ? round((this.wins / tradeCount) * 100) : 0,
      dailyPnl: round(this.dailyPnl),
      positions,
      trades: this.trades.slice(0, 20),
    };
  }
}
