/**
 * agegate.mjs — does the 20-second age gate improve P&L on the ≥7◎ bundle signal?
 *
 * For every mint triggered by a ≥7 SOL buy before 18k MC we record:
 *   - firstTradeTs: timestamp of the first trade we ever see for that mint
 *   - triggerTs:    timestamp of the ≥7 SOL buy
 *   - triggerDelay: triggerTs - firstTradeTs  (proxy for "token age at trigger")
 *
 * We then bucket outcomes by delay and compare win rates + avg P&L.
 * Exit sim: migration exit at 30k MC, 25% trailing stop, -30% hard stop.
 *
 * Usage: node --max-old-space-size=2048 scripts/agegate.mjs
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, "..", "exports", "pumpfundata-pump_fun", "trades.jsonl");

const TRIGGER_SOL  = 7;
const PRE_MC       = 18_000;
const MIGRATION_MC = 30_000;  // exit all at migration
const TRAIL_FRAC   = 0.25;    // 25% trailing stop
const STOP_FRAC    = 0.30;    // -30% hard stop from entry
const SLIPPAGE     = 0.05;

// Age buckets in seconds to compare
const AGE_BUCKETS = [5, 10, 20, 30, 60, 120, Infinity];

// ─── Phase 1: stream — collect firstTradeTs, triggerTs, entryMc, mcSeq ────────
console.log("Phase 1: streaming trades.jsonl …\n");

// mint → { firstTradeTs, triggered, triggerTs, entryMc, mcSeq }
const state = new Map();
let lineCount = 0;

const rl = readline.createInterface({ input: fs.createReadStream(TRADES_FILE), crlfDelay: Infinity });

for await (const line of rl) {
  lineCount++;
  if (lineCount % 5_000_000 === 0) {
    process.stdout.write(`  ${(lineCount/1e6).toFixed(0)}M lines  mints: ${state.size}\r`);
  }

  let row;
  try { row = JSON.parse(line); } catch { continue; }

  const mint  = row.mint ?? row.token;
  const sol   = Number(row.amount_sol ?? row.sol ?? 0);
  const mc    = Number(row.market_cap ?? row.mc ?? row.usd_market_cap ?? 0);
  const isBuy = row.is_buy !== false && row.is_buy !== 0 && row.side !== "sell";
  const ts    = row.ts ? new Date(row.ts).getTime() : 0;

  if (!mint || mc <= 0 || !ts) continue;

  if (!state.has(mint)) {
    state.set(mint, { firstTradeTs: ts, triggered: false, triggerTs: 0, entryMc: 0, mcSeq: [] });
  }
  const s = state.get(mint);

  // Track first-seen timestamp
  if (ts < s.firstTradeTs) s.firstTradeTs = ts;

  if (s.triggered) {
    if (s.mcSeq.length < 2000) s.mcSeq.push(mc);
    continue;
  }

  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC) {
    s.triggered  = true;
    s.triggerTs  = ts;
    s.entryMc    = mc;
    s.mcSeq      = [mc];
  }
}

console.log(`\nScanned ${(lineCount/1e6).toFixed(1)}M lines,  ${state.size.toLocaleString()} unique mints`);

const triggered = [...state.values()].filter(s => s.triggered && s.mcSeq.length >= 3 && s.entryMc > 0 && s.triggerTs > 0 && s.firstTradeTs > 0);
console.log(`Triggered with usable data: ${triggered.length.toLocaleString()}\n`);

// ─── Phase 2: simulate exit for each token ────────────────────────────────────
function simulate(s) {
  const { entryMc, mcSeq } = s;
  let peak = entryMc;
  for (const mc of mcSeq) {
    if (mc > peak) peak = mc;
    // Migration exit
    if (mc >= MIGRATION_MC) return (MIGRATION_MC / entryMc - 1) * (1 - SLIPPAGE);
    // Hard stop
    if (mc <= entryMc * (1 - STOP_FRAC)) return -STOP_FRAC * (1 - SLIPPAGE);
    // Trailing stop (only once we've moved up from entry)
    if (peak > entryMc && mc <= peak * (1 - TRAIL_FRAC)) {
      return (peak * (1 - TRAIL_FRAC) / entryMc - 1) * (1 - SLIPPAGE);
    }
  }
  // Position still open at end of data → use last MC
  const lastMc = mcSeq[mcSeq.length - 1];
  return (lastMc / entryMc - 1) * (1 - SLIPPAGE);
}

// Attach pnl + delay to each triggered token
for (const s of triggered) {
  s.delaySec = (s.triggerTs - s.firstTradeTs) / 1000;
  s.pnl      = simulate(s);
  s.reached  = s.mcSeq.some(mc => mc >= MIGRATION_MC);
}

// ─── Phase 3: print results bucketed by age gate ──────────────────────────────
console.log("Results by trigger delay (how old was token when ≥7◎ buy hit)");
console.log("─".repeat(82));
console.log("Delay bucket  │  Tokens  │  Win%  │  AvgPnL  │  MedianPnL  │  MigrationRate");
console.log("─".repeat(82));

let prev = 0;
for (const limitSec of AGE_BUCKETS) {
  const bucket = limitSec === Infinity
    ? triggered.filter(s => s.delaySec >= prev)
    : triggered.filter(s => s.delaySec >= prev && s.delaySec < limitSec);

  if (bucket.length === 0) { prev = limitSec; continue; }

  const wins       = bucket.filter(s => s.pnl > 0);
  const avgPnl     = bucket.reduce((a, s) => a + s.pnl, 0) / bucket.length;
  const sorted     = [...bucket].sort((a,b) => a.pnl - b.pnl);
  const medianPnl  = sorted[Math.floor(sorted.length / 2)].pnl;
  const migRate    = bucket.filter(s => s.reached).length / bucket.length * 100;
  const label      = limitSec === Infinity ? `≥${prev}s` : `${prev}–${limitSec}s`;

  console.log(
    `${label.padEnd(13)} │  ${bucket.length.toString().padStart(6)}  │  ${(wins.length/bucket.length*100).toFixed(1).padStart(4)}%  │  ${(avgPnl*100).toFixed(1).padStart(6)}%  │  ${(medianPnl*100).toFixed(1).padStart(9)}%  │  ${migRate.toFixed(1)}%`
  );
  prev = limitSec;
}

console.log("─".repeat(82));

// Summary: cumulative "if we gate at ≤N seconds"
console.log("\nCumulative — gate: only take triggers where delay ≤ N seconds");
console.log("─".repeat(72));
console.log("Gate   │  Tokens  │  Win%  │  AvgPnL  │  MedianPnL  │  vs no gate");
console.log("─".repeat(72));

const all = triggered;
const allAvg = all.reduce((a,s) => a + s.pnl, 0) / all.length;
const allWin = all.filter(s => s.pnl > 0).length / all.length * 100;

// No gate baseline
console.log(`no gate  │  ${all.length.toString().padStart(6)}  │  ${allWin.toFixed(1).padStart(4)}%  │  ${(allAvg*100).toFixed(1).padStart(6)}%  │  — baseline —`);

for (const limitSec of [10, 20, 30, 60]) {
  const subset = all.filter(s => s.delaySec <= limitSec);
  if (subset.length === 0) continue;
  const avg     = subset.reduce((a,s) => a + s.pnl, 0) / subset.length;
  const winPct  = subset.filter(s => s.pnl > 0).length / subset.length * 100;
  const sorted  = [...subset].sort((a,b) => a.pnl - b.pnl);
  const median  = sorted[Math.floor(sorted.length/2)].pnl;
  const lift    = ((avg / allAvg - 1) * 100).toFixed(1);
  const sign    = avg > allAvg ? "+" : "";
  console.log(
    `≤${limitSec.toString().padEnd(4)}s  │  ${subset.length.toString().padStart(6)}  │  ${winPct.toFixed(1).padStart(4)}%  │  ${(avg*100).toFixed(1).padStart(6)}%  │  ${(median*100).toFixed(1).padStart(9)}%  │  ${sign}${lift}% vs baseline`
  );
}

console.log("\nDone.");
