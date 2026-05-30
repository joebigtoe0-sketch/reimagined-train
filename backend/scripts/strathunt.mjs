/**
 * Strategy hunt — proper out-of-sample grid search on the REAL backfilled data.
 *
 * The old playbook was overfit to sparse, laggy-MC labels. With accurate
 * bonding-curve market caps we re-derive the strategy from scratch and only keep
 * configs that are profitable AND robust out-of-sample.
 *
 * For each TARGET label we train the winner-score model on TRAIN (oldest 60% by
 * launch time), then on VALIDATION we grid-search:
 *   entry  : MC cap × score top-% × avoid-filter
 *   exit   : take-profit / stop-loss bracket (+ trailing variants)
 * scoring realized %/trade at 6% cost. We then gate on robustness:
 *   - n >= MIN_N           (enough trades to trust)
 *   - avg-excluding-top-3 > 0   (not one-lucky-runner)
 *   - survives 5% stop slippage
 *
 *   node scripts/strathunt.mjs --no-db --dir exports/pumpfundata-pump_fun
 */

import { loadDataset } from "./lib/dataset.mjs";

const MIN_EARLY_TRADES = 3, FEAT_MS = 60_000, BUNDLE_MS = 15_000, ENTRY_CAP_MS = 600_000;
const FEE = Number(process.env.FEE || 0.94);
const MIN_N = Number(process.env.MIN_N || 60);

const { tokens, tradesByMint, sources } = await loadDataset();
const list = [...tokens.values()].filter((t) => t.createdMs && tradesByMint.has(t.mint)).sort((a, b) => a.createdMs - b.createdMs);
const splitMs = list[Math.floor(list.length * 0.6)].createdMs;
const isTrain = (t) => t.createdMs < splitMs;
const val = list.filter((t) => !isTrain(t));
console.log(`\nsources: ${sources.join(", ")}  cost ${((1 - FEE) * 100).toFixed(0)}%  min-n ${MIN_N}`);
console.log(`tokens=${list.length}  train=${list.length - val.length}  val=${val.length}\n`);

// ── avoid-features (leakage-safe; serial pool from TRAIN only) ─────────────────
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const earlyBuyCount = new Map();
for (const t of list) { if (!isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const cut = t.createdMs + FEAT_MS; const seen = new Set();
  for (const tr of arr) { if (tr.ts > cut) break; if (tr.side === "buy" && !seen.has(tr.wallet)) { seen.add(tr.wallet); earlyBuyCount.set(tr.wallet, (earlyBuyCount.get(tr.wallet) || 0) + 1); } } }
const avoidFeat = new Map();
for (const t of val) {
  const arr = tradesByMint.get(t.mint); const eb = []; const cut15 = t.createdMs + BUNDLE_MS;
  for (const tr of arr) { if (tr.ts > cut15) break; if (tr.side === "buy") eb.push(tr); }
  let twin = 0;
  for (let i = 0; i < eb.length; i++) for (let j = 0; j < eb.length; j++) { if (i === j) continue; if (Math.abs(eb[i].ts - eb[j].ts) <= 2000) { const a = eb[i].sol, b = eb[j].sol, mx = Math.max(a, b) || 1; if (Math.abs(a - b) / mx <= 0.15) { twin++; break; } } }
  const cut60 = t.createdMs + FEAT_MS; const acts = []; const seen = new Set();
  for (const tr of arr) { if (tr.ts > cut60) break; if (tr.side === "buy" && !seen.has(tr.wallet)) { seen.add(tr.wallet); acts.push(earlyBuyCount.get(tr.wallet) || 0); } }
  avoidFeat.set(t.mint, { serialMed: median(acts), bundleSim: eb.length ? twin / eb.length : 0 });
}

// ── trade-flow model ──────────────────────────────────────────────────────────
function makeAcc() { return { buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0 }; }
function push(acc, tr) { acc.n++; acc.vol += tr.sol;
  if (tr.side === "buy") { acc.buys++; acc.net += tr.sol; acc.buyVol += tr.sol; const v = (acc.buyers.get(tr.wallet) || 0) + tr.sol; acc.buyers.set(tr.wallet, v); if (v > acc.maxBuyer) acc.maxBuyer = v; }
  else { acc.sells++; acc.net -= tr.sol; } }
function flow(acc) { const conc = acc.buyVol > 0 ? acc.maxBuyer / acc.buyVol : 1;
  return [Math.log1p(acc.buyers.size), Math.log1p(acc.vol), Math.log1p(acc.n), Math.sign(acc.net) * Math.log1p(Math.abs(acc.net)), conc, acc.sells > 0 ? Math.min(acc.buys / acc.sells, 10) : Math.min(acc.buys, 10), Math.log1p(acc.buys > 0 ? acc.buyVol / acc.buys : 0)]; }
const D = 7, sig = (v) => 1 / (1 + Math.exp(-v));
function at60(t) { const arr = tradesByMint.get(t.mint); const acc = makeAcc(); const cut = t.createdMs + FEAT_MS; for (const tr of arr) { if (tr.ts > cut) break; push(acc, tr); } return acc.n >= MIN_EARLY_TRADES ? flow(acc) : null; }

function trainModel(target) {
  const rows = [];
  for (const t of list) { if (!isTrain(t)) continue; const f = at60(t); if (!f) continue; rows.push({ x: f, y: (t.peakMc || 0) >= target ? 1 : 0 }); }
  const mean = Array(D).fill(0), std = Array(D).fill(0);
  for (const r of rows) for (let j = 0; j < D; j++) mean[j] += r.x[j]; for (let j = 0; j < D; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < D; j++) std[j] += (r.x[j] - mean[j]) ** 2; for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / rows.length) || 1;
  const z = (x) => x.map((v, j) => (v - mean[j]) / std[j]);
  const w = Array(D).fill(0); let b = 0; const pos = rows.filter((r) => r.y).length, wPos = (rows.length - pos) / Math.max(1, pos);
  for (let it = 0; it < 800; it++) { const gw = Array(D).fill(0); let gb = 0;
    for (const r of rows) { const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; const p = sig(s); const cw = r.y ? wPos : 1; const err = (p - r.y) * cw; for (let j = 0; j < D; j++) gw[j] += err * zx[j]; gb += err; }
    for (let j = 0; j < D; j++) w[j] -= 0.1 * (gw[j] / rows.length + 1e-3 * w[j]); b -= 0.1 * (gb / rows.length); }
  const score = (f) => { const zx = z(f); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); };
  const trainScores = rows.map((r) => score(r.x)).sort((a, c) => c - a);
  const thAt = (pct) => trainScores[Math.floor(rows.length * pct)] ?? 0;
  return { score, thAt, mean, std, w, b };
}

// exit over a token's trade array, from entry index ei
function bracket(arr, ei, tp, sl, slip = 0) { const e = arr[ei].mc; for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m / e >= tp) return tp; if (m / e <= sl) return Math.max(0.01, sl - slip); } return arr[arr.length - 1].mc / e; }
function trail(arr, ei, tp, sl, tr_) { const e = arr[ei].mc; let peak = e, riding = false; for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m > peak) peak = m; const mult = m / e; if (mult <= sl) return sl; if (!riding) { if (mult >= tp) riding = true; } else if (m <= peak * (1 - tr_)) return mult; } return arr[arr.length - 1].mc / e; }

// ── entry: find the trade index where score first crosses, MC≤cap, filter ok ──
function entryIndex(t, model, th, cap, filter) {
  const arr = tradesByMint.get(t.mint); const acc = makeAcc();
  for (let i = 0; i < arr.length; i++) { const tr = arr[i]; push(acc, tr);
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return -1;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0 || tr.mc > cap) continue;
    if (model.score(flow(acc)) >= th) {
      if (filter) { const a = avoidFeat.get(t.mint); if (a.serialMed >= filter.s || a.bundleSim >= filter.b) return -1; }
      return i;
    } }
  return -1;
}

// ── grid ───────────────────────────────────────────────────────────────────────
const TARGETS = [15000, 25000];
const CAPS = [8000, 12000];
const TOPPCT = [0.05, 0.1, 0.2];
const FILTERS = [
  { name: "none", f: null },
  { name: "serial3", f: { s: 3, b: 99 } },
  { name: "serial5", f: { s: 5, b: 99 } },
  { name: "bundle", f: { s: 999, b: 0.5 } },
];
const EXITS = [];
for (const tp of [1.3, 1.5, 2, 2.5, 3]) for (const sl of [0.8, 0.85, 0.9]) EXITS.push({ name: `TP${tp}/SL${sl}`, fn: (a, e, slip) => bracket(a, e, tp, sl, slip), tp, sl });
EXITS.push({ name: "TP2/SL0.9/tr30", fn: (a, e) => trail(a, e, 2, 0.9, 0.3) });
EXITS.push({ name: "TP1.5/SL0.9/tr40", fn: (a, e) => trail(a, e, 1.5, 0.9, 0.4) });

const results = [];
for (const target of TARGETS) {
  const model = trainModel(target);
  for (const cap of CAPS) for (const pct of TOPPCT) {
    const th = model.thAt(pct);
    for (const flt of FILTERS) {
      // entries for this (target,cap,pct,filter) — independent of exit
      const entries = [];
      for (const t of val) { const ei = entryIndex(t, model, th, cap, flt.f); if (ei >= 0) entries.push({ arr: tradesByMint.get(t.mint), ei }); }
      if (entries.length < MIN_N) continue;
      for (const ex of EXITS) {
        const rets = entries.map((e) => ex.fn(e.arr, e.ei, 0) * FEE - 1);
        const n = rets.length, avg = rets.reduce((s, x) => s + x, 0) / n, wins = rets.filter((x) => x > 0).length / n;
        const sorted = rets.slice().sort((a, b) => b - a);
        const exTop3 = sorted.slice(3).reduce((s, x) => s + x, 0) / Math.max(1, n - 3);
        // 5% stop slippage stress (bracket exits only; trailing ~ unaffected)
        const slipRets = ex.tp ? entries.map((e) => ex.fn(e.arr, e.ei, 0.05) * FEE - 1) : rets;
        const slipAvg = slipRets.reduce((s, x) => s + x, 0) / n;
        results.push({ target, cap, pct, filter: flt.name, exit: ex.name, n, win: wins, avg, exTop3, slipAvg });
      }
    }
  }
}

const fmt = (x) => (x * 100).toFixed(1).padStart(6) + "%";
results.sort((a, b) => b.avg - a.avg);
console.log(`══ TOP 20 BY OUT-OF-SAMPLE avg %/trade  (n≥${MIN_N}) ══════════════════════════`);
console.log(`  target cap    top   filter   exit              n    win    avg    exTop3  slip5`);
for (const r of results.slice(0, 20)) {
  console.log(`  ${String(r.target/1000)+"k"} $${String(r.cap/1000)+"k"}  ${(r.pct*100)+"%"}  ${r.filter.padEnd(8)} ${r.exit.padEnd(17)} ${String(r.n).padStart(4)}  ${(r.win*100).toFixed(0).padStart(3)}%  ${fmt(r.avg)}  ${fmt(r.exTop3)}  ${fmt(r.slipAvg)}`);
}

const robust = results.filter((r) => r.avg > 0 && r.exTop3 > 0 && r.slipAvg > 0).sort((a, b) => b.exTop3 - a.exTop3);
console.log(`\n══ MOST ROBUST (avg>0 AND avg-excl-top3>0 AND survives 5% slip), ranked by exTop3 ══`);
if (robust.length === 0) console.log("  (none — no config is profitable after removing the top-3 runners)");
for (const r of robust.slice(0, 12)) {
  console.log(`  ${String(r.target/1000)+"k"} $${String(r.cap/1000)+"k"}  ${(r.pct*100)+"%"}  ${r.filter.padEnd(8)} ${r.exit.padEnd(17)} ${String(r.n).padStart(4)}  ${(r.win*100).toFixed(0).padStart(3)}%  ${fmt(r.avg)}  ${fmt(r.exTop3)}  ${fmt(r.slipAvg)}`);
}
console.log("");

// ── LOCK-IN: print constants for the chosen live config ───────────────────────
const LOCK_TARGET = Number(process.env.LOCK_TARGET || 25000), LOCK_PCT = Number(process.env.LOCK_PCT || 0.2);
const lock = trainModel(LOCK_TARGET); const lockTh = lock.thAt(LOCK_PCT);
console.log(`══ LOCK-IN CONSTANTS (target ${LOCK_TARGET/1000}k, top-${LOCK_PCT*100}% , serial3, exit bank-2x/trail30/SL0.9) ══`);
console.log(`MEAN = [${lock.mean.map((x) => x.toFixed(6)).join(", ")}]`);
console.log(`STD  = [${lock.std.map((x) => x.toFixed(6)).join(", ")}]`);
console.log(`W    = [${lock.w.map((x) => x.toFixed(6)).join(", ")}]`);
console.log(`B    = ${lock.b.toFixed(6)}`);
console.log(`TH   = ${lockTh.toFixed(6)}`);
console.log(`Feature order: [logUniqueBuyers, logVol, logTrades, signedLogNet, concentration, buySell, logAvgBuy]\n`);
