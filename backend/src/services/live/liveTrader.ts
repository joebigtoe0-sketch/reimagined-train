/**
 * Live trading bot — executes real SOL trades on the Pump.fun bonding curve
 * using the exact same playbook strategy as the paper bot.
 *
 * Strategy (identical to PaperTrader):
 *   ENTRY : token.playbookBuy fires → buy immediately via PumpPortal trade-local
 *   EXIT  : ride to 2×, trail 30% off peak; hard stop −10%; dead token → sell all
 *
 * Safety rails:
 *   - Off by default; requires explicit "Arm" from the dashboard + a valid
 *     LIVE_WALLET_PRIVATE_KEY env var — without it the class won't construct.
 *   - Hard daily-loss limit (LIVE_MAX_DAILY_LOSS SOL) auto-disarms the bot.
 *   - Max concurrent open positions (LIVE_MAX_OPEN) caps total SOL at risk.
 *   - Each buy/sell is fire-and-forget — a failed tx logs a warning and skips
 *     the trade rather than crashing the process.
 */

import type { CanonicalEvent, TokenState } from "../../types.js";
import { env } from "../../config/env.js";
import { PumpPortalExecutor } from "./pumpPortalExecutor.js";

const BET_SIZE = env.LIVE_BET_SIZE;
const MAX_OPEN = env.LIVE_MAX_OPEN;
const MAX_DAILY_LOSS = env.LIVE_MAX_DAILY_LOSS;
const RIDE_TRIGGER = 2.0;
const TRAIL_FRAC = 0.30;
const SL_MULT = 0.9;

function round(n: number): number { return Math.round(n * 1000) / 1000; }

export interface LivePosition {
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
  txBuy?: string;
}

export interface LiveTrade {
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

export interface LiveState {
  available: boolean;
  armed: boolean;
  walletPublicKey: string;
  betSize: number;
  maxOpen: number;
  dailyPnl: number;
  dailyLossLimit: number;
  openCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  positions: LivePosition[];
  trades: LiveTrade[];
}

// Max sell attempts before giving up and abandoning the position.
const MAX_SELL_ATTEMPTS = 5;
// Minimum milliseconds between sell attempts (doubles each failure, caps at 60s).
const SELL_BACKOFF_BASE_MS = 8_000;

interface Pos {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  riding: boolean;
  solIn: number;
  entryAt: string;
  txBuy?: string;
  selling: boolean;       // true while a sell tx is in-flight
  sellAttempts: number;   // total sell attempts so far
  nextSellAt: number;     // epoch ms: don't retry before this time
}

export class LiveTrader {
  private armed = false;
  private dailyPnl = 0;
  private wins = 0;
  private losses = 0;
  private readonly positions = new Map<string, Pos>();
  private readonly traded = new Set<string>();
  private readonly trades: LiveTrade[] = [];
  private readonly executor: PumpPortalExecutor | null;

  constructor() {
    if (env.LIVE_WALLET_PRIVATE_KEY) {
      try {
        this.executor = new PumpPortalExecutor();
        console.log(`[LiveTrader] wallet: ${this.executor.publicKey}`);
      } catch (err) {
        console.error("[LiveTrader] failed to load wallet keypair:", err instanceof Error ? err.message : err);
        this.executor = null;
      }
    } else {
      this.executor = null;
    }
  }

  /** Whether live trading is possible (wallet key is present and loaded). */
  get available(): boolean { return this.executor !== null; }

  arm(): void {
    if (!this.available) { console.warn("[LiveTrader] cannot arm — no wallet key"); return; }
    this.armed = true;
    console.log("[LiveTrader] ARMED — real trades will execute");
  }

  disarm(): void {
    this.armed = false;
    console.log("[LiveTrader] disarmed");
  }

  isArmed(): boolean { return this.armed; }

  reset(): void {
    this.armed = false;
    this.dailyPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.positions.clear();
    this.traded.clear();
    this.trades.length = 0;
  }

  openMints(): string[] { return [...this.positions.keys()]; }

  /** Called every tick to mark positions to market and check exits. */
  onToken(token: TokenState): void {
    const pos = this.positions.get(token.mint);
    if (pos) {
      if (token.marketCap > 0) pos.currentMc = token.marketCap;
      this.checkExit(pos, token.lifecycle === "dead" || token.lifecycle === "failed" || token.action === "DEAD");
      return;
    }
    if (!this.armed || !this.executor) return;
    if (token.playbookBuy && !this.traded.has(token.mint)) {
      if (this.dailyPnl <= -MAX_DAILY_LOSS) {
        console.warn(`[LiveTrader] daily loss limit hit (${this.dailyPnl.toFixed(3)} SOL) — auto-disarming`);
        this.disarm();
        return;
      }
      const entryMc = token.playbookEntryMc && token.playbookEntryMc > 0 ? token.playbookEntryMc : token.marketCap;
      if (entryMc > 0 && this.positions.size < MAX_OPEN) {
        this.traded.add(token.mint);
        void this.executeBuy(token, entryMc);
      }
    }
  }

  /** Called on every incoming trade event for tokens we hold. */
  onTrade(token: TokenState, _event: CanonicalEvent): void {
    const pos = this.positions.get(token.mint);
    if (!pos) return;
    if (token.marketCap > 0) pos.currentMc = token.marketCap;
    this.checkExit(pos, token.lifecycle === "dead" || token.lifecycle === "failed");
  }

  private async executeBuy(token: TokenState, entryMc: number): Promise<void> {
    if (!this.executor) return;
    try {
      const result = await this.executor.execute("buy", token.mint, BET_SIZE);
      const mc = token.marketCap > 0 ? token.marketCap : entryMc;
        this.positions.set(token.mint, {
        mint: token.mint,
        symbol: token.symbol || token.mint.slice(0, 6),
        entryMc,
        currentMc: mc,
        peakMc: mc,
        riding: false,
        solIn: BET_SIZE,
        entryAt: new Date().toISOString(),
        txBuy: result.signature,
        selling: false,
        sellAttempts: 0,
        nextSellAt: 0,
      });
      console.log(`[LiveTrader] BUY  $${token.symbol} @ $${Math.round(entryMc)}  tx:${result.signature.slice(0, 12)}…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[LiveTrader] BUY failed $${token.symbol}: ${msg}`);
      // Only un-gate if it was a transient error we might recover from.
      // For 429 keep it gated (the token window will have passed anyway).
      if (!msg.includes("429")) {
        this.traded.delete(token.mint);
      }
    }
  }

  private checkExit(pos: Pos, dead: boolean): void {
    if (pos.selling) return;
    // Respect the exponential-backoff window between sell attempts.
    if (Date.now() < pos.nextSellAt) return;
    if (pos.currentMc > pos.peakMc) pos.peakMc = pos.currentMc;
    const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 0;

    let reason: string | null = null;
    if (ratio <= SL_MULT) reason = "stop";
    else if (!pos.riding && ratio >= RIDE_TRIGGER) pos.riding = true;
    if (!reason && pos.riding && pos.currentMc <= pos.peakMc * (1 - TRAIL_FRAC)) reason = "trail";
    if (!reason && dead) reason = "dead";

    if (reason) void this.executeSell(pos, reason);
  }

  private async executeSell(pos: Pos, reason: string): Promise<void> {
    if (!this.executor || pos.selling) return;
    pos.selling = true;
    pos.sellAttempts += 1;

    try {
      const result = await this.executor.execute("sell", pos.mint, "100%");
      const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 0;
      const solOut = round(pos.solIn * ratio * 0.94);
      const pnl = round(solOut - pos.solIn);
      this.dailyPnl += pnl;
      if (pnl >= 0) this.wins += 1; else this.losses += 1;
      const trade: LiveTrade = {
        mint: pos.mint, symbol: pos.symbol,
        solIn: round(pos.solIn), solOut, pnl,
        pnlPct: pos.solIn > 0 ? round((pnl / pos.solIn) * 100) : 0,
        entryMc: Math.round(pos.entryMc), exitMc: Math.round(pos.currentMc),
        reason, entryAt: pos.entryAt, exitAt: new Date().toISOString(),
        txBuy: pos.txBuy, txSell: result.signature,
      };
      this.trades.unshift(trade);
      if (this.trades.length > 60) this.trades.length = 60;
      this.positions.delete(pos.mint);
      console.log(`[LiveTrader] SELL $${pos.symbol} (${reason})  pnl:${pnl > 0 ? "+" : ""}${pnl.toFixed(3)}◎  tx:${result.signature.slice(0, 12)}…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes("429");

      if (pos.sellAttempts >= MAX_SELL_ATTEMPTS) {
        // Give up — we can't sell this position. Log it as a write-off and remove.
        console.error(`[LiveTrader] SELL $${pos.symbol} — gave up after ${pos.sellAttempts} attempts, abandoning position. Last error: ${msg}`);
        const trade: LiveTrade = {
          mint: pos.mint, symbol: pos.symbol,
          solIn: round(pos.solIn), solOut: 0, pnl: round(-pos.solIn),
          pnlPct: -100,
          entryMc: Math.round(pos.entryMc), exitMc: Math.round(pos.currentMc),
          reason: `${reason}:abandoned`, entryAt: pos.entryAt, exitAt: new Date().toISOString(),
          txBuy: pos.txBuy,
        };
        this.dailyPnl += trade.pnl;
        this.losses += 1;
        this.trades.unshift(trade);
        if (this.trades.length > 60) this.trades.length = 60;
        this.positions.delete(pos.mint);
        return;
      }

      // Exponential backoff: 8s, 16s, 32s, 64s (capped at 60s for 429, 30s otherwise)
      const backoffMs = Math.min(
        is429 ? 60_000 : 30_000,
        SELL_BACKOFF_BASE_MS * Math.pow(2, pos.sellAttempts - 1)
      );
      pos.nextSellAt = Date.now() + backoffMs;
      pos.selling = false;
      console.warn(`[LiveTrader] SELL failed $${pos.symbol} attempt ${pos.sellAttempts}/${MAX_SELL_ATTEMPTS} (retry in ${backoffMs / 1000}s): ${msg}`);
    }
  }

  state(): LiveState {
    const positions: LivePosition[] = [];
    for (const p of this.positions.values()) {
      const ratio = p.entryMc > 0 ? p.currentMc / p.entryMc : 0;
      const value = p.solIn * ratio;
      positions.push({
        mint: p.mint, symbol: p.symbol, entryMc: Math.round(p.entryMc),
        currentMc: Math.round(p.currentMc), peakMc: Math.round(p.peakMc),
        riding: p.riding, solIn: p.solIn, value: round(value),
        pnlPct: p.solIn > 0 ? round(((value - p.solIn) / p.solIn) * 100) : 0,
        entryAt: p.entryAt, txBuy: p.txBuy,
      });
    }
    positions.sort((a, b) => b.pnlPct - a.pnlPct);
    const tradeCount = this.wins + this.losses;
    return {
      available: this.available,
      armed: this.armed,
      walletPublicKey: this.executor?.publicKey ?? "",
      betSize: BET_SIZE,
      maxOpen: MAX_OPEN,
      dailyPnl: round(this.dailyPnl),
      dailyLossLimit: MAX_DAILY_LOSS,
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
