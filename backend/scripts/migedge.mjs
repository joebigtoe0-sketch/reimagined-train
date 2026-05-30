/**
 * Migration / success edge finder.
 *
 * Goal: from the FIRST 60s of a coin's life (a window we can act on live), find
 * wallet-composition features that predict it becomes a "winner" (runs to a real
 * MC). Migration labels are still ~0 in our data (we just wired the feed), so we
 * use the best available proxy: peak market cap from the trade stream.
 *
 * For each candidate feature we report base rate vs top-quintile success rate and
 * the LIFT — that's what tells us "this is when it's good to buy".
 *
 * Uses the merged dataset (all local exports + live DB). Read-only.
 *   node scripts/migedge.mjs                 # exports + DB
 *   node scripts/migedge.mjs --no-db         # exports only (fast)
 */

import { loadDataset } from "./lib/dataset.mjs";

const EARLY_MS = 60_000;     // decision window: first 60s
const SUCCESS_MC = 25_000;   // "winner" = peak MC >= this
const MIN_EARLY_TRADES = 3;  // ignore coins with too little early activity

console.log("\nLoading merged dataset (exports + live DB)...");
const { tokens, tradesByMint, outcomes, sources } = await loadDataset();
console.log(`sources: ${sources.join(", ")}`);
console.log(`tokens=${tokens.size}  tokensWithTrades=${tradesByMint.size}  outcomes=${outcomes.size}`);

// ── Global wallet reputation (computed once over all data) ────────────────────
// "winner wallet" = recurring, net-SOL-profitable across the dataset. Live, we'd
// know a wallet's history from PAST coins; here it's whole-dataset (mild leakage,
// flagged) — enough to see whether buyer QUALITY carries signal at all.
const wnet = new Map(), wcount = new Map();
for (const arr of tradesByMint.values()) {
  const pos = new Map();
  for (const t of arr) { let p = pos.get(t.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(t.wallet, p); } if (t.side === "buy") p.in += t.sol; else p.out += t.sol; }
  for (const [w, p] of pos) { wnet.set(w, (wnet.get(w) || 0) + (p.out - p.in)); wcount.set(w, (wcount.get(w) || 0) + 1); }
}
const winnerWallet = new Set();
for (const [w, n] of wnet) if (n >= 10 && (wcount.get(w) || 0) >= 5) winnerWallet.add(w);
console.log(`winner-wallet pool: ${winnerWallet.size}\n`);

// ── Per-token early-window features ───────────────────────────────────────────
const rows = [];
const tierCounts = { ">=15k": 0, ">=25k": 0, ">=40k": 0, ">=69k": 0, ">=100k": 0 };
for (const [mint, tk] of tokens) {
  const arr = tradesByMint.get(mint);
  if (!arr || !tk.createdMs) continue;
  const peak = tk.peakMc || 0;
  if (peak >= 15000) tierCounts[">=15k"]++;
  if (peak >= 25000) tierCounts[">=25k"]++;
  if (peak >= 40000) tierCounts[">=40k"]++;
  if (peak >= 69000) tierCounts[">=69k"]++;
  if (peak >= 100000) tierCounts[">=100k"]++;

  const cut = tk.createdMs + EARLY_MS;
  const buyers = new Map(); // wallet -> buy sol in window
  let nTrades = 0, buys = 0, sells = 0, netSol = 0, vol = 0, snipers = new Set(), winners = new Set();
  for (const t of arr) {
    if (t.ts > cut) break;
    nTrades++;
    vol += t.sol;
    if (t.side === "buy") {
      buys++; netSol += t.sol;
      buyers.set(t.wallet, (buyers.get(t.wallet) || 0) + t.sol);
      if (t.ts <= tk.createdMs + 3000) snipers.add(t.wallet);
      if (winnerWallet.has(t.wallet)) winners.add(t.wallet);
    } else { sells++; netSol -= t.sol; }
  }
  if (nTrades < MIN_EARLY_TRADES) continue;
  const uniqueBuyers = buyers.size;
  const buyVol = [...buyers.values()].reduce((s, x) => s + x, 0);
  const topShare = buyVol > 0 ? Math.max(0, ...buyers.values()) / buyVol : 0;
  rows.push({
    success: peak >= SUCCESS_MC ? 1 : 0,
    uniqueBuyers,
    nTrades,
    netSol,
    vol,
    buyRatio: sells > 0 ? buys / sells : buys,
    concentration: topShare,
    snipers3s: snipers.size,
    winnerBuyers: winners.size,
    winnerFrac: uniqueBuyers > 0 ? winners.size / uniqueBuyers : 0,
    avgBuySize: buys > 0 ? buyVol / buys : 0
  });
}

const base = rows.reduce((s, r) => s + r.success, 0) / rows.length;
console.log(`══ DATASET ════════════════════════════════════════════════════════════`);
console.log(`  scored tokens (≥${MIN_EARLY_TRADES} early trades): ${rows.length}`);
console.log(`  peak-MC tiers: ${Object.entries(tierCounts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`  base success rate (peak ≥ $${SUCCESS_MC/1000}k): ${(base*100).toFixed(2)}%\n`);

const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
function lift(name) {
  const vals = rows.map((r) => r[name]);
  const sorted = rows.slice().sort((a, b) => b[name] - a[name]);
  const top = sorted.slice(0, Math.max(1, Math.floor(rows.length * 0.2)));
  const bot = sorted.slice(-Math.max(1, Math.floor(rows.length * 0.2)));
  const topRate = top.reduce((s, r) => s + r.success, 0) / top.length;
  const botRate = bot.reduce((s, r) => s + r.success, 0) / bot.length;
  const medWin = q(rows.filter((r) => r.success).map((r) => r[name]), 0.5);
  const medFail = q(rows.filter((r) => !r.success).map((r) => r[name]), 0.5);
  return { name, topRate, botRate, lift: topRate / base, medWin, medFail };
}

const feats = ["winnerBuyers", "winnerFrac", "uniqueBuyers", "nTrades", "netSol", "vol", "buyRatio", "concentration", "snipers3s", "avgBuySize"];
const scored = feats.map(lift).sort((a, b) => b.lift - a.lift);
console.log(`══ FEATURE LIFT (first ${EARLY_MS/1000}s) ──  base ${(base*100).toFixed(1)}% ════════════════`);
console.log(`  feature          topQ%   botQ%   lift   median win / fail`);
for (const s of scored) {
  console.log(
    "  " + s.name.padEnd(15) +
    `${(s.topRate*100).toFixed(1).padStart(5)}  ${(s.botRate*100).toFixed(1).padStart(5)}  ` +
    `${s.lift.toFixed(2).padStart(5)}x  ${Number(s.medWin).toFixed(2)} / ${Number(s.medFail).toFixed(2)}`
  );
}
console.log(`\n  lift > 1 = feature high → more likely to win. Biggest lift = strongest`);
console.log(`  "good to buy" signal. (winner-wallet features carry mild leakage — if`);
console.log(`  they dominate, we validate them time-split next.)\n`);
