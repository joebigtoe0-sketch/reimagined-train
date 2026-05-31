/**
 * BundleTracker — real-time monitor for the "slow-crawl → bundle-pump → migrate" scam pattern.
 *
 * How it works:
 *   1. Maintains a set of ~4000 known "gang wallets" identified from historical analysis
 *      (see scripts/bundleexpand.mjs for the methodology).
 *   2. On every incoming trade event: if the wallet is in the gang list AND the token is
 *      still below the bundle threshold MC (< 25k), add / update a BundleSuspect.
 *   3. Each suspect is scored 0–100 based on:
 *        • Number of distinct gang wallets that have bought  (primary signal)
 *        • Buy-to-sell ratio (high = no organic selling pressure)
 *        • Largest single pre-25k buy in SOL            (sybil-wallet size marker)
 *        • How early we first detected it (MC at first ping)
 *   4. Suspects expire 60 min after first detection or when MC exceeds 60k.
 *
 * Backtest result (20 days, 1709 confirmed gang tokens):
 *   Win rate 11.6%  |  avg P&L +8.6%/trade  |  avg winner +435%  (very right-tailed)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalEvent, TokenState } from "../../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MC below which a gang wallet buy is treated as the "accumulation phase"
const PRE_BUNDLE_MC = 25_000;
// Suspects older than this are expired
const SUSPECT_TTL_MS = 60 * 60_000;
// Suspects whose MC exceeded this are expired (they already bundled or failed)
const EXPIRE_MC = 60_000;

// ─── scoring weights ──────────────────────────────────────────────────────────
// Each distinct gang wallet buy: +30 points (cap at 90 for 3+ wallets)
const SCORE_PER_WALLET = 30;
const SCORE_WALLET_CAP = 90;
// Buy/sell ratio bonus
const SCORE_HIGH_BS = 10;  // ratio > 8
const SCORE_MED_BS  = 5;   // ratio > 4
// Largest single pre-bundle buy bonus
const SCORE_BIG_BUY  = 10; // > 5 SOL
const SCORE_MED_BUY  = 5;  // > 2 SOL
// Early detection bonus
const SCORE_VERY_EARLY = 10; // MC < 5k at first detection
const SCORE_EARLY      = 5;  // MC < 12k

export interface BundleSuspect {
  mint: string;
  symbol: string;
  detectedAt: string;        // ISO timestamp of first gang wallet buy
  detectionMc: number;       // MC at first detection
  currentMc: number;
  gangWallets: string[];     // distinct gang wallet addresses that bought
  gangWalletCount: number;
  totalBuys: number;
  totalSells: number;
  buyToSellRatio: number;
  largestBuySol: number;
  score: number;             // 0–100 confidence
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
  detectedAt: number;        // epoch ms
  detectionMc: number;
  currentMc: number;
  gangWallets: Set<string>;
  totalBuys: number;
  totalSells: number;
  largestBuySol: number;
}

function calcScore(s: Suspect): number {
  let score = Math.min(SCORE_WALLET_CAP, s.gangWallets.size * SCORE_PER_WALLET);
  const bs = s.totalSells > 0 ? s.totalBuys / s.totalSells : s.totalBuys;
  if (bs > 8) score += SCORE_HIGH_BS;
  else if (bs > 4) score += SCORE_MED_BS;
  if (s.largestBuySol > 5) score += SCORE_BIG_BUY;
  else if (s.largestBuySol > 2) score += SCORE_MED_BUY;
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
    gangWallets: [...s.gangWallets],
    gangWalletCount: s.gangWallets.size,
    totalBuys: s.totalBuys,
    totalSells: s.totalSells,
    buyToSellRatio: +bs.toFixed(2),
    largestBuySol: +s.largestBuySol.toFixed(3),
    score: calcScore(s),
  };
}

export class BundleTracker {
  private readonly gangWallets: Set<string>;
  private readonly suspects = new Map<string, Suspect>();
  private totalDetected = 0;

  constructor() {
    // Load the gang wallet list from the committed JSON file.
    // Falls back gracefully to the seed list if the file is missing.
    const jsonPath = path.join(__dirname, "gangWallets.json");
    try {
      const raw = fs.readFileSync(jsonPath, "utf8");
      this.gangWallets = new Set(JSON.parse(raw) as string[]);
      console.log(`[BundleTracker] loaded ${this.gangWallets.size} gang wallets`);
    } catch {
      console.warn("[BundleTracker] gangWallets.json not found — using seed list only");
      this.gangWallets = new Set(SEED_WALLETS);
    }
  }

  /** Called on every trade event from the runtime engine. */
  onTrade(event: CanonicalEvent): void {
    if (event.type !== "trade" || event.side !== "buy") return;
    if (!event.mint || !event.wallet) return;
    const mc = event.marketCap || 0;

    // Update currentMc on existing suspects regardless of wallet
    const existing = this.suspects.get(event.mint);
    if (existing) {
      if (mc > 0) existing.currentMc = mc;
      existing.totalBuys++;
      // Track large buys even from non-gang wallets (pattern signal)
      if (mc < PRE_BUNDLE_MC && (event.amountSol || 0) > existing.largestBuySol) {
        existing.largestBuySol = event.amountSol || 0;
      }
    }

    // Only create / enrich with gang wallet signal
    if (!this.gangWallets.has(event.wallet)) return;
    if (mc >= PRE_BUNDLE_MC) return; // already in bundle phase, too late to flag

    if (!existing) {
      this.suspects.set(event.mint, {
        mint: event.mint,
        symbol: "?", // filled in by onToken
        detectedAt: Date.now(),
        detectionMc: mc,
        currentMc: mc,
        gangWallets: new Set([event.wallet]),
        totalBuys: 1,
        totalSells: 0,
        largestBuySol: event.amountSol || 0,
      });
      this.totalDetected++;
      console.log(`[BundleTracker] NEW suspect ${event.mint.slice(0, 8)}… MC=$${Math.round(mc)} wallet=${event.wallet.slice(0, 8)}…`);
    } else {
      existing.gangWallets.add(event.wallet);
      if ((event.amountSol || 0) > existing.largestBuySol) {
        existing.largestBuySol = event.amountSol || 0;
      }
      const prev = existing.gangWallets.size - 1;
      if (existing.gangWallets.size > prev) {
        console.log(`[BundleTracker] ${event.mint.slice(0, 8)}… now ${existing.gangWallets.size} gang wallets (score=${calcScore(existing)})`);
      }
    }
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
