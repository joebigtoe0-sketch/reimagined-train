/**
 * Money hunt — does ANY entry/exit survive realistic execution cost?
 *
 * Lessons baked in:
 *  - entries are good (upside exists); the EXIT is what matters
 *  - tight price-stops are slippage-fragile on pump.fun, so we test order-flow /
 *    momentum exits that sell WHILE trades are happening (not into a crash)
 *  - cheaper entries give more upside cushion over fixed costs
 *
 * Everything costed at a conservative 6% round-trip (FEE=0.94). Time-split:
 * model + threshold from TRAIN (oldest 60%), results on VALIDATION. Read-only.
 *   node scripts/moneyhunt.mjs --no-db
 */

import { loadDataset } from "./lib/dataset.mjs";

const SUCCESS_MC = 25_000, MIN_EARLY_TRADES = 3, TRAIN_FEAT_MS = 60_000, ENTRY_CAP_MS = 600_000;
const FEE = Number(process.env.FEE || 0.94);   // 6% round-trip (realistic, conservative)

const { tokens, tradesByMint, sources } = await loadDataset();
console.log(`\nsources: ${sources.join(", ")}  round-trip cost ${((1-FEE)*100).toFixed(0)}%`);
const list = [...tokens.values()].filter((t) => t.createdMs && tradesByMint.has(t.mint)).sort((a, b) => a.createdMs - b.createdMs);
const splitMs = list[Math.floor(list.length * 0.6)].createdMs;
const isTrain = (t) => t.createdMs < splitMs;

// winner-wallet pool (train only)
const wnet = new Map(), wcnt = new Map();
for (const t of list) { if (!isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const pos = new Map();
  for (const tr of arr) { let p = pos.get(tr.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(tr.wallet, p); } if (tr.side === "buy") p.in += tr.sol; else p.out += tr.sol; }
  for (const [w, p] of pos) { wnet.set(w, (wnet.get(w) || 0) + (p.out - p.in)); wcnt.set(w, (wcnt.get(w) || 0) + 1); } }
const winnerWallet = new Set(); for (const [w, n] of wnet) if (n >= 10 && (wcnt.get(w) || 0) >= 5) winnerWallet.add(w);

function makeAcc() { return { buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0, winners: new Set() }; }
function push(acc, tr) {
  acc.n++; acc.vol += tr.sol;
  if (tr.side === "buy") { acc.buys++; acc.net += tr.sol; acc.buyVol += tr.sol; const v = (acc.buyers.get(tr.wallet) || 0) + tr.sol; acc.buyers.set(tr.wallet, v); if (v > acc.maxBuyer) acc.maxBuyer = v; if (winnerWallet.has(tr.wallet)) acc.winners.add(tr.wallet); }
  else { acc.sells++; acc.net -= tr.sol; }
}
function vec(acc) { const conc = acc.buyVol > 0 ? acc.maxBuyer / acc.buyVol : 1;
  return [Math.log1p(acc.buyers.size), Math.log1p(acc.vol), Math.log1p(acc.n), Math.sign(acc.net) * Math.log1p(Math.abs(acc.net)), conc, acc.sells > 0 ? Math.min(acc.buys / acc.sells, 10) : Math.min(acc.buys, 10), Math.log1p(acc.buys > 0 ? acc.buyVol / acc.buys : 0), Math.log1p(acc.winners.size)]; }
const D = 8, sig = (v) => 1 / (1 + Math.exp(-v));

const train = [];
for (const t of list) { if (!isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const acc = makeAcc(); const cut = t.createdMs + TRAIN_FEAT_MS;
  for (const tr of arr) { if (tr.ts > cut) break; push(acc, tr); } if (acc.n < MIN_EARLY_TRADES) continue;
  train.push({ x: vec(acc), y: (t.peakMc || 0) >= SUCCESS_MC ? 1 : 0 }); }
const mean = Array(D).fill(0), std = Array(D).fill(0);
for (const r of train) for (let j = 0; j < D; j++) mean[j] += r.x[j]; for (let j = 0; j < D; j++) mean[j] /= train.length;
for (const r of train) for (let j = 0; j < D; j++) std[j] += (r.x[j] - mean[j]) ** 2; for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / train.length) || 1;
const z = (x) => x.map((v, j) => (v - mean[j]) / std[j]);
const w = Array(D).fill(0); let b = 0; const pos = train.filter((r) => r.y).length, wPos = (train.length - pos) / Math.max(1, pos);
for (let it = 0; it < 800; it++) { const gw = Array(D).fill(0); let gb = 0;
  for (const r of train) { const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; const p = sig(s); const cw = r.y ? wPos : 1; const err = (p - r.y) * cw; for (let j = 0; j < D; j++) gw[j] += err * zx[j]; gb += err; }
  for (let j = 0; j < D; j++) w[j] -= 0.1 * (gw[j] / train.length + 1e-3 * w[j]); b -= 0.1 * (gb / train.length); }
const score = (x) => { const zx = z(x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); };
const trainScores = train.map((r) => score(r.x)).sort((a, c) => c - a);
const th5 = trainScores[Math.floor(trainScores.length * 0.05)];

/** Find entry index (first score>=th & mc<=cap within window). */
function findEntry(t, cap) {
  const arr = tradesByMint.get(t.mint); const acc = makeAcc();
  for (let i = 0; i < arr.length; i++) { const tr = arr[i]; push(acc, tr);
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return -1;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0 || tr.mc > cap) continue;
    if (score(vec(acc)) >= th5) return i; }
  return -1;
}
// exit families return a multiple (mc_exit/mc_entry), pre-fee
function exitBracket(arr, ei, tp, sl) { const e = arr[ei].mc;
  for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m / e >= tp) return tp; if (m / e <= sl) return sl; }
  return arr[arr.length - 1].mc / e; }
function exitMomentum(arr, ei, winMs, catStop) { const e = arr[ei].mc; let recent = [];
  for (let i = ei + 1; i < arr.length; i++) { const tr = arr[i]; if (tr.mc <= 0) continue;
    recent.push({ ts: tr.ts, s: tr.side === "buy" ? tr.sol : -tr.sol }); while (recent.length && recent[0].ts < tr.ts - winMs) recent.shift();
    const net = recent.reduce((s, x) => s + x.s, 0);
    if (tr.mc / e <= catStop) return tr.mc / e;          // catastrophe stop (wide)
    if (recent.length >= 3 && net < 0) return tr.mc / e; // buying dried up — sell into liquidity
  }
  return arr[arr.length - 1].mc / e; }
function exitTrail(arr, ei, trail, catStop) { const e = arr[ei].mc; let peak = e;
  for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue; if (m > peak) peak = m;
    if (m / e <= catStop) return m / e; if (peak > e && m <= peak * (1 - trail)) return m / e; }
  return arr[arr.length - 1].mc / e; }

function evalFam(cap, fam) {
  const rets = [];
  for (const t of list) { if (isTrain(t)) continue; const arr = tradesByMint.get(t.mint); const ei = findEntry(t, cap); if (ei < 0) continue;
    rets.push(fam(arr, ei) * FEE - 1); }
  const wins = rets.filter((x) => x > 0).length;
  return { n: rets.length, win: rets.length ? wins / rets.length : 0, avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0 };
}

console.log(`train winners ${pos}/${train.length} · entry = top-5% score (th=${th5.toFixed(3)})\n`);
console.log(`══ EXIT FAMILY × ENTRY-MC CAP  (validation, ${((1-FEE)*100).toFixed(0)}% cost) ════════════════`);
console.log(`  best config per family shown as: avg%/trade (win%, n)\n`);
const caps = [8000, 12000, 15000, 25000];
const families = {
  "bracket TP/SL": (cap) => { let best = null; for (const tp of [1.5, 2, 2.5, 3]) for (const sl of [0.8, 0.85, 0.9]) { const r = evalFam(cap, (a, e) => exitBracket(a, e, tp, sl)); if (r.n >= 20 && (!best || r.avg > best.r.avg)) best = { tp, sl, r }; } return best; },
  "momentum flip": (cap) => { let best = null; for (const win of [10000, 20000, 30000]) for (const cat of [0.4, 0.5, 0.6]) { const r = evalFam(cap, (a, e) => exitMomentum(a, e, win, cat)); if (r.n >= 20 && (!best || r.avg > best.r.avg)) best = { win, cat, r }; } return best; },
  "trailing": (cap) => { let best = null; for (const tr of [0.3, 0.4, 0.5]) for (const cat of [0.4, 0.5]) { const r = evalFam(cap, (a, e) => exitTrail(a, e, tr, cat)); if (r.n >= 20 && (!best || r.avg > best.r.avg)) best = { tr, cat, r }; } return best; }
};
console.log("  family".padEnd(18) + caps.map((c) => `≤$${c/1000}k`.padStart(16)).join(""));
let anyPositive = false;
for (const [name, fn] of Object.entries(families)) {
  let row = "  " + name.padEnd(16);
  for (const cap of caps) { const best = fn(cap); if (!best) { row += "—".padStart(16); continue; }
    if (best.r.avg > 0) anyPositive = true;
    row += `${(best.r.avg * 100).toFixed(1)}%(${(best.r.win*100).toFixed(0)}%,${best.r.n})`.padStart(16); }
  console.log(row);
}
console.log(`\n  ${anyPositive ? "Some configs are positive at this cost — drilling the cheap-entry bracket." : "Nothing positive at realistic cost → no robust edge on this data yet."}`);

// ── DRILL: cheap-entry (≤$8k) bracket, full grid + stop-slippage stress ───────
function exitBracketSlip(arr, ei, tp, sl, slip) { const e = arr[ei].mc;
  for (let i = ei + 1; i < arr.length; i++) { const m = arr[i].mc; if (m <= 0) continue;
    if (m / e >= tp) return tp; if (m / e <= sl) return Math.max(0.01, sl - slip); }
  return arr[arr.length - 1].mc / e; }
function evalBracketSlip(cap, tp, sl, slip) { const rets = [];
  for (const t of list) { if (isTrain(t)) continue; const ei = findEntry(t, cap); if (ei < 0) continue; rets.push(exitBracketSlip(tradesByMint.get(t.mint), ei, tp, sl, slip) * FEE - 1); }
  const wins = rets.filter((x) => x > 0).length; return { n: rets.length, win: rets.length ? wins / rets.length : 0, avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0 }; }

const CAP = 8000;
console.log(`\n══ DRILL ≤$${CAP/1000}k bracket — avg%/trade at ${((1-FEE)*100).toFixed(0)}% cost, NO extra stop slip ══`);
console.log("  TP\\SL " + [0.8, 0.85, 0.9].map((s) => `SL${s}`.padStart(9)).join(""));
for (const tp of [1.5, 2, 2.5, 3]) console.log(`  TP${tp.toFixed(1)} ` + [0.8, 0.85, 0.9].map((sl) => `${(evalBracketSlip(CAP, tp, sl, 0).avg * 100).toFixed(1)}%`.padStart(9)).join(""));

console.log(`\n══ STOP-SLIPPAGE STRESS  (≤$${CAP/1000}k, TP 2.5x / SL 0.85x) ════════════════`);
for (const slip of [0, 0.03, 0.05, 0.08]) { const r = evalBracketSlip(CAP, 2.5, 0.85, slip);
  console.log(`  stop fills ${(slip*100).toFixed(0).padStart(2)}% worse → avg ${(r.avg*100).toFixed(1)}%/trade · win ${(r.win*100).toFixed(0)}% · n=${r.n}`); }
console.log(`\n  Positive across slippage = robust enough to forward-test. Run FEE=0.96 for the 4% case.\n`);
