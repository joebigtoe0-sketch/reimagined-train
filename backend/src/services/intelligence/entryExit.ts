import type { CanonicalEvent, TokenState } from "../../types.js";
import { loadStrategyConfig } from "./strategyConfig.js";

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
/** The single headline call shown to the user: what to do right now. */
export type ActionSignal = "BUY" | "WATCH" | "HOLD" | "TRIM" | "EXIT" | "DEAD" | "AVOID";

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
  /** Passes the tuned breadth gate from config/strategy.json (the validated edge). */
  qualified: boolean;
}

export function computeEntry(win: EarlyWindow): EntryAssessment {
  const uniqueBuyers = win.buyers.size;
  const avgBuySol = win.buys > 0 ? win.buySol / win.buys : 0;
  const sellBuyRatio = win.buys > 0 ? win.sells / win.buys : win.sells > 0 ? 99 : 0;
  const netSol = win.buySol - win.sellSol;

  const gate = loadStrategyConfig().entry;
  const qualified =
    uniqueBuyers >= gate.minBuyers && avgBuySol >= gate.minAvgBuySol && sellBuyRatio < gate.maxSellBuyRatio;

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
  // Tuned gate overrides the heuristic buckets: a coin that clears the validated
  // breadth filter is at least "moderate"; one that fails it can't be "strong".
  let entrySignal: EntrySignal =
    entryScore >= 70 ? "strong" : entryScore >= 45 ? "moderate" : entryScore >= 25 ? "weak" : "avoid";
  if (qualified && entrySignal === "weak") entrySignal = "moderate";
  if (!qualified && entrySignal === "strong") entrySignal = "moderate";

  return { entryScore, entrySignal, earlyUniqueBuyers: uniqueBuyers, earlyNetSol: Number(netSol.toFixed(2)), qualified };
}

/**
 * Exit timing from observed price action: did it run, and is it rolling over?
 * `retained` = current MC as a fraction of the all-time-high MC.
 */
export function computeExit(token: TokenState, entryMc: number, ageMinutes: number): ExitSignal {
  const cfg = loadStrategyConfig().exit;
  const ath = token.athMarketCap;
  const retained = ath > 0 ? token.marketCap / ath : 1;
  const pumped = entryMc > 0 && ath >= entryMc * 1.5;

  if (!pumped) {
    return ageMinutes > 12 && retained < 0.6 ? "dead" : "accumulate";
  }

  // Take-profit strategies: once we've hit the target multiple off entry, ring it.
  if ((cfg.strategy === "tp_2x" || cfg.strategy === "tp_3x") && entryMc > 0) {
    if (token.marketCap >= entryMc * cfg.tpMultiple) return "take_profit";
  }
  // Trailing strategies: bail when we've given back more than trailPct from ATH.
  if ((cfg.strategy === "trail_30" || cfg.strategy === "trail_50") && retained < 1 - cfg.trailPct) {
    return retained < 0.4 ? "dead" : "exit";
  }

  if (retained >= 0.92) return "hold"; // at/near highs — let winners run
  if (retained >= 0.7) return "take_profit"; // 8-30% off the top — trim
  if (retained >= 0.4) return "exit"; // breaking down — get out
  return "dead"; // already dumped
}

/**
 * The headline ACTION call — one signal that tells the user what to do now.
 *
 *  BUY   — fresh, alive, not yet pumped, AND high conviction (cleared the tuned
 *          breadth gate, scored well, or smart money is in). The "get in" moment.
 *  WATCH — building but not confirmed; keep it on screen.
 *  HOLD  — already ran and holding near highs (if you're in, let it run).
 *  TRIM  — ran and rolling a bit off the top (take some profit).
 *  EXIT  — broke down, get out.
 *  DEAD  — gone.
 *  AVOID — weak/dust with no breadth, or too late and never delivered.
 */
export function computeAction(args: {
  lifecycle: TokenState["lifecycle"];
  athMarketCap: number;
  entryMc: number;
  ageMinutes: number;
  entryScore: number;
  entrySignal: EntrySignal;
  qualified: boolean;
  smartMoneyBuys: number;
  exitSignal: ExitSignal;
}): ActionSignal {
  if (args.lifecycle === "dead" || args.lifecycle === "failed") return "DEAD";

  const pumped = args.entryMc > 0 && args.athMarketCap >= args.entryMc * 1.5;
  if (pumped) {
    // It already ran — this is now a manage-the-position call.
    if (args.exitSignal === "hold") return "HOLD";
    if (args.exitSignal === "take_profit") return "TRIM";
    return "EXIT"; // exit / dead
  }

  // Pre-entry: only call BUY while it's still realistically enterable (fresh)
  // and conviction is real (tuned gate, strong score, or smart money present).
  const fresh = args.ageMinutes <= 10;
  const smart = args.smartMoneyBuys >= 1;
  const conviction = smart || (args.qualified && args.entryScore >= 45) || args.entrySignal === "strong";
  if (fresh && conviction) return "BUY";
  if (fresh && (args.entrySignal === "moderate" || args.entryScore >= 30)) return "WATCH";
  if (args.entrySignal === "avoid") return "AVOID";
  return fresh ? "WATCH" : "AVOID";
}
