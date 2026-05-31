/**
 * BundleTracker — real-time monitor for the "slow-crawl → bundle-pump → migrate" pattern.
 *
 * Detection gate (behavioral — no wallet list required):
 *   ANY wallet that buys ≥7 SOL before 18k MC triggers a new suspect.
 *   This catches ALL gangs / teams running this play, not just known wallets.
 *
 * Backtest (44.6M trades, 30 days):
 *   17,316 triggers/month  |  22.4% reach migration  |  3.9× better than random
 *   Pure trailing stop: avg +7.4% P&L, 31.1% win rate
 *
 * Scoring 0–100:
 *   60  — base: first ≥7 SOL buy (any wallet)
 *   +15 — per additional ≥7 SOL buyer (cap 90)
 *   +10 — bonus if ANY triggering wallet is a known gang wallet (higher certainty)
 *   +10 — very early detection (MC < 5k)
 *   +5  — early detection (MC < 12k)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalEvent, TokenState } from "../../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Accumulation phase: any buy ≥7 SOL BEFORE this MC triggers detection
const PRE_BUNDLE_MC   = 18_000;
// Suspects older than this are expired
const SUSPECT_TTL_MS  = 60 * 60_000;
// Suspects past this MC are expired (already migrating / failed)
const EXPIRE_MC       = 40_000;

// Behavioral gate — from splitexit.mjs / behaviorgate.mjs validation:
// ANY wallet buying ≥7 SOL before 18k MC → 22.4% reach migration (3.9× baseline)
const MIN_TRIGGER_SOL = 7;

// ─── scoring ──────────────────────────────────────────────────────────────────
const SCORE_BASE_TRIGGER   = 60;  // first ≥7 SOL buy (any wallet)
const SCORE_PER_EXTRA_BUYER = 15; // each additional ≥7 SOL buyer
const SCORE_BUYER_CAP       = 90; // cap from buyer count
const SCORE_KNOWN_GANG      = 10; // bonus: triggering wallet is a known gang wallet
const SCORE_VERY_EARLY      = 10; // MC < 5k at detection
const SCORE_EARLY           =  5; // MC < 12k at detection

export interface BundleSuspect {
  mint: string;
  symbol: string;
  detectedAt: string;
  detectionMc: number;
  currentMc: number;
  /** All wallets that made a ≥7 SOL buy (behavioral signal, any wallet) */
  gangWallets: string[];
  gangWalletCount: number;
  /** How many of those wallets are in our known gang list (extra confidence) */
  knownGangCount: number;
  totalBuys: number;
  totalSells: number;
  buyToSellRatio: number;
  largestBuySol: number;
  score: number;
}

export interface BundleState {
  suspects: BundleSuspect[];
  gangWalletCount: number;
  totalDetected: number;     // running count including expired
}

// ─── internal suspect record ──────────────────────────────────────────────────
interface Suspect {
  mint: string;
  symbol: string;
  detectedAt: number;
  detectionMc: number;
  currentMc: number;
  /** Any wallet with a ≥7 SOL buy (behavioral gate, wallet-list-free) */
  whaleBuyers: Set<string>;
  /** Subset of whaleBuyers that are also in the known gang list */
  knownGangBuyers: Set<string>;
  totalBuys: number;
  totalSells: number;
  largestBuySol: number;
}

function calcScore(s: Suspect): number {
  if (s.whaleBuyers.size === 0) return 0;
  let score = SCORE_BASE_TRIGGER;
  score += Math.min(SCORE_BUYER_CAP - SCORE_BASE_TRIGGER, (s.whaleBuyers.size - 1) * SCORE_PER_EXTRA_BUYER);
  // Bonus if any triggering wallet is a known gang wallet (higher certainty)
  if (s.knownGangBuyers.size > 0) score += SCORE_KNOWN_GANG;
  if (s.detectionMc < 5_000) score += SCORE_VERY_EARLY;
  else if (s.detectionMc < 12_000) score += SCORE_EARLY;
  return Math.min(100, score);
}

function toPublic(s: Suspect): BundleSuspect {
  const bs = s.totalSells > 0 ? s.totalBuys / s.totalSells : s.totalBuys;
  return {
    mint: s.mint,
    symbol: s.symbol,
    detectedAt: new Date(s.detectedAt).toISOString(),
    detectionMc: Math.round(s.detectionMc),
    currentMc: Math.round(s.currentMc),
    gangWallets: [...s.whaleBuyers],
    gangWalletCount: s.whaleBuyers.size,
    knownGangCount: s.knownGangBuyers.size,
    totalBuys: s.totalBuys,
    totalSells: s.totalSells,
    buyToSellRatio: +bs.toFixed(2),
    largestBuySol: +s.largestBuySol.toFixed(3),
    score: calcScore(s),
  };
}

export class BundleTracker {
  /** Known gang wallets — used for scoring bonus only, NOT as an entry gate. */
  private readonly gangWallets: Set<string>;
  private readonly suspects = new Map<string, Suspect>();
  private totalDetected = 0;
  private onNewSuspect?: (s: BundleSuspect) => void;

  setOnNewSuspect(cb: (s: BundleSuspect) => void): void { this.onNewSuspect = cb; }

  constructor() {
    const jsonPath = path.join(__dirname, "gangWallets.json");
    try {
      const raw = fs.readFileSync(jsonPath, "utf8");
      this.gangWallets = new Set(JSON.parse(raw) as string[]);
      console.log(`[BundleTracker] loaded ${this.gangWallets.size} known gang wallets (scoring bonus only)`);
    } catch {
      console.warn("[BundleTracker] gangWallets.json not found");
      this.gangWallets = new Set(SEED_WALLETS);
    }
  }

  /** Called on every trade event from the runtime engine. */
  onTrade(event: CanonicalEvent): void {
    if (event.type !== "trade" || event.side !== "buy") return;
    if (!event.mint || !event.wallet) return;
    const mc  = event.marketCap || 0;
    const sol = event.amountSol || 0;
    const isKnownGang    = this.gangWallets.has(event.wallet);
    const isWhaleBuy     = sol >= MIN_TRIGGER_SOL && (mc < PRE_BUNDLE_MC || mc === 0);

    // Update existing suspect on every subsequent buy
    const existing = this.suspects.get(event.mint);
    if (existing) {
      if (mc > 0) existing.currentMc = mc;
      existing.totalBuys++;
      if (sol > existing.largestBuySol) existing.largestBuySol = sol;
      if (isWhaleBuy) {
        const prev = existing.whaleBuyers.size;
        existing.whaleBuyers.add(event.wallet);
        if (isKnownGang) existing.knownGangBuyers.add(event.wallet);
        if (existing.whaleBuyers.size > prev) {
          console.log(`[BundleTracker] ${event.mint.slice(0, 8)}… +whale buyer → ${existing.whaleBuyers.size}${isKnownGang ? " [KNOWN GANG]" : ""} score=${calcScore(existing)}`);
        }
      }
      return;
    }

    // Create a new suspect on the FIRST ≥7 SOL buy from ANY wallet before 18k MC
    if (!isWhaleBuy) return;

    const newSuspect: Suspect = {
      mint: event.mint,
      symbol: "?",
      detectedAt: Date.now(),
      detectionMc: mc,
      currentMc: mc,
      whaleBuyers: new Set([event.wallet]),
      knownGangBuyers: isKnownGang ? new Set([event.wallet]) : new Set(),
      totalBuys: 1,
      totalSells: 0,
      largestBuySol: sol,
    };
    this.suspects.set(event.mint, newSuspect);
    this.totalDetected++;
    const gangTag = isKnownGang ? " [KNOWN GANG ✓]" : "";
    console.log(`[BundleTracker] NEW ${event.mint.slice(0, 8)}… MC=$${Math.round(mc)} sol=${sol.toFixed(2)}${gangTag}`);
    if (this.onNewSuspect) this.onNewSuspect(toPublic(newSuspect));
  }

  /** Called on sell events to track buy/sell ratio on suspects. */
  onSell(event: CanonicalEvent): void {
    const s = this.suspects.get(event.mint);
    if (s) s.totalSells++;
  }

  /** Called on every token state update — syncs symbol + MC, expires old suspects. */
  onToken(token: TokenState): void {
    const s = this.suspects.get(token.mint);
    if (!s) return;
    if (token.symbol) s.symbol = token.symbol;
    if (token.marketCap > 0) s.currentMc = token.marketCap;

    // Expire: too old, or token already well past bundle phase
    const age = Date.now() - s.detectedAt;
    if (age > SUSPECT_TTL_MS || s.currentMc > EXPIRE_MC) {
      this.suspects.delete(token.mint);
    }
  }

  state(): BundleState {
    this.expire();
    const suspects = [...this.suspects.values()]
      .map(toPublic)
      .sort((a, b) => b.score - a.score);
    return {
      suspects,
      gangWalletCount: this.gangWallets.size,
      totalDetected: this.totalDetected,
    };
  }

  private expire(): void {
    const now = Date.now();
    for (const [mint, s] of this.suspects) {
      if (now - s.detectedAt > SUSPECT_TTL_MS || s.currentMc > EXPIRE_MC) {
        this.suspects.delete(mint);
      }
    }
  }
}

// Fallback seed wallets in case gangWallets.json is missing
const SEED_WALLETS = [
  "2jJKTKDutvjjrvidauACS9efVdyRbYN5ymqbFTcPnH8V",
  "GRANRPGS4wFKVAGwM5ScD6rreNHFs7SmET7GhH2U7EWB",
  "3NxtfjKwBj2HD2myH6DRu2Hzzz6qNZyWwUL7aUyVDC5L",
  "C9Efxy4pJtfRTYWxrSYGaR7g3KXco7DdDmCRjZyabS7B",
  "CyPYsEpWQqS2Cc9kofDXbrVVtmD1PpqMikkhSko9PTgt",
  "HkhDTEEnsPbyNxfBknG693Bhd3mqczXcDo9RQctR7Pyz",
  "3MXhTXKbxwo4YV4RqTtkN2oHPdxGdALPfXjvMQfPdKB2",
  "F4nx9DbZxQhR2nf8TfRnZ9hFxWJa9tC2BK6ZVrEG2ky9",
  "5eBXiivHtjcC7mLywBAHBwsTfWT5MEpdfVk2RrGdZgWB",
  "4zvSPaPCYDd7cprVHnGKrAaMCFRKQ8Bb9YuxrmHonYNG",
  "FiqF4oTdUGatFQvaEcv41yzaamedkxFgZ7BSxx49TsMZ",
  "4h5DvYLwGQyiC5ojub42PBeArsaBGxVkZqwvENjutm1D",
  "5QC5ydrKn3wigKB27g24PdNPAzkRZitLxdV7tA6c1Yk1",
  "3TxCFKgMUgCB99YQJ8TgEJjP9Uzgk8FUXcH1p7rxRF1e",
  "DGidLoNkmkHHSSNi8nS4fF6FvUrhRaNkpGyNQ5qcvE83",
  "FZ8yTKQxBYf29VELRWxAkd8avHPB1wFxtfwvKbH9SGur",
  "864SeaHY5H7FGBcY6JzHfYDPf9nzBNNDxu1zdyExVQUF",
  "Hn9B5qcoHAQZg6YsjT6twgugzw1YTNF9qahC1n7UKBao",
  "78e9BM4nBbHDrXhoPNa9GZ1DRe6ZVBbem8KEfCyhtWB7",
];
