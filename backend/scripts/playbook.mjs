/**
 * Playbook — built around the user's framing:
 *   ENTRY: catch coins still under $15k that will CROSS $15k.
 *   FILTER: avoid serial-buyer-sprayed & bundled coins (validated negatives).
 *   EXIT: bank most at a take-profit, but HOLD the ones still clearly running
 *         (continuation signal), exit when momentum breaks (crash signal).
 *
 * Target = peak MC >= $15k (≈171 winners, vs 69 at $25k) → more positives to learn.
 * Time-split: model/pool/history from TRAIN (oldest 60%), results on VALIDATION.
 *   node scripts/playbook.mjs            # tries live DB too
 *   node scripts/playbook.mjs --no-db    # exports only (fast)
 */

import { loadDataset } from "./lib/dataset.mjs";

const TARGET_MC = 15_000, MIN_EARLY_TRADES = 3, FEAT_MS = 60_000, BUNDLE_MS = 15_000, ENTRY_CAP_MS = 600_000;
const ENTRY_MC_CAP = 12_000;            // only buy while still cheap (under target)
const FEE = Number(process.env.FEE || 0.94);

const { tokens, tradesByMint, sources } = await loadDataset();
console.log(`\nsources: ${sources.join(", ")}  cost ${((1-FEE)*100).toFixed(0)}%  target $${TARGET_MC/1000}k`);
const list = [...tokens.values()].filter((t) => t.createdMs && tradesByMint.has(t.mint)).sort((a, b) => a.createdMs - b.createdMs);
const splitMs = list[Math.floor(list.length * 0.6)].createdMs;
const isTrain = (t) => t.createdMs < splitMs;
const isWin = (t) => (t.peakMc || 0) >= TARGET_MC;

const tiers = { ">=10k": 0, ">=15k": 0, ">=25k": 0, ">=50k": 0 };
for (const t of list) { const p = t.peakMc || 0; if (p >= 10000) tiers[">=10k"]++; if (p >= 15000) tiers[">=15k"]++; if (p >= 25000) tiers[">=25k"]++; if (p >= 50000) tiers[">=50k"]++; }
const trainWins = list.filter((t) => isTrain(t) && isWin(t)).length, valWins = list.filter((t) => !isTrain(t) && isWin(t)).length;
console.log(`tokens=${list.length}  peak tiers: ${Object.entries(tiers).map(([k,v])=>`${k}=${v}`).join("  ")}`);
console.log(`winners @${TARGET_MC/1000}k: train ${trainWins} / val ${valWins}\n`);

// ── orthogonal precompute (leakage-safe) ──────────────────────────────────────
const earlyBuyCount = new Map();
for (const t of list) { if (!isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const cut = t.createdMs + FEAT_MS; const seen = new Set();
  for (const tr of arr) { if (tr.ts > cut) break; if (tr.side === "buy" && !seen.has(tr.wallet)) { seen.add(tr.wallet); earlyBuyCount.set(tr.wallet, (earlyBuyCount.get(tr.wallet) || 0) + 1); } } }
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const avoidFeat = new Map(); // mint -> {serialMed, bundleSim}
for (const t of list) {
  const arr = tradesByMint.get(t.mint);
  const eb = []; const cut15 = t.createdMs + BUNDLE_MS;
  for (const tr of arr) { if (tr.ts > cut15) break; if (tr.side === "buy") eb.push(tr); }
  let twin = 0;
  for (let i = 0; i < eb.length; i++) for (let j = 0; j < eb.length; j++) { if (i === j) continue; if (Math.abs(eb[i].ts - eb[j].ts) <= 2000) { const a = eb[i].sol, b = eb[j].sol, mx = Math.max(a, b) || 1; if (Math.abs(a - b) / mx <= 0.15) { twin++; break; } } }
  const cut60 = t.createdMs + FEAT_MS; const acts = []; const seen = new Set();
  for (const tr of arr) { if (tr.ts > cut60) break; if (tr.side === "buy" && !seen.has(tr.wallet)) { seen.add(tr.wallet); acts.push(earlyBuyCount.get(tr.wallet) || 0); } }
  avoidFeat.set(t.mint, { serialMed: median(acts), bundleSim: eb.length ? twin / eb.length : 0 });
}

// ── trade-flow model (the 8 features that worked) ─────────────────────────────
function makeAcc() { return { buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0 }; }
function push(acc, tr) { acc.n++; acc.vol += tr.sol;
  if (tr.side === "buy") { acc.buys++; acc.net += tr.sol; acc.buyVol += tr.sol; const v = (acc.buyers.get(tr.wallet) || 0) + tr.sol; acc.buyers.set(tr.wallet, v); if (v > acc.maxBuyer) acc.maxBuyer = v; }
  else { acc.sells++; acc.net -= tr.sol; } }
function flow(acc) { const conc = acc.buyVol > 0 ? acc.maxBuyer / acc.buyVol : 1;
  return [Math.log1p(acc.buyers.size), Math.log1p(acc.vol), Math.log1p(acc.n), Math.sign(acc.net) * Math.log1p(Math.abs(acc.net)), conc, acc.sells > 0 ? Math.min(acc.buys / acc.sells, 10) : Math.min(acc.buys, 10), Math.log1p(acc.buys > 0 ? acc.buyVol / acc.buys : 0)]; }
const D = 7, sig = (v) => 1 / (1 + Math.exp(-v));
function at60(t) { const arr = tradesByMint.get(t.mint); const acc = makeAcc(); const cut = t.createdMs + FEAT_MS; for (const tr of arr) { if (tr.ts > cut) break; push(acc, tr); } return acc.n >= MIN_EARLY_TRADES ? flow(acc) : null; }

const rows = [];
for (const t of list) { if (!isTrain(t)) continue; const f = at60(t); if (!f) continue; rows.push({ x: f, y: isWin(t) ? 1 : 0 }); }
const mean = Array(D).fill(0), std = Array(D).fill(0);
for (const r of rows) for (let j = 0; j < D; j++) mean[j] += r.x[j]; for (let j = 0; j < D; j++) mean[j] /= rows.length;
for (const r of rows) for (let j = 0; j < D; j++) std[j] += (r.x[j] - mean[j]) ** 2; for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / rows.length) || 1;
const z = (x) => x.map((v, j) => (v - mean[j]) / std[j]);
const w = Array(D).fill(0); let b = 0; const pos = rows.filter((r) => r.y).length, wPos = (rows.length - pos) / Math.max(1, pos);
for (let it = 0; it < 1000; it++) { const gw = Array(D).fill(0); let gb = 0;
  for (const r of rows) { const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; const p = sig(s); const cw = r.y ? wPos : 1; const err = (p - r.y) * cw; for (let j = 0; j < D; j++) gw[j] += err * zx[j]; gb += err; }
  for (let j = 0; j < D; j++) w[j] -= 0.1 * (gw[j] / rows.length + 1e-3 * w[j]); b -= 0.1 * (gb / rows.length); }
const score = (f) => { const zx = z(f); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); };
const th5 = rows.map((r) => score(r.x)).sort((a, c) => c - a)[Math.floor(rows.length * 0.05)];

// ── EMBED CONSTANTS (paste into backend playbookStrategy.ts) ──────────────────
console.log(`\n══ MODEL CONSTANTS TO EMBED (7 features) ════════════════════════════════`);
console.log(`MEAN = [${mean.map((x) => x.toFixed(6)).join(", ")}]`);
console.log(`STD  = [${std.map((x) => x.toFixed(6)).join(", ")}]`);
console.log(`W    = [${w.map((x) => x.toFixed(6)).join(", ")}]`);
console.log(`B    = ${b.toFixed(6)}`);
console.log(`TH   = ${th5.toFixed(6)}   (top-5% entry threshold)`);
console.log(`Feature order: [logUniqueBuyers, logVol, logTrades, signedLogNet, concentration, buySell, logAvgBuy]`);
console.log(`Filters: ENTRY_MC_CAP=$${ENTRY_MC_CAP}, avoid serialMed>=5, avoid bundleSim>=0.5; exit TP3x/SL0.9\n`);

// ── entry scan ────────────────────────────────────────────────────────────────
function findEntry(t, filter) { const arr = tradesByMint.get(t.mint); const acc = makeAcc();
  for (let i = 0; i < arr.length; i++) { const tr = arr[i]; push(acc, tr);
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return -1;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0 || tr.mc > ENTRY_MC_CAP) continue;
    if (score(flow(acc)) >= th5) {
      if (filter) { const a = avoidFeat.get(t.mint); if (a.serialMed >= filter.serialMax || a.bundleSim >= filter.bundleMax) return -1; }
      return i;
    } }
  return -1; }

// exits
function bracket(arr, ei, tp, sl) { const e = arr[ei].mc; for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m / e >= tp) return tp; if (m / e <= sl) return sl; } return arr[arr.length - 1].mc / e; }
/** Dynamic: bank at TP UNLESS still running (recent net>0 & new highs); then trail. */
function dynamic(arr, ei, tp, sl, trail, winMs) {
  const e = arr[ei].mc; let peak = e, riding = false, recent = [];
  for (let i = ei + 1; i < arr.length; i++) { const tr = arr[i]; if (tr.mc <= 0) continue;
    if (tr.mc > peak) peak = tr.mc;
    recent.push({ ts: tr.ts, s: tr.side === "buy" ? tr.sol : -tr.sol }); while (recent.length && recent[0].ts < tr.ts - winMs) recent.shift();
    const net = recent.reduce((s, x) => s + x.s, 0);
    const mult = tr.mc / e;
    if (mult <= sl) return mult;
    if (!riding) {
      if (mult >= tp) { if (net > 0) riding = true; else return tp; } // continuation → ride, else bank
    } else {
      if (tr.mc <= peak * (1 - trail)) return mult; // trail the runner
    }
  }
  return arr[arr.length - 1].mc / e;
}
function evalExit(filter, fn) { const rets = [];
  for (const t of list) { if (isTrain(t)) continue; const ei = findEntry(t, filter); if (ei < 0) continue; rets.push(fn(tradesByMint.get(t.mint), ei) * FEE - 1); }
  const wins = rets.filter((x) => x > 0).length; return { n: rets.length, win: rets.length ? wins / rets.length : 0, avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0 }; }

// validation lift at 15k target
const valRows = [];
for (const t of list) { if (isTrain(t)) continue; const f = at60(t); if (!f) continue; valRows.push({ s: score(f), y: isWin(t) ? 1 : 0 }); }
const baseRate = valRows.reduce((s, r) => s + r.y, 0) / valRows.length; valRows.sort((a, b) => b.s - a.s);
const top5 = valRows.slice(0, Math.floor(valRows.length * 0.05));
console.log(`══ ENTRY MODEL @$${TARGET_MC/1000}k  (val base ${(baseRate*100).toFixed(1)}%) ════════════════`);
console.log(`  top-5% score success: ${(top5.reduce((s,r)=>s+r.y,0)/top5.length*100).toFixed(1)}%  (${(top5.reduce((s,r)=>s+r.y,0)/top5.length/baseRate).toFixed(1)}x lift)\n`);

console.log(`══ AVOID-FILTER TEST  (entry top-5% & MC≤$${ENTRY_MC_CAP/1000}k, bracket TP2.5/SL0.85) ══`);
const exitB = (arr, ei) => bracket(arr, ei, 2.5, 0.85);
const noFilter = evalExit(null, exitB);
const sF = evalExit({ serialMax: 5, bundleMax: 99 }, exitB);
const bF = evalExit({ serialMax: 999, bundleMax: 0.5 }, exitB);
const both = evalExit({ serialMax: 5, bundleMax: 0.5 }, exitB);
console.log(`  no filter            : avg ${(noFilter.avg*100).toFixed(1)}%/t  win ${(noFilter.win*100).toFixed(0)}%  n=${noFilter.n}`);
console.log(`  avoid serial(≥5)     : avg ${(sF.avg*100).toFixed(1)}%/t  win ${(sF.win*100).toFixed(0)}%  n=${sF.n}`);
console.log(`  avoid bundle(≥0.5)   : avg ${(bF.avg*100).toFixed(1)}%/t  win ${(bF.win*100).toFixed(0)}%  n=${bF.n}`);
console.log(`  avoid both           : avg ${(both.avg*100).toFixed(1)}%/t  win ${(both.win*100).toFixed(0)}%  n=${both.n}\n`);

console.log(`══ EXIT: STATIC bracket vs DYNAMIC (bank-or-ride)  (avoid-both filter) ═══`);
const filt = { serialMax: 5, bundleMax: 0.5 };
let bb = null;
for (const tp of [1.5, 2, 2.5, 3]) for (const sl of [0.8, 0.85, 0.9]) { const r = evalExit(filt, (a, e) => bracket(a, e, tp, sl)); if (r.n >= 20 && (!bb || r.avg > bb.r.avg)) bb = { tp, sl, r }; }
console.log(`  STATIC  best: TP${bb.tp}/SL${bb.sl} → avg ${(bb.r.avg*100).toFixed(1)}%/t  win ${(bb.r.win*100).toFixed(0)}%  n=${bb.r.n}`);
let dd = null;
for (const tp of [1.5, 2, 2.5]) for (const sl of [0.8, 0.85, 0.9]) for (const trail of [0.3, 0.4]) { const r = evalExit(filt, (a, e) => dynamic(a, e, tp, sl, trail, 20000)); if (r.n >= 20 && (!dd || r.avg > dd.r.avg)) dd = { tp, sl, trail, r }; }
console.log(`  DYNAMIC best: TP${dd.tp}/SL${dd.sl}/trail${dd.trail*100}% → avg ${(dd.r.avg*100).toFixed(1)}%/t  win ${(dd.r.win*100).toFixed(0)}%  n=${dd.r.n}`);
console.log(`\n  Higher avg%/trade = better. Dynamic should win IF riding the few big runners`);
console.log(`  beats banking everything at TP. Both at ${((1-FEE)*100).toFixed(0)}% cost, out-of-sample.\n`);

// ── ROBUSTNESS of the winning config: slippage + outlier concentration ────────
function bracketSlip(arr, ei, tp, sl, slip) { const e = arr[ei].mc; for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m / e >= tp) return tp; if (m / e <= sl) return Math.max(0.01, sl - slip); } return arr[arr.length - 1].mc / e; }
function retsFor(filter, tp, sl, slip) { const rets = []; for (const t of list) { if (isTrain(t)) continue; const ei = findEntry(t, filter); if (ei < 0) continue; rets.push(bracketSlip(tradesByMint.get(t.mint), ei, tp, sl, slip) * FEE - 1); } return rets; }
const TP = bb.tp, SL = bb.sl;
console.log(`══ ROBUSTNESS  (avoid-both, TP${TP}/SL${SL}) ════════════════════════════════`);
for (const slip of [0, 0.03, 0.05, 0.08]) { const r = retsFor(filt, TP, SL, slip); const avg = r.reduce((s, x) => s + x, 0) / r.length;
  console.log(`  stop slips ${(slip*100).toFixed(0).padStart(2)}% worse → avg ${(avg*100).toFixed(1)}%/t  (n=${r.length})`); }
const base = retsFor(filt, TP, SL, 0).sort((a, b) => b - a);
const tot = base.reduce((s, x) => s + x, 0), med = base[Math.floor(base.length / 2)];
const exTop3 = base.slice(3).reduce((s, x) => s + x, 0) / (base.length - 3);
console.log(`  median trade ${(med*100).toFixed(1)}% · total ${(tot*100).toFixed(0)}% · top-3 rets ${base.slice(0,3).map(x=>(x*100).toFixed(0)+"%").join(", ")}`);
console.log(`  avg EXCLUDING top-3 winners: ${(exTop3*100).toFixed(1)}%/t  (if still positive, edge isn't one-lucky-trade)\n`);
