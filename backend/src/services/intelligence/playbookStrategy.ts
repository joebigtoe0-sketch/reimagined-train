import type { CanonicalEvent, TokenState } from "../../types.js";

/**
 * Playbook strategy — the only configuration that survived out-of-sample +
 * slippage stress (scripts/playbook.mjs, target = peak MC ≥ $15k):
 *
 *   ENTRY  : while a coin is still cheap (MC ≤ $12k) and within 10 min of launch,
 *            BUY the first moment the winner-score crosses the top-5% threshold,
 *            UNLESS the coin looks bundled or serial-sprayed (avoid filters).
 *   EXIT   : take profit at 3×, hard stop at −10%  (handled by the paper bot).
 *
 * The winner-score is a logistic model over 7 leakage-free, live-computable
 * early-window features. Constants were fit on TRAIN data and printed by
 * scripts/playbook.mjs — DO NOT hand-edit; re-run that script to refresh them.
 */

// ── embedded model (from scripts/playbook.mjs, 7 features) ────────────────────
const MEAN = [1.923439, 2.142338, 3.139656, -0.528255, 0.561229, 1.164856, 0.253601];
const STD = [1.240283, 1.286111, 1.191042, 1.412137, 0.329365, 1.374178, 0.222948];
const W = [1.200789, 1.354491, -1.117589, 0.559646, -0.294459, 0.326764, 0.275421];
const B = -2.403345;
const TH = 0.856351; // top-5% entry threshold

// ── strategy params (validated) ───────────────────────────────────────────────
const ENTRY_MC_CAP = 12_000;     // only buy while still cheap
const ENTRY_CAP_MS = 600_000;    // don't open after 10 min
const BUNDLE_MS = 15_000;        // window for bundle fingerprint
const FEAT_MS = 60_000;          // window that defines an "early buyer" (serial count)
const MIN_EARLY_TRADES = 3;
const BUNDLE_TWIN_MS = 2_000;    // near-simultaneous
const BUNDLE_SIZE_TOL = 0.15;    // similar size
const AVOID_BUNDLE_FRAC = 0.5;   // skip if ≥50% of early buys are bundled
const AVOID_SERIAL_MED = 5;      // skip if median early-buyer has sprayed ≥5 launches

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
  bundleBuys: Array<{ ts: number; sol: number }>; // first-15s buys
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
      st = { createdMs, buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0, bundleBuys: [], earlySeen: new Set(), decided: false };
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
      if (ts <= createdMs + BUNDLE_MS) st.bundleBuys.push({ ts, sol });
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
    // score crossed the bar — decide once: buy unless bundled / serial-sprayed
    st.decided = true;
    if (this.bundleFrac(st) >= AVOID_BUNDLE_FRAC) return;
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

  private bundleFrac(st: EarlyStats): number {
    const eb = st.bundleBuys;
    if (eb.length === 0) return 0;
    let twin = 0;
    for (let i = 0; i < eb.length; i++) {
      for (let j = 0; j < eb.length; j++) {
        if (i === j) continue;
        if (Math.abs(eb[i].ts - eb[j].ts) <= BUNDLE_TWIN_MS) {
          const a = eb[i].sol, b = eb[j].sol, mx = Math.max(a, b) || 1;
          if (Math.abs(a - b) / mx <= BUNDLE_SIZE_TOL) { twin++; break; }
        }
      }
    }
    return twin / eb.length;
  }

  private serialMed(st: EarlyStats): number {
    const acts = [...st.earlySeen].map((w) => this.serialCount.get(w) || 0);
    return median(acts);
  }
}
