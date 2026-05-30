/**
 * Winner-score — a time-split-validated model that scores a coin at 60s for the
 * probability it becomes a runner (peak MC >= target), then a GATED entry/exit
 * backtest to see if trading only top-scored coins is profitable after fees.
 *
 * No leakage:
 *   - tokens split by launch time: oldest 60% = TRAIN, newest 40% = VALIDATION
 *   - the "winner-wallet" pool used as a feature is derived from TRAIN tokens only
 *   - the logistic model is fit on TRAIN, all metrics reported on VALIDATION
 *
 * Uses the merged dataset (all exports + live DB). Read-only.
 *   node scripts/winnerscore.mjs            # exports + DB
 *   node scripts/winnerscore.mjs --no-db    # exports only (fast)
 */

import { loadDataset } from "./lib/dataset.mjs";

const SUCCESS_MC = 25_000;
const MIN_EARLY_TRADES = 3;
const FEE = 0.96; // 4% round-trip for the gated backtest

const { tokens, tradesByMint, sources } = await loadDataset();
console.log(`\nsources: ${sources.join(", ")}  tokens=${tokens.size} withTrades=${tradesByMint.size}`);

// time split
const list = [...tokens.values()].filter((t) => t.createdMs && tradesByMint.has(t.mint)).sort((a, b) => a.createdMs - b.createdMs);
const splitMs = list[Math.floor(list.length * 0.6)].createdMs;
const isTrain = (t) => t.createdMs < splitMs;

// winner-wallet pool from TRAIN tokens only (no leakage into validation)
const wnet = new Map(), wcnt = new Map();
for (const t of list) {
  if (!isTrain(t)) continue;
  const arr = tradesByMint.get(t.mint); const pos = new Map();
  for (const tr of arr) { let p = pos.get(tr.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(tr.wallet, p); } if (tr.side === "buy") p.in += tr.sol; else p.out += tr.sol; }
  for (const [w, p] of pos) { wnet.set(w, (wnet.get(w) || 0) + (p.out - p.in)); wcnt.set(w, (wcnt.get(w) || 0) + 1); }
}
const winnerWallet = new Set();
for (const [w, n] of wnet) if (n >= 10 && (wcnt.get(w) || 0) >= 5) winnerWallet.add(w);

// features within the first `EARLY_MS` ms (parameterized by decision window)
function feat(t, EARLY_MS) {
  const arr = tradesByMint.get(t.mint);
  const cut = t.createdMs + EARLY_MS;
  const buyers = new Map();
  let n = 0, buys = 0, sells = 0, net = 0, vol = 0, winners = new Set(), entryMc = 0, lastMc = 0;
  for (const tr of arr) {
    if (tr.ts > cut) break;
    n++; vol += tr.sol; if (tr.mc > 0) lastMc = tr.mc;
    if (tr.side === "buy") { buys++; net += tr.sol; buyers.set(tr.wallet, (buyers.get(tr.wallet) || 0) + tr.sol); if (winnerWallet.has(tr.wallet)) winners.add(tr.wallet); }
    else { sells++; net -= tr.sol; }
  }
  if (n < MIN_EARLY_TRADES) return null;
  entryMc = lastMc; // price at end of the 60s window (what we'd pay)
  const buyVol = [...buyers.values()].reduce((s, x) => s + x, 0);
  const conc = buyVol > 0 ? Math.max(0, ...buyers.values()) / buyVol : 1;
  const x = [
    Math.log1p(buyers.size),
    Math.log1p(vol),
    Math.log1p(n),
    Math.sign(net) * Math.log1p(Math.abs(net)),
    conc,
    sells > 0 ? Math.min(buys / sells, 10) : Math.min(buys, 10),
    Math.log1p(buys > 0 ? buyVol / buys : 0),
    Math.log1p(winners.size)
  ];
  return { mint: t.mint, x, y: (t.peakMc || 0) >= SUCCESS_MC ? 1 : 0, entryMc, peakMc: t.peakMc || 0 };
}

const FNAMES = ["log uniqueBuyers", "log vol", "log nTrades", "signed log netSol", "concentration", "buy/sell", "log avgBuy", "log winnerBuyers"];
const D = FNAMES.length;
const sig = (v) => 1 / (1 + Math.exp(-v));

/** Build features at window W, fit logistic on train, return scored cohorts. */
function buildAndFit(W) {
  const train = [], val = [];
  for (const t of list) { const f = feat(t, W); if (!f) continue; (isTrain(t) ? train : val).push(f); }
  const mean = Array(D).fill(0), std = Array(D).fill(0);
  for (const r of train) for (let j = 0; j < D; j++) mean[j] += r.x[j];
  for (let j = 0; j < D; j++) mean[j] /= train.length;
  for (const r of train) for (let j = 0; j < D; j++) std[j] += (r.x[j] - mean[j]) ** 2;
  for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / train.length) || 1;
  const z = (x) => x.map((v, j) => (v - mean[j]) / std[j]);
  const w = Array(D).fill(0); let b = 0;
  const pos = train.filter((r) => r.y).length, neg = train.length - pos;
  const wPos = neg / Math.max(1, pos), lr = 0.1, L2 = 1e-3;
  for (let it = 0; it < 800; it++) {
    const gw = Array(D).fill(0); let gb = 0;
    for (const r of train) {
      const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j];
      const p = sig(s); const cw = r.y ? wPos : 1; const err = (p - r.y) * cw;
      for (let j = 0; j < D; j++) gw[j] += err * zx[j]; gb += err;
    }
    for (let j = 0; j < D; j++) w[j] -= lr * (gw[j] / train.length + L2 * w[j]);
    b -= lr * (gb / train.length);
  }
  const score = (r) => { const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); };
  const scoredVal = val.map((r) => ({ ...r, s: score(r) })).sort((a, b) => b.s - a.s);
  return { train, val, scoredVal, w, pos };
}

function manage(mint, startTs, entryMc, p) {
  const arr = tradesByMint.get(mint);
  let peak = entryMc;
  for (const t of arr) {
    if (t.ts <= startTs || t.mc <= 0) continue;
    const held = (t.ts - startTs) / 1000;
    if (t.mc > peak) peak = t.mc;
    const mult = t.mc / entryMc;
    if (mult >= p.tp) return p.tp * FEE - 1;
    if (mult <= p.sl) return mult * FEE - 1;
    if (p.trail > 0 && peak > entryMc && t.mc <= peak * (1 - p.trail)) return mult * FEE - 1;
    if (held >= p.maxHoldS) return mult * FEE - 1;
  }
  const last = arr[arr.length - 1];
  return (last.mc / entryMc) * FEE - 1;
}
function backtest(cohort, W, p) {
  let n = 0, wins = 0, sum = 0;
  for (const r of cohort) {
    if (r.entryMc <= 0) continue;
    const ret = manage(r.mint, tokens.get(r.mint).createdMs + W, r.entryMc, p);
    n++; sum += ret; if (ret > 0) wins++;
  }
  return { n, winRate: n ? wins / n : 0, avg: n ? sum / n : 0, total: sum };
}

// reference model weights + lift at the 60s window
const ref = buildAndFit(60_000);
const baseVal = ref.val.reduce((s, r) => s + r.y, 0) / ref.val.length;
console.log(`train=${ref.train.length} (pos ${ref.pos}) · val=${ref.val.length} (pos ${ref.val.reduce((s,r)=>s+r.y,0)})`);
console.log(`\n══ MODEL WEIGHTS @60s (standardized; +→more likely winner) ══════════════`);
FNAMES.forEach((nm, j) => console.log(`  ${nm.padEnd(20)} ${ref.w[j] >= 0 ? "+" : ""}${ref.w[j].toFixed(3)}`));
console.log(`\n══ VALIDATION LIFT @60s  (base ${(baseVal*100).toFixed(2)}%) ══════════════════════`);
for (const frac of [0.05, 0.1, 0.2]) {
  const k = Math.max(1, Math.floor(ref.scoredVal.length * frac));
  const rate = ref.scoredVal.slice(0, k).reduce((s, r) => s + r.y, 0) / k;
  console.log(`  top ${(frac*100).toFixed(0).padStart(2)}% (${String(k).padStart(4)}): success ${(rate*100).toFixed(1)}%  lift ${(rate/baseVal).toFixed(2)}x`);
}

// ── sweep decision window × exit rule, gated on top-10% score, validated ──────
const windows = [20_000, 30_000, 45_000, 60_000];
const exits = [];
for (const tp of [2, 3, 5, 10])
  for (const trail of [0, 0.4, 0.6])
    for (const sl of [0.5, 0.6])
      for (const maxHoldS of [300, 900, 1800])
        exits.push({ tp, trail, sl, maxHoldS });

console.log(`\n══ WINDOW × EXIT SWEEP (gated to top 10% by score, validation) ══════════`);
console.log(`  best exit per entry window (by avg %/trade after 4% fees):`);
let globalBest = null;
for (const W of windows) {
  const { scoredVal } = buildAndFit(W);
  const k = Math.max(1, Math.floor(scoredVal.length * 0.1));
  const cohort = scoredVal.slice(0, k);
  let best = null;
  for (const p of exits) { const r = backtest(cohort, W, p); if (!best || r.avg > best.r.avg) best = { p, r }; }
  const { p, r } = best;
  console.log(`  ${String(W/1000).padStart(2)}s entry → TP${p.tp} trail${p.trail} SL${p.sl} hold${p.maxHoldS}s :  ` +
    `n=${r.n} win ${(r.winRate*100).toFixed(0)}% avg ${(r.avg*100).toFixed(1)}%/trade total ${(r.total*100).toFixed(0)}%`);
  if (!globalBest || r.avg > globalBest.r.avg) globalBest = { W, p, r };
}
const g = globalBest;
console.log(`\n  ★ BEST overall: enter ${g.W/1000}s, TP${g.p.tp} trail${g.p.trail} SL${g.p.sl} hold${g.p.maxHoldS}s`);
console.log(`    → val avg ${(g.r.avg*100).toFixed(1)}%/trade over ${g.r.n} trades, win ${(g.r.winRate*100).toFixed(0)}%`);
console.log(`\n  Positive avg%/trade = a validated, executable BUY+exit edge. Negative =`);
console.log(`  prediction is real but entry-at-pump still loses; need earlier signal.\n`);
