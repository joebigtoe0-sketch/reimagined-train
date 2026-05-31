/**
 * bundleexitstrat.mjs — find the optimal exit strategy for bundle-sniper tokens.
 *
 * Uses the same 417 qualifying trades (≥7 SOL gang wallet trigger) and simulates
 * multiple exit strategies side-by-side:
 *
 *   A: Sell all at 42k                      (current)
 *   B: Sell all at 60k
 *   C: Sell all at 80k
 *   D: Trail whole position (25% from peak)
 *   E: Sell 50% at 42k, trail 50% (25% trail)
 *   F: Sell 50% at 42k, sell 25% at 100k, trail 25%
 *   G: Sell 33% at 42k, 33% at 100k, trail 34%
 *
 * Also shows the peak MC distribution for runners so you can see
 * how high these actually go.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_ROOT = path.resolve(__dirname, "..", "exports");
const LIB_DIR = path.resolve(__dirname, "lib");

// Entry quality gate (validated by bundleswipe.mjs)
const MIN_TRIGGER_SOL = 7;
const SLIPPAGE = 0.03;       // 3% per side
const STOP_LOSS_FRAC = 0.70; // -30% stop (same as backtest)
const DEAD_WINDOW_MS = 10 * 60_000;
const TRAIL_FRAC = 0.25;     // 25% trailing stop from peak

const gangWallets = new Set(JSON.parse(fs.readFileSync(path.join(LIB_DIR, "gangWallets.json"), "utf8")));
const gangTokenList = JSON.parse(fs.readFileSync(path.join(LIB_DIR, "gangTokens.json"), "utf8"));
const gangMints = new Set(gangTokenList.map(t => t.mint));

// Load trades
const tradesByMint = new Map();
for (const m of gangMints) tradesByMint.set(m, []);

function parseMc(r) { return Number(r.market_cap ?? r.mc) || 0; }
function parseSol(r) { return Number(r.amount_sol ?? r.sol) || 0; }
function parseTs(r) {
  const v = r.ts ?? r.created_at;
  if (!v) return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  return Date.parse(String(v)) || 0;
}

async function streamJsonl(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRow(JSON.parse(line)); } catch { /* skip */ }
  }
}

const exportDirs = fs.existsSync(EXPORTS_ROOT)
  ? fs.readdirSync(EXPORTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("_"))
      .map(d => path.join(EXPORTS_ROOT, d.name))
      .filter(d => fs.existsSync(path.join(d, "trades.jsonl")))
  : [];

for (const dir of exportDirs) {
  process.stdout.write(`Loading ${path.basename(dir)} … `);
  let n = 0;
  await streamJsonl(path.join(dir, "trades.jsonl"), r => {
    const arr = tradesByMint.get(r.mint);
    if (!arr) return;
    n++;
    arr.push({ wallet: r.wallet, side: r.side, sol: parseSol(r), mc: parseMc(r), ts: parseTs(r) });
  });
  console.log(`${n} matching trades`);
}

for (const arr of tradesByMint.values()) arr.sort((a, b) => a.ts - b.ts);

// ─── find qualifying entries ───────────────────────────────────────────────
// entry = { entryIdx, entryMc, trades }
const entries = [];
for (const [, trades] of tradesByMint) {
  if (!trades.length) continue;
  const seenGang = new Set();
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (t.side !== "buy" || !gangWallets.has(t.wallet) || t.mc <= 0) continue;
    seenGang.add(t.wallet);
    if (t.sol >= MIN_TRIGGER_SOL) {
      entries.push({ entryIdx: i, entryMc: t.mc, trades });
      break;
    }
  }
}
console.log(`\nQualifying entries: ${entries.length}\n`);

// ─── peak MC distribution for qualifying entries ───────────────────────────
// Compute the max MC seen AFTER entry for each trade
const peakMcs = entries.map(({ entryIdx, trades }) => {
  let peak = 0;
  for (let i = entryIdx; i < trades.length; i++) {
    if (trades[i].mc > peak) peak = trades[i].mc;
  }
  return peak;
});

function countAbove(arr, threshold) { return arr.filter(v => v >= threshold).length; }
const n = entries.length;
console.log("─── Peak MC distribution (from entry onwards) ───────────────────────");
for (const thresh of [20_000, 30_000, 42_000, 50_000, 60_000, 80_000, 100_000, 150_000, 200_000, 300_000]) {
  const c = countAbove(peakMcs, thresh);
  console.log(`  ≥ $${String(thresh.toLocaleString()).padStart(8)}  : ${String(c).padStart(4)} / ${n}  (${(c/n*100).toFixed(1)}%)`);
}

// Distribution of peaks among the runners (tokens that reached ≥42k)
const runners = peakMcs.filter(p => p >= 42_000);
console.log(`\n  Of the ${runners.length} that hit ≥42k:`);
for (const thresh of [60_000, 80_000, 100_000, 150_000, 200_000, 300_000]) {
  const c = runners.filter(p => p >= thresh).length;
  console.log(`    ≥ $${String(thresh.toLocaleString()).padStart(8)}  : ${String(c).padStart(4)} / ${runners.length}  (${(c/runners.length*100).toFixed(1)}%)`);
}

// ─── simulate exit strategy ───────────────────────────────────────────────
// Returns { wins, losses, totalPnl, pnls[] }
function simulate(exitFn) {
  let wins = 0, losses = 0, totalPnl = 0;
  const pnls = [];
  for (const { entryIdx, entryMc, trades } of entries) {
    const stopMc = entryMc * STOP_LOSS_FRAC;
    const result = exitFn(trades, entryIdx, entryMc, stopMc);
    const pnl = result * (1 - SLIPPAGE) ** 2 - 1; // apply slippage to gross return
    totalPnl += pnl;
    pnls.push(pnl);
    if (pnl >= 0) wins++; else losses++;
  }
  return { wins, losses, totalPnl, pnls };
}

function stats(r) {
  const n2 = r.wins + r.losses;
  const sorted = [...r.pnls].sort((a,b) => a-b);
  return {
    n: n2,
    wr: (r.wins/n2*100).toFixed(1),
    avg: (r.totalPnl/n2*100).toFixed(1),
    med: (sorted[Math.floor(sorted.length/2)]*100).toFixed(1),
    p75: (sorted[Math.floor(sorted.length*0.75)]*100).toFixed(1),
    max: (sorted[sorted.length-1]*100).toFixed(0),
  };
}

// Shared exit simulation helper: processes trades after entry
// Returns gross exit MC ratio (before slippage)
function runTrades(trades, entryIdx, entryMc, stopMc, checkExit) {
  let peak = entryMc;
  let lastTs = trades[entryIdx].ts;
  for (let i = entryIdx + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.mc > peak) peak = t.mc;
    if (t.ts - lastTs > DEAD_WINDOW_MS) return { exitMc: t.mc > 0 ? t.mc : peak * 0.5, peak };
    lastTs = t.ts;
    if (t.mc > 0 && t.mc <= stopMc) return { exitMc: t.mc, peak };
    const result = checkExit(t.mc, peak);
    if (result !== null) return { exitMc: result, peak };
  }
  return { exitMc: trades[trades.length-1].mc || peak * 0.3, peak };
}

// ── Strategy definitions ─────────────────────────────────────────────────────

// A: Sell all at 42k
const stratA = simulate((trades, ei, entryMc, stopMc) => {
  const { exitMc } = runTrades(trades, ei, entryMc, stopMc, (mc) => mc >= 42_000 ? 42_000 : null);
  return exitMc / entryMc;
});

// B: Sell all at 60k
const stratB = simulate((trades, ei, entryMc, stopMc) => {
  const { exitMc } = runTrades(trades, ei, entryMc, stopMc, (mc) => mc >= 60_000 ? 60_000 : null);
  return exitMc / entryMc;
});

// C: Sell all at 80k
const stratC = simulate((trades, ei, entryMc, stopMc) => {
  const { exitMc } = runTrades(trades, ei, entryMc, stopMc, (mc) => mc >= 80_000 ? 80_000 : null);
  return exitMc / entryMc;
});

// D: Full trailing stop (no target, trail 25% from peak)
const stratD = simulate((trades, ei, entryMc, stopMc) => {
  let peak = entryMc;
  let lastTs = trades[ei].ts;
  for (let i = ei + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.mc > peak) peak = t.mc;
    if (t.ts - lastTs > DEAD_WINDOW_MS) return (t.mc || peak * 0.5) / entryMc;
    lastTs = t.ts;
    if (t.mc <= stopMc) return t.mc / entryMc;
    if (t.mc <= peak * (1 - TRAIL_FRAC)) return t.mc / entryMc;
  }
  return (trades[trades.length-1].mc || peak * 0.3) / entryMc;
});

// E: Sell 50% at 42k, trail remaining 50% (25% from peak)
const stratE = simulate((trades, ei, entryMc, stopMc) => {
  let half1Done = false;
  let half1Ratio = null;
  let peak = entryMc;
  let lastTs = trades[ei].ts;
  for (let i = ei + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.mc > peak) peak = t.mc;
    const dead = t.ts - lastTs > DEAD_WINDOW_MS;
    lastTs = t.ts;
    if (t.mc <= stopMc) {
      if (!half1Done) return t.mc / entryMc;
      return (half1Ratio + t.mc / entryMc) / 2;
    }
    if (dead) {
      const exitMc = t.mc || peak * 0.5;
      if (!half1Done) return exitMc / entryMc;
      return (half1Ratio + exitMc / entryMc) / 2;
    }
    if (!half1Done && t.mc >= 42_000) { half1Done = true; half1Ratio = 42_000 / entryMc; }
    if (half1Done && t.mc <= peak * (1 - TRAIL_FRAC)) {
      return (half1Ratio + t.mc / entryMc) / 2;
    }
  }
  const last = trades[trades.length-1].mc || peak * 0.3;
  if (!half1Done) return last / entryMc;
  return (half1Ratio + last / entryMc) / 2;
});

// F: Sell 50% at 42k, 25% at 100k, trail 25%
const stratF = simulate((trades, ei, entryMc, stopMc) => {
  let tranche = 0; // 0 = all in, 1 = first sold, 2 = second sold
  const exits = [];
  let peak = entryMc;
  let lastTs = trades[ei].ts;
  for (let i = ei + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.mc > peak) peak = t.mc;
    const dead = t.ts - lastTs > DEAD_WINDOW_MS;
    lastTs = t.ts;
    const exitAll = (mc) => {
      const remaining = 1 - exits.reduce((s, [,w]) => s + w, 0);
      exits.push([mc / entryMc, remaining]);
    };
    if (t.mc <= stopMc || dead) { exitAll(t.mc || peak * 0.5); break; }
    if (tranche === 0 && t.mc >= 42_000) { exits.push([42_000 / entryMc, 0.5]); tranche = 1; }
    if (tranche === 1 && t.mc >= 100_000) { exits.push([100_000 / entryMc, 0.25]); tranche = 2; }
    if (tranche >= 1 && t.mc <= peak * (1 - TRAIL_FRAC)) { exitAll(t.mc); break; }
  }
  if (!exits.length || exits.reduce((s,[,w])=>s+w,0) < 0.99) {
    const last = trades[trades.length-1].mc || peak * 0.3;
    const remaining = 1 - exits.reduce((s,[,w])=>s+w,0);
    if (remaining > 0) exits.push([last / entryMc, remaining]);
  }
  return exits.reduce((s, [ratio, weight]) => s + ratio * weight, 0);
});

// G: Sell 33% at 42k, 33% at 100k, trail 34%
const stratG = simulate((trades, ei, entryMc, stopMc) => {
  let tranche = 0;
  const exits = [];
  let peak = entryMc;
  let lastTs = trades[ei].ts;
  for (let i = ei + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.mc > peak) peak = t.mc;
    const dead = t.ts - lastTs > DEAD_WINDOW_MS;
    lastTs = t.ts;
    const exitAll = (mc) => {
      const remaining = 1 - exits.reduce((s, [,w]) => s + w, 0);
      if (remaining > 0.001) exits.push([mc / entryMc, remaining]);
    };
    if (t.mc <= stopMc || dead) { exitAll(t.mc || peak * 0.5); break; }
    if (tranche === 0 && t.mc >= 42_000) { exits.push([42_000 / entryMc, 0.333]); tranche = 1; }
    if (tranche === 1 && t.mc >= 100_000) { exits.push([100_000 / entryMc, 0.333]); tranche = 2; }
    if (tranche >= 1 && t.mc <= peak * (1 - TRAIL_FRAC)) { exitAll(t.mc); break; }
  }
  if (!exits.length || exits.reduce((s,[,w])=>s+w,0) < 0.99) {
    const last = trades[trades.length-1].mc || peak * 0.3;
    const remaining = 1 - exits.reduce((s,[,w])=>s+w,0);
    if (remaining > 0) exits.push([last / entryMc, remaining]);
  }
  return exits.reduce((s, [ratio, weight]) => s + ratio * weight, 0);
});

// ─── print results ─────────────────────────────────────────────────────────
console.log("\n─── Exit Strategy Comparison ──────────────────────────────────────────");
console.log("Strategy                        n     WR%   avgPnL%  median%  p75%   maxWin%");
console.log("──────────────────────────────────────────────────────────────────────────");

const rows = [
  ["A: Sell all @ 42k", stratA],
  ["B: Sell all @ 60k", stratB],
  ["C: Sell all @ 80k", stratC],
  ["D: Full 25% trail", stratD],
  ["E: 50%@42k + trail 50%", stratE],
  ["F: 50%@42k+25%@100k+trail", stratF],
  ["G: 33%@42k+33%@100k+trail", stratG],
];

for (const [name, r] of rows) {
  const s = stats(r);
  console.log(
    `${name.padEnd(32)} ${String(s.n).padStart(4)}  ${String(s.wr).padStart(5)}%  ${String(s.avg).padStart(8)}%  ${String(s.med).padStart(7)}%  ${String(s.p75).padStart(5)}%  ${String(s.max).padStart(7)}%`
  );
}

// ─── signs a token will continue higher ────────────────────────────────────
// Look at tokens that hit 42k: what was happening in the trades just BEFORE 42k?
// Compare the ones that went to 100k+ vs those that stopped between 42k-60k.
console.log("\n─── Signals at 42k: continued vs stalled ───────────────────────────────");

const reached42k = entries.filter(({ entryIdx, trades }) => {
  for (let i = entryIdx; i < trades.length; i++) if (trades[i].mc >= 42_000) return true;
  return false;
});

function windowBefore(trades, threshold, windowTrades = 10) {
  // Find the first trade >= threshold, then look at the N trades before it
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].mc >= threshold) {
      const start = Math.max(0, i - windowTrades);
      const window = trades.slice(start, i + 1);
      const buys = window.filter(t => t.side === "buy");
      const sells = window.filter(t => t.side === "sell");
      const buyVol = buys.reduce((s, t) => s + t.sol, 0);
      const sellVol = sells.reduce((s, t) => s + t.sol, 0);
      const avgTimeBtwTrades = window.length > 1
        ? (window[window.length-1].ts - window[0].ts) / (window.length - 1) / 1000
        : 999;
      return { buys: buys.length, sells: sells.length, buyVol, sellVol, avgTimeBtwTrades };
    }
  }
  return null;
}

const continued = reached42k.filter(({ entryIdx, trades }) => {
  for (let i = entryIdx; i < trades.length; i++) if (trades[i].mc >= 100_000) return true;
  return false;
});
const stalled = reached42k.filter(({ entryIdx, trades }) => {
  let peak = 0;
  for (let i = entryIdx; i < trades.length; i++) if (trades[i].mc > peak) peak = trades[i].mc;
  return peak >= 42_000 && peak < 100_000;
});

function avgStat(arr, fn) { return arr.length ? arr.reduce((s,v) => s + fn(v), 0) / arr.length : 0; }

const contWindows = continued.map(e => windowBefore(e.trades, 42_000)).filter(Boolean);
const stallWindows = stalled.map(e => windowBefore(e.trades, 42_000)).filter(Boolean);

console.log(`  Tokens reaching 100k+ : ${continued.length}`);
console.log(`  Tokens stalling 42-100k: ${stalled.length}`);
if (contWindows.length && stallWindows.length) {
  console.log(`\n  In the 10 trades BEFORE hitting 42k:`);
  console.log(`                         continued(${continued.length})  stalled(${stalled.length})`);
  console.log(`  Avg buys in window  :  ${avgStat(contWindows,w=>w.buys).toFixed(1)}         ${avgStat(stallWindows,w=>w.buys).toFixed(1)}`);
  console.log(`  Avg sells in window :  ${avgStat(contWindows,w=>w.sells).toFixed(1)}         ${avgStat(stallWindows,w=>w.sells).toFixed(1)}`);
  console.log(`  Avg buy vol (SOL)   :  ${avgStat(contWindows,w=>w.buyVol).toFixed(2)}      ${avgStat(stallWindows,w=>w.buyVol).toFixed(2)}`);
  console.log(`  Avg sell vol (SOL)  :  ${avgStat(contWindows,w=>w.sellVol).toFixed(2)}      ${avgStat(stallWindows,w=>w.sellVol).toFixed(2)}`);
  console.log(`  Avg sec/trade       :  ${avgStat(contWindows,w=>w.avgTimeBtwTrades).toFixed(1)}s       ${avgStat(stallWindows,w=>w.avgTimeBtwTrades).toFixed(1)}s`);
}

console.log("\nDone.\n");
