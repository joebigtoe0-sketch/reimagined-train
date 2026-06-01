/**
 * BundleLiveTrader — real-money flip execution for Jito-bundle launches.
 *
 * Entry: BundleTracker detects a same-block buy ≥ minTriggerSol (dashboard setting).
 * Exit: take profit at takeProfitPct% from entry; optional timeout market sell.
 */

import type { TokenState } from "../../types.js";
import { PumpPortalExecutor } from "../live/pumpPortalExecutor.js";
import { env } from "../../config/env.js";
import { getBundleSettings } from "./bundleSettings.js";
import type { BundleSettings } from "./bundleSettings.js";
import type { BundleSuspect } from "./bundleTracker.js";

const MAX_OPEN = 5;
const MAX_SELL_ATTEMPTS = 5;
const SELL_BACKOFF_BASE_MS = 8_000;

function round(n: number) { return Math.round(n * 1000) / 1000; }

interface BundlePos {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  targetMc: number;
  solIn: number;
  entryAt: string;
  entryAtMs: number;
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
  targetMc: number;
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
  config: BundleSettings;
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
    const c = getBundleSettings();
    console.log(
      `[BundleLive] ARMED — flip ${c.takeProfitPct}% TP, ≥${c.minTriggerSol}◎ trigger, ` +
      `${c.timeoutMs ? c.timeoutMs / 1000 + "s timeout" : "no timeout"}, ${c.betSize}◎/trade`,
    );
  }

  disarm(): void { this.armed = false; console.log("[BundleLive] disarmed"); }
  isArmed(): boolean { return this.armed; }

  reset(): void {
    this.armed = false;
    this.dailyPnl = 0; this.wins = 0; this.losses = 0;
    this.positions.clear(); this.traded.clear(); this.trades.length = 0;
  }

  openMints(): string[] { return [...this.positions.keys()]; }

  onSuspect(suspect: BundleSuspect): void {
    if (!this.armed || !this.executor) return;
    if (this.traded.has(suspect.mint)) return;
    if (this.positions.size >= MAX_OPEN) return;
    if (suspect.currentMc >= 25_000) return;

    this.traded.add(suspect.mint);
    void this.executeBuy(suspect);
  }

  onToken(token: TokenState): void {
    const pos = this.positions.get(token.mint);
    if (!pos) return;
    if (token.symbol) pos.symbol = token.symbol;

    const dead = token.lifecycle === "dead" || token.lifecycle === "failed";
    const cfg = getBundleSettings();

    if (token.marketCap > 0) {
      if (pos.entryMc <= 0) {
        pos.entryMc = token.marketCap;
        pos.currentMc = token.marketCap;
        pos.targetMc = pos.entryMc * (1 + cfg.takeProfitPct / 100);
        console.log(
          `[BundleLive] ${pos.symbol} entry @ $${Math.round(pos.entryMc)} → target $${Math.round(pos.targetMc)} (+${cfg.takeProfitPct}%)`,
        );
        return;
      }
      pos.currentMc = token.marketCap;
    }

    if (pos.entryMc <= 0) {
      if (dead) void this.executeSell(pos, "dead");
      return;
    }

    this.checkExit(pos, dead);
  }

  private async executeBuy(suspect: BundleSuspect): Promise<void> {
    if (!this.executor) return;
    const cfg = getBundleSettings();
    try {
      const result = await this.executor.execute("buy", suspect.mint, cfg.betSize);
      const mc = suspect.currentMc || suspect.detectionMc;
      const targetMc = mc > 0 ? mc * (1 + cfg.takeProfitPct / 100) : 0;
      this.positions.set(suspect.mint, {
        mint: suspect.mint,
        symbol: suspect.symbol,
        entryMc: mc,
        currentMc: mc,
        targetMc,
        solIn: cfg.betSize,
        entryAt: new Date().toISOString(),
        entryAtMs: Date.now(),
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

    const cfg = getBundleSettings();
    if (pos.targetMc <= 0 && pos.entryMc > 0) {
      pos.targetMc = pos.entryMc * (1 + cfg.takeProfitPct / 100);
    }

    let reason: string | null = null;
    if (pos.entryMc > 0 && pos.currentMc >= pos.targetMc) {
      reason = `tp${cfg.takeProfitPct}`;
    } else if (cfg.timeoutMs > 0 && Date.now() - pos.entryAtMs >= cfg.timeoutMs) {
      reason = "timeout";
    } else if (dead) {
      reason = "dead";
    }

    if (reason) void this.executeSell(pos, reason);
  }

  private async executeSell(pos: BundlePos, reason: string): Promise<void> {
    if (!this.executor || pos.selling) return;
    pos.selling = true;
    pos.sellAttempts++;

    try {
      const result = await this.executor.execute("sell", pos.mint, "100%");
      const ratio = pos.entryMc > 0 ? pos.currentMc / pos.entryMc : 0;
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
        SELL_BACKOFF_BASE_MS * Math.pow(2, pos.sellAttempts - 1),
      );
      pos.nextSellAt = Date.now() + backoffMs;
      pos.selling = false;
      console.warn(`[BundleLive] SELL failed $${pos.symbol} attempt ${pos.sellAttempts}/${MAX_SELL_ATTEMPTS} (retry in ${backoffMs / 1000}s): ${msg}`);
    }
  }

  state(): BundleLiveState {
    const cfg = getBundleSettings();
    const positions: BundleLivePosition[] = [];
    for (const p of this.positions.values()) {
      const ratio = p.entryMc > 0 ? p.currentMc / p.entryMc : 1;
      const value = p.solIn * ratio;
      const targetMc = p.targetMc > 0 ? p.targetMc : p.entryMc * (1 + cfg.takeProfitPct / 100);
      positions.push({
        mint: p.mint, symbol: p.symbol,
        entryMc: Math.round(p.entryMc), currentMc: Math.round(p.currentMc),
        targetMc: Math.round(targetMc), peakMc: Math.round(Math.max(p.currentMc, p.entryMc)),
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
      config: { ...cfg },
      betSize: cfg.betSize,
      openCount: this.positions.size,
      tradeCount, wins: this.wins, losses: this.losses,
      winRate: tradeCount > 0 ? round((this.wins / tradeCount) * 100) : 0,
      dailyPnl: round(this.dailyPnl),
      positions,
      trades: this.trades.slice(0, 20),
    };
  }
}
