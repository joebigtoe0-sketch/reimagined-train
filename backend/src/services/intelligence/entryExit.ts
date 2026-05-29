import type { CanonicalEvent, TokenState } from "../../types.js";

/**
 * Entry / exit intelligence.
 *
 * Derived directly from the patterns surfaced by scripts/analyze.mjs:
 *  - The #1 predictor of a >=2x run is EARLY BREADTH of participation in the
 *    first 5 minutes (unique buyers / holders), with healthy buy sizes
 *    (0.1-1.5 SOL, not dust) and buys outweighing sells.
 *  - Dust-only buys (<0.1 SOL avg) and <5 unique buyers => almost always dead.
 *
 * These weights are PROVISIONAL and intentionally transparent so they can be
 * re-tuned as the matured sample grows. Nothing here feeds the probability
 * model — it's a separate, honest "should I ape / should I bail" signal.
 */

export const EARLY_WINDOW_MS = 5 * 60 * 1000;

export interface EarlyWindow {
  startMs: number;
  entryMc: number;
  buyers: Set<string>;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
}

export type EntrySignal = "strong" | "moderate" | "weak" | "avoid";
export type ExitSignal = "accumulate" | "hold" | "take_profit" | "exit" | "dead";

export function createEarlyWindow(startMs: number, entryMc: number): EarlyWindow {
  return { startMs, entryMc: entryMc > 0 ? entryMc : 0, buyers: new Set(), buys: 0, sells: 0, buySol: 0, sellSol: 0 };
}

export function isWithinEarlyWindow(win: EarlyWindow, eventMs: number): boolean {
  return eventMs - win.startMs <= EARLY_WINDOW_MS;
}

export function applyTradeToWindow(win: EarlyWindow, event: CanonicalEvent): void {
  if (event.type !== "trade") return;
  const ts = Date.parse(event.timestamp);
  if (!Number.isFinite(ts) || !isWithinEarlyWindow(win, ts)) return;
  if (win.entryMc <= 0 && event.marketCap > 0) win.entryMc = event.marketCap;
  if (event.side === "sell") {
    win.sells += 1;
    win.sellSol += event.amountSol;
  } else {
    win.buys += 1;
    win.buySol += event.amountSol;
    if (event.wallet && event.wallet !== "UNKNOWN_WALLET") win.buyers.add(event.wallet);
  }
}

export interface EntryAssessment {
  entryScore: number;
  entrySignal: EntrySignal;
  earlyUniqueBuyers: number;
  earlyNetSol: number;
}

export function computeEntry(win: EarlyWindow): EntryAssessment {
  const uniqueBuyers = win.buyers.size;
  const avgBuySol = win.buys > 0 ? win.buySol / win.buys : 0;
  const sellBuyRatio = win.buys > 0 ? win.sells / win.buys : win.sells > 0 ? 99 : 0;
  const netSol = win.buySol - win.sellSol;

  let s = 0;
  // Early breadth — strongest signal (max 45).
  if (uniqueBuyers >= 40) s += 45;
  else if (uniqueBuyers >= 15) s += 38;
  else if (uniqueBuyers >= 8) s += 24;
  else if (uniqueBuyers >= 5) s += 14;

  // Buy size sweet spot 0.1-1.5 SOL; dust (<0.1) scores nothing (max 20).
  if (avgBuySol >= 0.1 && avgBuySol <= 1.5) s += 20;
  else if (avgBuySol > 1.5) s += 10;

  // Buy/sell pressure once there's a meaningful sample (max 20).
  if (win.buys + win.sells >= 3) {
    if (sellBuyRatio < 0.7) s += 20;
    else if (sellBuyRatio < 1.0) s += 12;
  }

  // Net SOL inflow (max 15).
  if (netSol >= 5) s += 15;
  else if (netSol > 0) s += 8;

  const entryScore = Math.max(0, Math.min(100, Math.round(s)));
  const entrySignal: EntrySignal =
    entryScore >= 70 ? "strong" : entryScore >= 45 ? "moderate" : entryScore >= 25 ? "weak" : "avoid";

  return { entryScore, entrySignal, earlyUniqueBuyers: uniqueBuyers, earlyNetSol: Number(netSol.toFixed(2)) };
}

/**
 * Exit timing from observed price action: did it run, and is it rolling over?
 * `retained` = current MC as a fraction of the all-time-high MC.
 */
export function computeExit(token: TokenState, entryMc: number, ageMinutes: number): ExitSignal {
  const ath = token.athMarketCap;
  const retained = ath > 0 ? token.marketCap / ath : 1;
  const pumped = entryMc > 0 && ath >= entryMc * 1.5;

  if (!pumped) {
    return ageMinutes > 12 && retained < 0.6 ? "dead" : "accumulate";
  }
  if (retained >= 0.92) return "hold"; // at/near highs — let winners run
  if (retained >= 0.7) return "take_profit"; // 8-30% off the top — trim
  if (retained >= 0.4) return "exit"; // breaking down — get out
  return "dead"; // already dumped
}
