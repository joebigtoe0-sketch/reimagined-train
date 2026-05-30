/**
 * Condition-driven strategy backtest (no fixed clocks).
 *
 * ENTRY: walk a coin's trades chronologically; the instant the live winner-score
 *        crosses a threshold (optionally while MC is still below a cap, so we
 *        catch ignition rather than the top), BUY at that trade's price.
 * EXIT:  keep walking; SELL the instant an exit CONDITION fires — trailing
 *        drawdown from peak, a hard stop, or sustained sell-pressure. No timer.
 *
 * Everything is event-driven and computable live. Time-split, out-of-sample:
 * model + threshold from TRAIN (oldest 60%), all results on VALIDATION (newest 40%).
 *
 *   node scripts/condstrat.mjs --no-db     # exports only (fast)
 */

import { loadDataset } from "./lib/dataset.mjs";

const SUCCESS_MC = 25_000;
const MIN_EARLY_TRADES = 3;
const FEE = 0.96;
const TRAIN_FEAT_MS = 60_000;   // features used to TRAIN the model (fixed, fine)
const ENTRY_CAP_MS = 600_000;   // don't open a new position after 10 min
const RECENT_MS = 30_000;       // trailing window for live sell-pressure

const { tokens, tradesByMint, sources } = await loadDataset();
console.log(`\nsources: ${sources.join(", ")}  tokens=${tokens.size} withTrades=${tradesByMint.size}`);

const list = [...tokens.values()].filter((t) => t.createdMs && tradesByMint.has(t.mint)).sort((a, b) => a.createdMs - b.createdMs);
const splitMs = list[Math.floor(list.length * 0.6)].createdMs;
const isTrain = (t) => t.createdMs < splitMs;

// winner-wallet pool from TRAIN tokens only
const wnet = new Map(), wcnt = new Map();
for (const t of list) {
  if (!isTrain(t)) continue;
  const arr = tradesByMint.get(t.mint); const pos = new Map();
  for (const tr of arr) { let p = pos.get(tr.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(tr.wallet, p); } if (tr.side === "buy") p.in += tr.sol; else p.out += tr.sol; }
  for (const [w, p] of pos) { wnet.set(w, (wnet.get(w) || 0) + (p.out - p.in)); wcnt.set(w, (wcnt.get(w) || 0) + 1); }
}
const winnerWallet = new Set();
for (const [w, n] of wnet) if (n >= 10 && (wcnt.get(w) || 0) >= 5) winnerWallet.add(w);

// incremental feature accumulator for one token, queried at any trade index
function makeAcc() {
  return { buyers: new Map(), n: 0, buys: 0, sells: 0, net: 0, vol: 0, buyVol: 0, maxBuyer: 0, winners: new Set() };
}
function push(acc, tr) {
  acc.n++; acc.vol += tr.sol;
  if (tr.side === "buy") {
    acc.buys++; acc.net += tr.sol; acc.buyVol += tr.sol;
    const v = (acc.buyers.get(tr.wallet) || 0) + tr.sol; acc.buyers.set(tr.wallet, v);
    if (v > acc.maxBuyer) acc.maxBuyer = v;
    if (winnerWallet.has(tr.wallet)) acc.winners.add(tr.wallet);
  } else { acc.sells++; acc.net -= tr.sol; }
}
function vec(acc) {
  const conc = acc.buyVol > 0 ? acc.maxBuyer / acc.buyVol : 1;
  return [
    Math.log1p(acc.buyers.size),
    Math.log1p(acc.vol),
    Math.log1p(acc.n),
    Math.sign(acc.net) * Math.log1p(Math.abs(acc.net)),
    conc,
    acc.sells > 0 ? Math.min(acc.buys / acc.sells, 10) : Math.min(acc.buys, 10),
    Math.log1p(acc.buys > 0 ? acc.buyVol / acc.buys : 0),
    Math.log1p(acc.winners.size)
  ];
}
const D = 8, sig = (v) => 1 / (1 + Math.exp(-v));

// ── train logistic on features at fixed 60s ───────────────────────────────────
const train = [];
for (const t of list) {
  if (!isTrain(t)) continue;
  const arr = tradesByMint.get(t.mint); const acc = makeAcc(); const cut = t.createdMs + TRAIN_FEAT_MS;
  for (const tr of arr) { if (tr.ts > cut) break; push(acc, tr); }
  if (acc.n < MIN_EARLY_TRADES) continue;
  train.push({ x: vec(acc), y: (t.peakMc || 0) >= SUCCESS_MC ? 1 : 0 });
}
const mean = Array(D).fill(0), std = Array(D).fill(0);
for (const r of train) for (let j = 0; j < D; j++) mean[j] += r.x[j];
for (let j = 0; j < D; j++) mean[j] /= train.length;
for (const r of train) for (let j = 0; j < D; j++) std[j] += (r.x[j] - mean[j]) ** 2;
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / train.length) || 1;
const z = (x) => x.map((v, j) => (v - mean[j]) / std[j]);
const w = Array(D).fill(0); let b = 0;
const pos = train.filter((r) => r.y).length, neg = train.length - pos, wPos = neg / Math.max(1, pos);
for (let it = 0; it < 800; it++) {
  const gw = Array(D).fill(0); let gb = 0;
  for (const r of train) {
    const zx = z(r.x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j];
    const p = sig(s); const cw = r.y ? wPos : 1; const err = (p - r.y) * cw;
    for (let j = 0; j < D; j++) gw[j] += err * zx[j]; gb += err;
  }
  for (let j = 0; j < D; j++) w[j] -= 0.1 * (gw[j] / train.length + 1e-3 * w[j]);
  b -= 0.1 * (gb / train.length);
}
const scoreVec = (x) => { const zx = z(x); let s = b; for (let j = 0; j < D; j++) s += w[j] * zx[j]; return sig(s); };

// thresholds from TRAIN score distribution (top X% cutoffs)
const trainScores = train.map((r) => scoreVec(r.x)).sort((a, c) => c - a);
const thAt = (frac) => trainScores[Math.min(trainScores.length - 1, Math.floor(trainScores.length * frac))];

/**
 * Event-driven simulation of one token.
 * Entry: first trade where score>=TH (and mc<=maxEntryMc) within ENTRY_CAP_MS.
 * Exit:  first trade where trailing-drawdown / SL / sell-pressure fires.
 * @returns {null|{ret:number, entryMc:number, peakMc:number, heldS:number}}
 */
function simulate(t, p) {
  const arr = tradesByMint.get(t.mint); const acc = makeAcc();
  let entry = null, entryIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    const tr = arr[i];
    push(acc, tr);
    if (entry) continue;
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return null;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0) continue;
    if (tr.mc > p.maxEntryMc) continue;
    if (scoreVec(vec(acc)) >= p.th) { entry = { mc: tr.mc, ts: tr.ts }; entryIdx = i; }
  }
  if (!entry) return null;

  // Realistic condition-based exit + ORACLE max (best possible sell) in one pass.
  let peak = entry.mc, oracleMax = entry.mc, recent = [], realized = null;
  for (let i = entryIdx + 1; i < arr.length; i++) {
    const tr = arr[i]; if (tr.mc <= 0) continue;
    if (tr.mc > oracleMax) oracleMax = tr.mc;            // oracle never stops looking
    if (realized) continue;                              // realistic exit already taken
    if (tr.mc > peak) peak = tr.mc;
    recent.push({ ts: tr.ts, s: tr.side === "buy" ? tr.sol : -tr.sol });
    while (recent.length && recent[0].ts < tr.ts - RECENT_MS) recent.shift();
    const recentNet = recent.reduce((s, x) => s + x.s, 0);
    const mult = tr.mc / entry.mc;
    let exit = false;
    if (mult <= p.sl) exit = true;
    else if (peak > entry.mc && tr.mc <= peak * (1 - p.trail)) exit = true;
    else if (p.usePressure && recentNet < 0 && tr.mc < entry.mc) exit = true;
    if (exit) realized = mult * FEE - 1;
  }
  if (realized == null) { const last = arr[arr.length - 1]; realized = (last.mc / entry.mc) * FEE - 1; }
  return { ret: realized, entryMc: entry.mc, oracleMult: oracleMax / entry.mc };
}

const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const pct = (a, t) => (a.length ? a.filter((x) => x >= t).length / a.length * 100 : 0);

/** Run all validation entries for a given entry selectivity + exit rule. */
function run(p) {
  const rets = [], oracles = [];
  for (const t of list) { if (isTrain(t)) continue; const r = simulate(t, p); if (!r) continue; rets.push(r.ret); oracles.push(r.oracleMult); }
  const wins = rets.filter((x) => x > 0).length;
  return {
    n: rets.length,
    winRate: rets.length ? wins / rets.length : 0,
    avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0,
    medReal: med(rets),
    oracleMed: med(oracles),
    up20: pct(oracles, 1.2), up50: pct(oracles, 1.5), up100: pct(oracles, 2.0)
  };
}

console.log(`train rows=${train.length} (winners ${pos})`);
console.log(`\n══ ENTRY vs EXIT DIAGNOSIS (validation) ═════════════════════════════════`);
console.log(`  Entry = first moment score≥TH while MC ≤ $15k. Exit = trailing35%/SL0.65/`);
console.log(`  sell-pressure. ORACLE = best possible sell (sell at the exact top).\n`);
console.log(`  selectivity   n    realExit avg   realExit win   ORACLE: median  %≥+20%  %≥+50%  %≥+100%`);
const exit = { maxEntryMc: 15000, trail: 0.35, sl: 0.65, usePressure: true };
for (const topFrac of [0.02, 0.05, 0.1, 0.15]) {
  const p = { ...exit, th: thAt(topFrac) };
  const r = run(p);
  console.log(
    `  top ${(topFrac*100).toFixed(0).padStart(2)}%   ${String(r.n).padStart(5)}   ` +
    `${(r.avg*100).toFixed(1).padStart(7)}%      ${(r.winRate*100).toFixed(0).padStart(3)}%        ` +
    `${r.oracleMed.toFixed(2)}x        ${r.up20.toFixed(0).padStart(3)}%   ${r.up50.toFixed(0).padStart(3)}%    ${r.up100.toFixed(0).padStart(3)}%`
  );
}
console.log(`\n  Read it:`);
console.log(`   • ORACLE median ≈ 1.0x and low %≥+20%  → entries have NO upside left (entry problem).`);
console.log(`   • ORACLE big but realExit negative     → upside exists, our EXIT bails wrong (exit problem).`);
console.log();

// ── BRACKET exit: bank the upside the entries provide (TP/SL, sequence-aware) ──
function simBracket(t, th, maxEntryMc, tp, sl) {
  const arr = tradesByMint.get(t.mint); const acc = makeAcc();
  let entry = null, entryIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    const tr = arr[i]; push(acc, tr);
    if (entry) continue;
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return null;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0 || tr.mc > maxEntryMc) continue;
    if (scoreVec(vec(acc)) >= th) { entry = tr; entryIdx = i; }
  }
  if (!entry) return null;
  for (let i = entryIdx + 1; i < arr.length; i++) {
    const tr = arr[i]; if (tr.mc <= 0) continue;
    const mult = tr.mc / entry.mc;
    if (mult >= tp) return tp * FEE - 1;   // hit take-profit first
    if (mult <= sl) return sl * FEE - 1;   // hit stop first
  }
  const last = arr[arr.length - 1];
  return (last.mc / entry.mc) * FEE - 1;
}
function runBracket(th, maxEntryMc, tp, sl) {
  const rets = [];
  for (const t of list) { if (isTrain(t)) continue; const r = simBracket(t, th, maxEntryMc, tp, sl); if (r != null) rets.push(r); }
  const wins = rets.filter((x) => x > 0).length;
  return { n: rets.length, win: rets.length ? wins / rets.length : 0, avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0 };
}

console.log(`══ BRACKET EXIT SWEEP (validation) — bank the move with TP/SL ═══════════`);
console.log(`  entry: top 5% score while MC ≤ $15k  ·  fee 4%`);
console.log(`  TP \\ SL    ` + [0.7, 0.8, 0.85, 0.9].map((s) => `SL${s}`.padStart(9)).join(""));
const th5 = thAt(0.05);
let bestB = null;
for (const tp of [1.15, 1.2, 1.3, 1.5, 2.0]) {
  const cells = [];
  for (const sl of [0.7, 0.8, 0.85, 0.9]) {
    const r = runBracket(th5, 15000, tp, sl);
    cells.push(`${(r.avg * 100).toFixed(1)}%`.padStart(9));
    if (!bestB || r.avg > bestB.r.avg) bestB = { tp, sl, r };
  }
  console.log(`  TP${tp.toFixed(2)}  ` + cells.join(""));
}
const bb = bestB;
console.log(`\n  ★ BEST bracket: TP ${bb.tp}x / SL ${bb.sl}x → avg ${(bb.r.avg*100).toFixed(1)}%/trade · win ${(bb.r.win*100).toFixed(0)}% · n=${bb.r.n}`);
console.log(`  (each cell = avg %/trade after fees; positive = profitable exit rule)\n`);

// ── ROBUSTNESS: pick rule on TRAIN, confirm on VAL, add stop slippage ─────────
function simBracketSlip(t, train, th, maxEntryMc, tp, sl, slipSL) {
  const arr = tradesByMint.get(t.mint); const acc = makeAcc();
  let entry = null, entryIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    const tr = arr[i]; push(acc, tr);
    if (entry) continue;
    if (tr.ts - t.createdMs > ENTRY_CAP_MS) return null;
    if (acc.n < MIN_EARLY_TRADES || tr.mc <= 0 || tr.mc > maxEntryMc) continue;
    if (scoreVec(vec(acc)) >= th) { entry = tr; entryIdx = i; }
  }
  if (!entry) return null;
  for (let i = entryIdx + 1; i < arr.length; i++) {
    const tr = arr[i]; if (tr.mc <= 0) continue;
    const mult = tr.mc / entry.mc;
    if (mult >= tp) return tp * FEE - 1;
    if (mult <= sl) return Math.max(0, sl - slipSL) * FEE - 1;  // stop fills `slipSL` worse
  }
  const last = arr[arr.length - 1];
  return (last.mc / entry.mc) * FEE - 1;
}
function evalBracket(wantTrain, th, tp, sl, slipSL) {
  const rets = [];
  for (const t of list) { if (isTrain(t) !== wantTrain) continue; const r = simBracketSlip(t, wantTrain, th, 15000, tp, sl, slipSL); if (r != null) rets.push(r); }
  const wins = rets.filter((x) => x > 0).length;
  return { n: rets.length, win: rets.length ? wins / rets.length : 0, avg: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0 };
}
// choose best (tp,sl) on TRAIN only (no slippage), then confirm on VAL
let pick = null;
for (const tp of [1.3, 1.5, 1.75, 2.0, 2.5])
  for (const sl of [0.8, 0.85, 0.9]) {
    const r = evalBracket(true, th5, tp, sl, 0);
    if (r.n >= 30 && (!pick || r.avg > pick.r.avg)) pick = { tp, sl, r };
  }
console.log(`══ ROBUSTNESS (rule picked on TRAIN, confirmed on VAL) ══════════════════`);
console.log(`  picked on train: TP ${pick.tp}x / SL ${pick.sl}x  (train avg ${(pick.r.avg*100).toFixed(1)}%/trade, n=${pick.r.n})`);
for (const slip of [0, 0.03, 0.05]) {
  const v = evalBracket(false, th5, pick.tp, pick.sl, slip);
  console.log(`  VAL  (stop slips ${(slip*100).toFixed(0)}% worse): avg ${(v.avg*100).toFixed(1)}%/trade · win ${(v.win*100).toFixed(0)}% · n=${v.n}`);
}
console.log(`\n  Survives only if VAL stays positive with realistic slippage. Low win-rate`);
console.log(`  + thin edge = high variance: forward-test on paper before any real money.\n`);
