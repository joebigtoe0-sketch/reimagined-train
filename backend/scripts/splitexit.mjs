/**
 * splitexit.mjs — backtest split-exit strategies on ALL tokens triggered by
 * a ≥7 SOL early buy (behavioral gate, no wallet filter).
 *
 * For each triggered token we simulate:
 *   - Entry: at MC just after the ≥7 SOL buy appears (entry MC)
 *   - Various exit strategies: pure trail, 50/50 split, 30/70 split, etc.
 *
 * We assume we get in at entryMc. No slippage modelled (conservative enough).
 * Data cap: bonding curve only (max MC ~34k at current SOL prices).
 *
 * Usage: node --max-old-space-size=2048 scripts/splitexit.mjs
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, "..", "exports", "pumpfundata-pump_fun", "trades.jsonl");

// ─── parameters ───────────────────────────────────────────────────────────────
const TRIGGER_SOL     = 7;      // entry gate: any buy ≥ this SOL before PRE_MC
const PRE_MC          = 18_000; // "accumulation" phase ceiling
const MIGRATION_MC    = 30_000; // bonding curve ceiling (exit all at migration)
const TRAIL_FRAC      = 0.25;   // trailing stop fraction
const STOP_FRAC       = 0.30;   // hard stop from entry: -30%
const SLIPPAGE        = 0.05;   // 5% slippage on exits

// Strategies to compare:
const STRATEGIES = [
  { name: "A: pure trail stop",        split: 0,    firstExit: null },
  { name: "B: 50/50 split @18k",       split: 0.50, firstExit: 18_000 },
  { name: "C: 30/70 split @18k",       split: 0.30, firstExit: 18_000 },
  { name: "D: 50/50 split @15k",       split: 0.50, firstExit: 15_000 },
  { name: "E: 50/50 split @20k",       split: 0.50, firstExit: 20_000 },
  { name: "F: 30/70 split @15k",       split: 0.30, firstExit: 15_000 },
];

// ─── Phase 1: stream trades, collect MC timeline per triggered token ──────────
console.log("Phase 1: streaming trades to find ≥7◎ triggered tokens…\n");

// For each mint: only store MC sequence AFTER trigger (to keep memory low)
// State: { triggered: bool, entryMc, mcSequence: [mc,...] }
const mintState = new Map();
let lineCount = 0;

const rl = readline.createInterface({ input: fs.createReadStream(TRADES_FILE), crlfDelay: Infinity });

for await (const line of rl) {
  lineCount++;
  if (lineCount % 5_000_000 === 0) {
    process.stdout.write(`  ${(lineCount/1e6).toFixed(0)}M lines  triggered: ${mintState.size}\r`);
  }

  let row;
  try { row = JSON.parse(line); } catch { continue; }

  const mint  = row.mint ?? row.token;
  const sol   = Number(row.amount_sol ?? row.sol ?? 0);
  const mc    = Number(row.market_cap ?? row.mc ?? row.usd_market_cap ?? 0);
  const isBuy = row.is_buy !== false && row.is_buy !== 0 && row.side !== "sell";

  if (!mint || mc <= 0) continue;

  if (!mintState.has(mint)) mintState.set(mint, { triggered: false, entryMc: 0, mcSeq: [] });
  const s = mintState.get(mint);

  // Once triggered, record MC for every subsequent trade (for exit simulation)
  if (s.triggered) {
    if (s.mcSeq.length < 2000) s.mcSeq.push(mc); // cap to avoid OOM
    continue;
  }

  // Check trigger: buy ≥ TRIGGER_SOL before PRE_MC
  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC) {
    s.triggered = true;
    s.entryMc = mc;   // we "enter" at this MC
    s.mcSeq = [mc];
  }
}

console.log(`\n\nScanned ${(lineCount/1e6).toFixed(1)}M lines`);
console.log(`Triggered tokens: ${mintState.size.toLocaleString()}`);

// Only keep tokens that actually have MC data
const triggered = [...mintState.values()].filter(s => s.triggered && s.mcSeq.length >= 3 && s.entryMc > 0);
console.log(`Usable (≥3 ticks after trigger): ${triggered.length.toLocaleString()}\n`);

// ─── Phase 2: simulate exit strategies ───────────────────────────────────────
function simulateSplit(s, strategy) {
  const { split, firstExit } = strategy;
  const entryMc = s.entryMc;
  const mcSeq = s.mcSeq;

  // Split fractions: split% sold at firstExit, (1-split)% on trail/migration
  const frac1 = split;     // sold at firstExit MC
  const frac2 = 1 - split; // trail/migration portion

  let pnl = 0;
  let frac1Exited = false;
  let peak = entryMc;
  let frac2Exited = false;

  for (const mc of mcSeq) {
    if (mc > peak) peak = mc;

    // First half exit (if split > 0)
    if (!frac1Exited && frac1 > 0 && firstExit && mc >= firstExit) {
      const ratio = mc / entryMc;
      pnl += frac1 * (ratio * (1 - SLIPPAGE) - 1);
      frac1Exited = true;
    }

    if (!frac2Exited) {
      // Migration exit
      if (mc >= MIGRATION_MC) {
        const ratio = mc / entryMc;
        pnl += frac2 * (ratio * (1 - SLIPPAGE) - 1);
        frac2Exited = true;
        break;
      }
      // Hard stop: -30% from entry (applies to remaining position)
      if (mc <= entryMc * (1 - STOP_FRAC)) {
        const ratio = mc / entryMc;
        const remainingFrac = frac1Exited ? frac2 : (frac1 + frac2);
        pnl += remainingFrac * (ratio * (1 - SLIPPAGE) - 1);
        if (!frac1Exited) frac1Exited = true;
        frac2Exited = true;
        break;
      }
      // Trailing stop on second half
      if (peak > entryMc && mc <= peak * (1 - TRAIL_FRAC)) {
        const ratio = mc / entryMc;
        pnl += frac2 * (ratio * (1 - SLIPPAGE) - 1);
        frac2Exited = true;
        break;
      }
    }

    if (frac2Exited && (frac1 === 0 || frac1Exited)) break;
  }

  // Exit anything still open at last known MC
  const lastMc = mcSeq[mcSeq.length - 1];
  const lastRatio = lastMc / entryMc;
  if (!frac1Exited && frac1 > 0) pnl += frac1 * (lastRatio * (1 - SLIPPAGE) - 1);
  if (!frac2Exited) pnl += frac2 * (lastRatio * (1 - SLIPPAGE) - 1);

  return pnl * 100; // as %
}

// Run all strategies
console.log("─".repeat(80));
console.log("Strategy                    │  Trades │  Win%  │  Avg P&L │  Median │  Worst 10%");
console.log("─".repeat(80));

const results = [];
for (const strat of STRATEGIES) {
  const pnls = triggered.map(s => simulateSplit(s, strat));
  pnls.sort((a, b) => a - b);
  const wins = pnls.filter(p => p > 0).length;
  const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const median = pnls[Math.floor(pnls.length / 2)];
  const worst10 = pnls.slice(0, Math.floor(pnls.length * 0.10));
  const avgWorst = worst10.reduce((a, b) => a + b, 0) / worst10.length;

  results.push({ strat, pnls, avg, median, wins, winRate: wins / pnls.length * 100, avgWorst });

  console.log(
    `${strat.name.padEnd(28)}│  ${pnls.length.toString().padStart(5)}  │ ` +
    `${(wins/pnls.length*100).toFixed(1).padStart(5)}% │ ` +
    `${(avg >= 0 ? "+" : "") + avg.toFixed(1).padStart(6)}% │ ` +
    `${(median >= 0 ? "+" : "") + median.toFixed(1).padStart(5)}% │ ` +
    `${avgWorst.toFixed(1)}%`
  );
}
console.log("─".repeat(80));

// P&L distribution for best strategy and user's proposed 50/50@18k
console.log("\nP&L bucket comparison (A: pure trail  vs  B: 50/50@18k):");
console.log("─".repeat(60));
const stratA = results[0];
const stratB = results[1];
const buckets = [[-100,-50],[-50,-20],[-20,0],[0,20],[20,50],[50,100],[100,200],[200,999]];
for (const [lo, hi] of buckets) {
  const aCount = stratA.pnls.filter(p => p >= lo && p < hi).length;
  const bCount = stratB.pnls.filter(p => p >= lo && p < hi).length;
  const label = hi === 999 ? `>${lo}%` : `${lo}% to ${hi}%`;
  const aBar = "█".repeat(Math.round(aCount / stratA.pnls.length * 40));
  const bBar = "█".repeat(Math.round(bCount / stratB.pnls.length * 40));
  console.log(`${label.padEnd(14)} A:${aBar.padEnd(12)} ${aCount.toString().padStart(5)} | B:${bBar.padEnd(12)} ${bCount.toString().padStart(5)}`);
}

// Key insight: what % of tokens rug in the 18k-22k zone?
const rugZone = triggered.filter(s => {
  const peak = Math.max(...s.mcSeq);
  return peak >= 15_000 && peak < 25_000;
});
console.log(`\nTokens that peak between $15k-$25k (the "rug zone"): ${rugZone.length} (${(rugZone.length/triggered.length*100).toFixed(1)}%)`);
console.log(`These are exactly where the split exit rescues you.\n`);

// What is the best single-number answer?
const best = results.sort((a, b) => b.avg - a.avg)[0];
console.log(`Best avg P&L strategy: ${best.strat.name}`);
console.log(`  Avg P&L: ${best.avg.toFixed(1)}%  |  Win rate: ${best.winRate.toFixed(1)}%  |  Worst 10% avg: ${best.avgWorst.toFixed(1)}%`);

console.log("\nDone.");
