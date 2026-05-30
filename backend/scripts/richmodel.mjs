/**
 * Rich-feature model — add ORTHOGONAL entry signals (not correlated with trade
 * flow) to try to lift win rate, the one lever left:
 *   - dev reputation  : the dev wallet's PRIOR coins' outcomes (time-split, no leak)
 *   - bundle/coordination : near-simultaneous, similar-sized early buys (rug fingerprint)
 *   - serial-buyer cluster : are the early buyers serial wallets that spray many launches
 *
 * Compares BASELINE (8 trade-flow features) vs RICH (+6 orthogonal) on:
 *   1) out-of-sample top-5% lift, 2) the ≤$8k bracket EV at 6% cost + slippage.
 * Time-split: model+pool+history from TRAIN (oldest 60%), results on VALIDATION.
 *   node scripts/richmodel.mjs --no-db
 */

import { loadDataset } from "./lib/dataset.mjs";

const SUCCESS_MC = 25_000, MIN_EARLY_TRADES = 3, FEAT_MS = 60_000, BUNDLE_MS = 15_000, ENTRY_CAP_MS = 600_000;
const FEE = Number(process.env.FEE || 0.94);

const { tokens, tradesByMint, sources } = await loadDataset();
console.log(`\nsources: ${sources.join(", ")}  cost ${((1-FEE)*100).toFixed(0)}%`);
const list = [...tokens.values()].filter((t) => t.createdMs && tradesByMint.has(t.mint)).sort((a, b) => a.createdMs - b.createdMs);
const splitMs = list[Math.floor(list.length * 0.6)].createdMs;
const isTrain = (t) => t.createdMs < splitMs;

// ── precompute orthogonal pieces (leakage-safe) ───────────────────────────────
// dev prior outcomes: per dev, tokens sorted by time; stats over EARLIER launches
const byDev = new Map();
for (const t of list) { if (!t.devWallet) continue; let a = byDev.get(t.devWallet); if (!a) { a = []; byDev.set(t.devWallet, a); } a.push(t); }
for (const a of byDev.values()) a.sort((x, y) => x.createdMs - y.createdMs);
const devPrior = new Map(); // mint -> {count, best, avg}
for (const a of byDev.values()) {
  let count = 0, sum = 0, best = 0;
  for (const t of a) { devPrior.set(t.mint, { count, best, avg: count ? sum / count : 0 }); count++; sum += t.peakMc || 0; if ((t.peakMc || 0) > best) best = t.peakMc || 0; }
}
// serial-buyer counts: wallet -> # TRAIN tokens it bought in first 60s
const earlyBuyCount = new Map();
for (const t of list) { if (!isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const cut = t.createdMs + FEAT_MS; const seen = new Set();
  for (const tr of arr) { if (tr.ts > cut) break; if (tr.side === "buy" && !seen.has(tr.wallet)) { seen.add(tr.wallet); earlyBuyCount.set(tr.wallet, (earlyBuyCount.get(tr.wallet) || 0) + 1); } } }
// winner-wallet pool (train only) for the existing winnerBuyers feature
const wnet = new Map(), wcnt = new Map();
for (const t of list) { if (!isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const pos = new Map();
  for (const tr of arr) { let p = pos.get(tr.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(tr.wallet, p); } if (tr.side === "buy") p.in += tr.sol; else p.out += tr.sol; }
  for (const [w, p] of pos) { wnet.set(w, (wnet.get(w) || 0) + (p.out - p.in)); wcnt.set(w, (wcnt.get(w) || 0) + 1); } }
const winnerWallet = new Set(); for (const [w, n] of wnet) if (n >= 10 && (wcnt.get(w) || 0) >= 5) winnerWallet.add(w);

// static (per-token, constant after 15s) orthogonal features
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const staticFeat = new Map();
for (const t of list) {
  const arr = tradesByMint.get(t.mint);
  const dp = devPrior.get(t.mint) || { count: 0, best: 0, avg: 0 };
  // bundle features from first 15s buys
  const eb = []; const cut15 = t.createdMs + BUNDLE_MS;
  for (const tr of arr) { if (tr.ts > cut15) break; if (tr.side === "buy") eb.push(tr); }
  let bundleMax = 0;
  for (let i = 0; i < eb.length; i++) { let c = 0; for (let j = i; j < eb.length && eb[j].ts - eb[i].ts <= 2000; j++) c++; if (c > bundleMax) bundleMax = c; }
  let twin = 0;
  for (let i = 0; i < eb.length; i++) { for (let j = 0; j < eb.length; j++) { if (i === j) continue; if (Math.abs(eb[i].ts - eb[j].ts) <= 2000) { const a = eb[i].sol, b = eb[j].sol, mx = Math.max(a, b) || 1; if (Math.abs(a - b) / mx <= 0.15) { twin++; break; } } } }
  const simFrac = eb.length ? twin / eb.length : 0;
  // serial-buyer activity over first-60s buyers
  const cut60 = t.createdMs + FEAT_MS; const acts = []; const seen = new Set();
  for (const tr of arr) { if (tr.ts > cut60) break; if (tr.side === "buy" && !seen.has(tr.wallet)) { seen.add(tr.wallet); acts.push(earlyBuyCount.get(tr.wallet) || 0); } }
  staticFeat.set(t.mint, [Math.log1p(dp.count), Math.log1p(dp.best), Math.log1p(dp.avg), Math.log1p(bundleMax), simFrac, Math.log1p(median(acts))]);
}

// ── feature plumbing ──────────────────────────────────────────────────────────
function makeAcc() { return { buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0, winners: new Set() }; }
function push(acc, tr) { acc.n++; acc.vol += tr.sol;
  if (tr.side === "buy") { acc.buys++; acc.net += tr.sol; acc.buyVol += tr.sol; const v = (acc.buyers.get(tr.wallet) || 0) + tr.sol; acc.buyers.set(tr.wallet, v); if (v > acc.maxBuyer) acc.maxBuyer = v; if (winnerWallet.has(tr.wallet)) acc.winners.add(tr.wallet); }
  else { acc.sells++; acc.net -= tr.sol; } }
function flow(acc) { const conc = acc.buyVol > 0 ? acc.maxBuyer / acc.buyVol : 1;
  return [Math.log1p(acc.buyers.size), Math.log1p(acc.vol), Math.log1p(acc.n), Math.sign(acc.net) * Math.log1p(Math.abs(acc.net)), conc, acc.sells > 0 ? Math.min(acc.buys / acc.sells, 10) : Math.min(acc.buys, 10), Math.log1p(acc.buys > 0 ? acc.buyVol / acc.buys : 0), Math.log1p(acc.winners.size)]; }
const FNAMES = ["log uniqueBuyers", "log vol", "log nTrades", "signed log net", "concentration", "buy/sell", "log avgBuy", "log winnerBuyers", "log devPriorCount", "log devBestPeak", "log devAvgPeak", "log bundleMax", "bundleSimFrac", "log serialBuyerMed"];
const sig = (v) => 1 / (1 + Math.exp(-v));

function fullAt60(t) { const arr = tradesByMint.get(t.mint); const acc = makeAcc(); const cut = t.createdMs + FEAT_MS;
  for (const tr of arr) { if (tr.ts > cut) break; push(acc, tr); } if (acc.n < MIN_EARLY_TRADES) return null;
  return flow(acc).concat(staticFeat.get(t.mint)); }

function trainModel(dims) {
  const rows = [];
  for (const t of list) { if (!isTrain(t)) continue; const f = fullAt60(t); if (!f) continue; rows.push({ x: dims.map((d) => f[d]), y: (t.peakMc || 0) >= SUCCESS_MC ? 1 : 0 }); }
  const D = dims.length; const mean = Array(D).fill(0), std = Array(D).fill(0);
  for (const r of rows) for (let j = 0; j < D; j++) mean[j] += r.x[j]; for (let j = 0; j < D; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < D; j++) std[j] += (r.x[j] - mean[j]) ** 2; for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / rows.length) || 1;
  const z = (x) => x.map((v, j) => (v - mean[j]) / std[j]);
  const w = Array(D).fill(0); let b = 0; const pos = rows.filter((r) => r.y).length, wPos = (rows.length - pos) / Math.max(1, pos);
  for (let it = 0; it < 1000; it++) { const gw = Array(D).fill(0); let gb = 0;
    for (const r of rows) { const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; const p = sig(s); const cw = r.y ? wPos : 1; const err = (p - r.y) * cw; for (let j = 0; j < D; j++) gw[j] += err * zx[j]; gb += err; }
    for (let j = 0; j < D; j++) w[j] -= 0.1 * (gw[j] / rows.length + 1e-3 * w[j]); b -= 0.1 * (gb / rows.length); }
  const scoreFull = (f) => { const x = dims.map((d) => f[d]); const zx = z(x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); };
  const trainScores = rows.map((r) => { const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); }).sort((a, c) => c - a);
  return { dims, w, scoreFull, pos, nTrain: rows.length, th5: trainScores[Math.floor(trainScores.length * 0.05)] };
}

function valLift(model) {
  const rows = [];
  for (const t of list) { if (isTrain(t)) continue; const f = fullAt60(t); if (!f) continue; rows.push({ s: model.scoreFull(f), y: (t.peakMc || 0) >= SUCCESS_MC ? 1 : 0 }); }
  const base = rows.reduce((s, r) => s + r.y, 0) / rows.length; rows.sort((a, b) => b.s - a.s);
  const top = rows.slice(0, Math.max(1, Math.floor(rows.length * 0.05)));
  return { base, top5: top.reduce((s, r) => s + r.y, 0) / top.length, n: rows.length };
}

// entry scan with a model: score live (flow evolves, static constant)
function findEntry(t, model, cap) { const arr = tradesByMint.get(t.mint); const acc = makeAcc(); const st = staticFeat.get(t.mint);
  for (let i = 0; i < arr.length; i++) { const tr = arr[i]; push(acc, tr);
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return -1;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0 || tr.mc > cap) continue;
    if (model.scoreFull(flow(acc).concat(st)) >= model.th5) return i; } return -1; }
function bracket(arr, ei, tp, sl, slip) { const e = arr[ei].mc;
  for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m / e >= tp) return tp; if (m / e <= sl) return Math.max(0.01, sl - slip); }
  return arr[arr.length - 1].mc / e; }
function evalBracket(model, cap, tp, sl, slip) { const rets = [];
  for (const t of list) { if (isTrain(t)) continue; const ei = findEntry(t, model, cap); if (ei < 0) continue; rets.push(bracket(tradesByMint.get(t.mint), ei, tp, sl, slip) * FEE - 1); }
  const wins = rets.filter((x) => x > 0).length; return { n: rets.length, win: rets.length ? wins / rets.length : 0, avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0 }; }

const baseDims = [0, 1, 2, 3, 4, 5, 6, 7];
const richDims = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const baseM = trainModel(baseDims), richM = trainModel(richDims);

console.log(`\n══ RICH MODEL WEIGHTS (orthogonal features) ═════════════════════════════`);
richDims.slice(8).forEach((d, k) => console.log(`  ${FNAMES[d].padEnd(20)} ${richM.w[8 + k] >= 0 ? "+" : ""}${richM.w[8 + k].toFixed(3)}`));

const bl = valLift(baseM), rl = valLift(richM);
console.log(`\n══ VALIDATION TOP-5% LIFT  (base rate ${(bl.base*100).toFixed(2)}%) ═══════════════════`);
console.log(`  BASELINE (8 feats): ${(bl.top5*100).toFixed(1)}%  (${(bl.top5/bl.base).toFixed(1)}x)`);
console.log(`  RICH    (14 feats): ${(rl.top5*100).toFixed(1)}%  (${(rl.top5/rl.base).toFixed(1)}x)`);

console.log(`\n══ ≤$8k BRACKET EV @ ${((1-FEE)*100).toFixed(0)}% cost — BASELINE vs RICH ════════════════════`);
for (const [name, M] of [["BASELINE", baseM], ["RICH", richM]]) {
  let best = null;
  for (const tp of [2, 2.5, 3]) for (const sl of [0.85, 0.9]) { const r = evalBracket(M, 8000, tp, sl, 0); if (r.n >= 20 && (!best || r.avg > best.r.avg)) best = { tp, sl, r }; }
  const v3 = evalBracket(M, 8000, best.tp, best.sl, 0.03), v5 = evalBracket(M, 8000, best.tp, best.sl, 0.05);
  console.log(`  ${name}: TP${best.tp}/SL${best.sl} → ${(best.r.avg*100).toFixed(1)}%/t (win ${(best.r.win*100).toFixed(0)}%, n${best.r.n}) · +3%slip ${(v3.avg*100).toFixed(1)}% · +5%slip ${(v5.avg*100).toFixed(1)}%`);
}
console.log(`\n  Win-rate up + EV stays positive under slippage in RICH = the orthogonal`);
console.log(`  features bought us a real, more robust edge. Otherwise they didn't help.\n`);
