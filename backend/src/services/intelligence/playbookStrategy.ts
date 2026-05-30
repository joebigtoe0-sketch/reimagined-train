import type { CanonicalEvent, TokenState } from "../../types.js";

/**
 * Playbook strategy — re-derived on the REAL backfilled dataset (220k tokens /
 * 14.8M trades) and validated out-of-sample on 81k tokens (scripts/strathunt.mjs,
 * model target = peak MC ≥ $25k):
 *
 *   ENTRY  : while a coin is still cheap (MC ≤ $12k) and within 10 min of launch,
 *            BUY the first moment the winner-score crosses the top-20% threshold,
 *            UNLESS the coin is serial-sprayed (median early buyer has sprayed
 *            ≥3 launches). The bundle filter was dropped — it was noise.
 *   EXIT   : bank at 2×, then trail 30% off the peak; hard stop at −10%
 *            (handled by the paper bot). +16.7%/trade OOS, +15.3% excl. top-3.
 *
 * The winner-score is a logistic model over 7 leakage-free, live-computable
 * early-window features. Constants were fit on TRAIN data and printed by
 * scripts/strathunt.mjs — DO NOT hand-edit; re-run that script to refresh them.
 */

// ── embedded model (from scripts/strathunt.mjs, target 25k, 7 features) ───────
const MEAN = [2.169528, 2.162350, 3.182991, 0.515254, 0.511217, 1.582736, 0.370023];
const STD = [1.008290, 1.319759, 1.123969, 0.862261, 0.271999, 1.375810, 0.321195];
const W = [-1.405720, 0.614847, 1.748346, 1.328486, 0.889240, 0.192148, -0.334048];
const B = -1.394214;
const TH = 0.497508; // top-20% entry threshold

// ── strategy params (validated) ───────────────────────────────────────────────
const ENTRY_MC_CAP = 12_000;     // only buy while still cheap
const ENTRY_CAP_MS = 600_000;    // don't open after 10 min
const FEAT_MS = 60_000;          // window that defines an "early buyer" (serial count)
const MIN_EARLY_TRADES = 3;
const AVOID_SERIAL_MED = 3;      // skip if median early-buyer has sprayed ≥3 launches

interface EarlyStats {
  createdMs: number;
  buyers: Map<string, number>; // wallet -> cumulative buy SOL
  n: number;
  buys: number;
  sells: number;
  net: number;
  vol: number;
  buyVol: number;
  maxBuyer: number;
  earlySeen: Set<string>; // distinct first-60s buyers (for serial counting)
  decided: boolean; // entry decision already made (bought or skipped)
}

const sigmoid = (v: number): number => 1 / (1 + Math.exp(-v));
const median = (a: number[]): number => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

export class PlaybookStrategy {
  private readonly stats = new Map<string, EarlyStats>();
  // wallet -> # distinct tokens it bought within their first 60s (serial-spray
  // signal). Accumulates live; cold at first, warms up over the forward test.
  private readonly serialCount = new Map<string, number>();

  /** Update a token's early-window state from a real trade and maybe fire BUY. */
  observe(token: TokenState, event: CanonicalEvent): void {
    if (event.type !== "trade") return;
    const createdMs = Date.parse(token.createdAt) || Date.now();
    let st = this.stats.get(token.mint);
    if (!st) {
      st = { createdMs, buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0, earlySeen: new Set(), decided: false };
      this.stats.set(token.mint, st);
    }
    const ts = Date.parse(event.timestamp) || Date.now();
    const sol = event.amountSol || 0;
    st.n += 1;
    st.vol += sol;
    if (event.side === "buy") {
      st.buys += 1; st.net += sol; st.buyVol += sol;
      const v = (st.buyers.get(event.wallet) || 0) + sol;
      st.buyers.set(event.wallet, v);
      if (v > st.maxBuyer) st.maxBuyer = v;
      if (ts <= createdMs + FEAT_MS && !st.earlySeen.has(event.wallet)) {
        st.earlySeen.add(event.wallet);
        this.serialCount.set(event.wallet, (this.serialCount.get(event.wallet) || 0) + 1);
      }
    } else {
      st.sells += 1; st.net -= sol;
    }

    token.playbookScore = this.score(st);
    if (st.decided || !this.enabled) return;
    if (event.marketCap <= 0 || event.marketCap > ENTRY_MC_CAP) return;
    if (ts - createdMs > ENTRY_CAP_MS) { st.decided = true; return; }
    if (st.n < MIN_EARLY_TRADES) return;
    if ((token.playbookScore ?? 0) < TH) return;
    // score crossed the bar — decide once: buy unless serial-sprayed
    st.decided = true;
    if (this.serialMed(st) >= AVOID_SERIAL_MED) return;
    token.playbookBuy = true;
    token.playbookEntryMc = event.marketCap;
  }

  /** Free a token's accumulator once it's dead (bounds memory). */
  forget(mint: string): void { this.stats.delete(mint); }

  // toggled on with the paper bot so we don't accumulate decisions while paused
  private enabled = true;
  setEnabled(on: boolean): void { this.enabled = on; }

  private score(st: EarlyStats): number {
    const conc = st.buyVol > 0 ? st.maxBuyer / st.buyVol : 1;
    const x = [
      Math.log1p(st.buyers.size),
      Math.log1p(st.vol),
      Math.log1p(st.n),
      Math.sign(st.net) * Math.log1p(Math.abs(st.net)),
      conc,
      st.sells > 0 ? Math.min(st.buys / st.sells, 10) : Math.min(st.buys, 10),
      Math.log1p(st.buys > 0 ? st.buyVol / st.buys : 0)
    ];
    let s = B;
    for (let j = 0; j < x.length; j++) s += W[j] * ((x[j] - MEAN[j]) / STD[j]);
    return sigmoid(s);
  }

  private serialMed(st: EarlyStats): number {
    const acts = [...st.earlySeen].map((w) => this.serialCount.get(w) || 0);
    return median(acts);
  }
}
