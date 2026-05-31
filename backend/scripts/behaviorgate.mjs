/**
 * behaviorgate.mjs — validate "early large buy" as a standalone detection signal,
 * independent of any known gang wallet list.
 *
 * Hypothesis: tokens that receive a large SOL buy (≥N SOL) BEFORE reaching
 * 18k MC are disproportionately likely to reach 30k+ MC (migration zone).
 *
 * We test thresholds 3, 5, 7, 10 SOL against the full historical dataset.
 *
 * Usage: node --max-old-space-size=2048 scripts/behaviorgate.mjs
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_ROOT = path.resolve(__dirname, "..", "exports");
const TRADES_FILE = path.join(EXPORTS_ROOT, "pumpfundata-pump_fun", "trades.jsonl");

const PRE_BUNDLE_MC   = 18_000;  // "accumulation" phase ends here
const SUCCESS_MC      = 30_000;  // must reach this to be a "runner"
const MIN_TRADES      = 5;       // ignore micro-tokens with <5 trades total
const THRESHOLDS      = [3, 5, 7, 10]; // SOL buy sizes to test

console.log("behaviorgate.mjs — streaming 14GB trades.jsonl");
console.log("Testing early large-buy signal as standalone detector\n");

// per-mint accumulator (streaming, O(n) memory)
// We only keep: {maxPreBundleBuy, peakMc, totalTrades, preBundleTrades, preBundleBuyCount}
const mints = new Map(); // mint -> {maxEarlyBuy, peakMc, totalTrades, earlyBuys}

let lineCount = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(TRADES_FILE),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  lineCount++;
  if (lineCount % 5_000_000 === 0) {
    process.stdout.write(`  Scanned ${(lineCount/1e6).toFixed(0)}M lines  mints tracked: ${mints.size}\r`);
  }

  let row;
  try { row = JSON.parse(line); } catch { continue; }

  const mint  = row.mint ?? row.token;
  const sol   = Number(row.amount_sol ?? row.sol ?? 0);
  const mc    = Number(row.market_cap ?? row.mc ?? row.usd_market_cap ?? 0);
  const isBuy = row.is_buy !== false && row.is_buy !== 0 && row.side !== "sell";

  if (!mint || !isBuy) continue;

  if (!mints.has(mint)) mints.set(mint, { maxEarlyBuy: 0, peakMc: 0, totalTrades: 0, earlyBuys: 0 });
  const m = mints.get(mint);
  m.totalTrades++;
  if (mc > m.peakMc) m.peakMc = mc;
  if (mc < PRE_BUNDLE_MC || mc === 0) {
    m.earlyBuys++;
    if (sol > m.maxEarlyBuy) m.maxEarlyBuy = sol;
  }
}

console.log(`\n\nDone scanning. ${(lineCount/1e6).toFixed(1)}M lines, ${mints.size.toLocaleString()} unique mints\n`);

// Filter to tokens with enough trades to be meaningful
const qualified = [...mints.values()].filter(m => m.totalTrades >= MIN_TRADES);
console.log(`Tokens with ≥${MIN_TRADES} buys: ${qualified.length.toLocaleString()}\n`);

// Baseline: what % of ALL tokens reach SUCCESS_MC?
const baselineRunners = qualified.filter(m => m.peakMc >= SUCCESS_MC).length;
const baselineRate = (baselineRunners / qualified.length * 100).toFixed(1);
console.log(`Baseline (all tokens): ${baselineRunners.toLocaleString()} / ${qualified.length.toLocaleString()} reach $${(SUCCESS_MC/1000).toFixed(0)}k+  (${baselineRate}%)\n`);

// Test each threshold
console.log("─".repeat(72));
console.log("Threshold  │  Tokens triggered  │  Win rate  │  vs baseline  │  Precision");
console.log("─".repeat(72));

for (const thresh of THRESHOLDS) {
  const triggered = qualified.filter(m => m.maxEarlyBuy >= thresh);
  const winners   = triggered.filter(m => m.peakMc >= SUCCESS_MC);
  const rate      = triggered.length ? (winners.length / triggered.length * 100) : 0;
  const lift      = (rate / Number(baselineRate)).toFixed(1);
  const precision = winners.length / triggered.length * 100;

  console.log(
    `≥${thresh.toString().padEnd(8)} │  ` +
    `${triggered.length.toString().padStart(8)} triggered  │  ` +
    `${rate.toFixed(1).padStart(5)}%   │  ` +
    `${lift}×            │  ` +
    `${precision.toFixed(1)}% win`
  );
}

console.log("─".repeat(72));

// Also test combined signals
console.log("\nCombined signals:");
console.log("─".repeat(72));
for (const thresh of [5, 7]) {
  for (const minEarlyBuys of [1, 2, 3]) {
    const triggered = qualified.filter(m => m.maxEarlyBuy >= thresh && m.earlyBuys >= minEarlyBuys);
    const winners   = triggered.filter(m => m.peakMc >= SUCCESS_MC);
    const rate      = triggered.length ? (winners.length / triggered.length * 100) : 0;
    const lift      = (rate / Number(baselineRate)).toFixed(1);
    console.log(
      `≥${thresh}◎ buy AND ≥${minEarlyBuys} early buys  │  ` +
      `${triggered.length.toString().padStart(8)} triggered  │  ` +
      `${rate.toFixed(1).padStart(5)}%  │  ${lift}× lift`
    );
  }
}

// Distribution of maxEarlyBuy for runners vs non-runners
console.log("\nDistribution: maxEarlyBuy SOL for runners vs duds");
console.log("─".repeat(60));
const runners = qualified.filter(m => m.peakMc >= SUCCESS_MC);
const duds = qualified.filter(m => m.peakMc < SUCCESS_MC);

const buckets = [0, 1, 2, 3, 5, 7, 10, 20, 999];
for (let i = 0; i < buckets.length - 1; i++) {
  const lo = buckets[i], hi = buckets[i+1];
  const rCount = runners.filter(m => m.maxEarlyBuy >= lo && m.maxEarlyBuy < hi).length;
  const dCount = duds.filter(m => m.maxEarlyBuy >= lo && m.maxEarlyBuy < hi).length;
  const total = rCount + dCount;
  const winRate = total ? (rCount / total * 100).toFixed(0) : "—";
  const label = hi === 999 ? `≥${lo}◎` : `${lo}-${hi}◎`;
  console.log(`${label.padEnd(10)} │ runners: ${rCount.toString().padStart(6)}  duds: ${dCount.toString().padStart(7)}  win%: ${winRate}%`);
}

// Show some examples at the 5+ threshold to sanity check
console.log("\nSample high-confidence tokens (≥7◎ early buy, peaked ≥30k):");
const examples = qualified.filter(m => m.maxEarlyBuy >= 7 && m.peakMc >= SUCCESS_MC)
  .sort((a, b) => b.peakMc - a.peakMc).slice(0, 10);
for (const m of examples) {
  console.log(`  maxEarlyBuy=${m.maxEarlyBuy.toFixed(2)}◎  peakMc=$${Math.round(m.peakMc).toLocaleString()}  earlyBuys=${m.earlyBuys}  totalTrades=${m.totalTrades}`);
}

console.log("\nDone.");
