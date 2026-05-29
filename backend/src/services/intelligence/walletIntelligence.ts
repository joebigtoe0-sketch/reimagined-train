import type { CanonicalEvent, WalletProfile } from "../../types.js";
import { classifyWallet } from "./walletClassifier.js";

/**
 * Real per-wallet trade accounting.
 *
 * Every wallet starts at zero. Stats only move based on the actual buys and
 * sells we observe on the tokens we track:
 *  - realizedPnl is computed in SOL using average cost basis. When a wallet
 *    sells, we match the proceeds against the SOL it spent acquiring the sold
 *    portion. PnL only accrues for round-trips where we saw the buy side too
 *    (if a wallet sells tokens it bought before we were tracking it, we have
 *    no cost basis, so we don't invent a profit).
 *  - winRate is wins / closed trades, expressed as a 0..1 fraction.
 *  - avgHoldMinutes / avgEntryMc / avgExitMc are simple averages over the
 *    relevant real trades.
 */

interface Position {
  tokens: number; // tokens currently held from tracked buys
  solCost: number; // SOL cost basis of the held tokens
  firstBuyTs: number; // ms timestamp of the first buy in the open position
}

// Cumulative per-token stats (survives position close) for durable persistence.
interface PositionStats {
  solBought: number;
  solSold: number;
  realizedPnl: number;
  buyCount: number;
  closedSells: number;
  entryMcSum: number;
  exitMcSum: number;
  lastTs: number;
}

export interface WalletAccount {
  wallet: string;
  positions: Map<string, Position>;
  stats: Map<string, PositionStats>;
  realizedPnlSol: number;
  buys: number;
  sells: number;
  wins: number;
  closedTrades: number; // sells matched against a tracked cost basis
  returnMultipleSum: number;
  holdMinutesSum: number;
  entryMcSum: number;
  exitMcSum: number;
  migrations: number;
  rugFlags: number;
  lastSeenTs: number;
}

export function createWalletAccount(wallet: string): WalletAccount {
  return {
    wallet,
    positions: new Map(),
    stats: new Map(),
    realizedPnlSol: 0,
    buys: 0,
    sells: 0,
    wins: 0,
    closedTrades: 0,
    returnMultipleSum: 0,
    holdMinutesSum: 0,
    entryMcSum: 0,
    exitMcSum: 0,
    migrations: 0,
    rugFlags: 0,
    lastSeenTs: 0
  };
}

function statsFor(acc: WalletAccount, mint: string): PositionStats {
  let s = acc.stats.get(mint);
  if (!s) {
    s = { solBought: 0, solSold: 0, realizedPnl: 0, buyCount: 0, closedSells: 0, entryMcSum: 0, exitMcSum: 0, lastTs: 0 };
    acc.stats.set(mint, s);
  }
  return s;
}

export function applyEventToAccount(acc: WalletAccount, event: CanonicalEvent): void {
  const ts = Date.parse(event.timestamp) || Date.now();
  acc.lastSeenTs = Math.max(acc.lastSeenTs, ts);

  if (event.type === "migration") {
    acc.migrations += 1;
    return;
  }
  if (event.type === "funding" || event.type === "transfer") {
    acc.rugFlags += 1;
    return;
  }
  if (event.type !== "trade" || !event.side) return;

  const tokenAmount = event.tokenAmount ?? 0;
  const sol = event.amountSol ?? 0;

  const stats = statsFor(acc, event.mint);
  stats.lastTs = Math.max(stats.lastTs, ts);

  if (event.side === "buy") {
    acc.buys += 1;
    acc.entryMcSum += event.marketCap || 0;
    stats.solBought += sol;
    stats.buyCount += 1;
    stats.entryMcSum += event.marketCap || 0;
    let pos = acc.positions.get(event.mint);
    if (!pos || pos.tokens <= 0) {
      pos = { tokens: 0, solCost: 0, firstBuyTs: ts };
      acc.positions.set(event.mint, pos);
    }
    pos.tokens += tokenAmount;
    pos.solCost += sol;
    return;
  }

  // sell
  acc.sells += 1;
  const pos = acc.positions.get(event.mint);
  if (!pos || pos.tokens <= 0 || pos.solCost <= 0 || tokenAmount <= 0) return;

  const sellTokens = Math.min(tokenAmount, pos.tokens);
  const fraction = sellTokens / pos.tokens;
  const costOfSold = pos.solCost * fraction;
  const proceeds = sol * (sellTokens / tokenAmount);
  const realized = proceeds - costOfSold;

  acc.realizedPnlSol += realized;
  acc.closedTrades += 1;
  if (realized > 0) acc.wins += 1;
  acc.returnMultipleSum += costOfSold > 0 ? proceeds / costOfSold : 0;
  acc.holdMinutesSum += Math.max(0, (ts - pos.firstBuyTs) / 60_000);
  acc.exitMcSum += event.marketCap || 0;

  stats.solSold += proceeds;
  stats.realizedPnl += realized;
  stats.closedSells += 1;
  stats.exitMcSum += event.marketCap || 0;

  pos.tokens -= sellTokens;
  pos.solCost -= costOfSold;
  if (pos.tokens <= 1e-9) acc.positions.delete(event.mint);
}

/** Durable per-token position row for persistence, or null if untouched. */
export function positionRowFor(
  acc: WalletAccount,
  mint: string
): { wallet: string; mint: string; totalBought: number; totalSold: number; avgEntryMc: number; avgExitMc: number; realizedPnl: number; lastActivityAt: string } | null {
  const s = acc.stats.get(mint);
  if (!s) return null;
  return {
    wallet: acc.wallet,
    mint,
    totalBought: Number(s.solBought.toFixed(6)),
    totalSold: Number(s.solSold.toFixed(6)),
    avgEntryMc: s.buyCount > 0 ? Number((s.entryMcSum / s.buyCount).toFixed(2)) : 0,
    avgExitMc: s.closedSells > 0 ? Number((s.exitMcSum / s.closedSells).toFixed(2)) : 0,
    realizedPnl: Number(s.realizedPnl.toFixed(6)),
    lastActivityAt: new Date(s.lastTs || Date.now()).toISOString()
  };
}

export function deriveWalletProfile(acc: WalletAccount): WalletProfile {
  const totalTrades = acc.buys + acc.sells;
  const winRate = acc.closedTrades > 0 ? acc.wins / acc.closedTrades : 0; // 0..1
  const avgReturnMultiple = acc.closedTrades > 0 ? acc.returnMultipleSum / acc.closedTrades : 0;
  const avgEntryMc = acc.buys > 0 ? acc.entryMcSum / acc.buys : 0;
  const avgExitMc = acc.closedTrades > 0 ? acc.exitMcSum / acc.closedTrades : 0;
  const avgHoldMinutes = acc.closedTrades > 0 ? acc.holdMinutesSum / acc.closedTrades : 0;
  const migrationSuccessRate = acc.buys > 0 ? Math.min(1, acc.migrations / acc.buys) : 0;
  const rugExposureRate = totalTrades > 0 ? Math.min(1, acc.rugFlags / totalTrades) : 0;

  // Confidence grows with sample size + profitability; starts at 0.
  let confidence = Math.min(90, acc.closedTrades * 4);
  if (acc.closedTrades >= 3 && winRate >= 0.5) confidence = Math.min(99, confidence + 8);
  if (acc.realizedPnlSol < 0) confidence = Math.max(0, confidence - 10);

  const profile: WalletProfile = {
    wallet: acc.wallet,
    winRate: Number(winRate.toFixed(4)),
    avgReturnMultiple: Number(avgReturnMultiple.toFixed(3)),
    confidence: Number(confidence.toFixed(2)),
    category: "unknown",
    avgEntryMc: Number(avgEntryMc.toFixed(2)),
    avgExitMc: Number(avgExitMc.toFixed(2)),
    avgHoldMinutes: Number(avgHoldMinutes.toFixed(2)),
    migrationSuccessRate: Number(migrationSuccessRate.toFixed(3)),
    rugExposureRate: Number(rugExposureRate.toFixed(3)),
    totalTrades,
    realizedPnl: Number(acc.realizedPnlSol.toFixed(4))
  };
  profile.category = classifyWallet(profile);
  return profile;
}
