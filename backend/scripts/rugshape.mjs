/**
 * rugshape.mjs — CRITICAL validation. Does a trailing stop actually work on these
 * tokens, or do they die in a single atomic dump (team sells everything in 1 tx →
 * price ~0 same candle) that we can't react to?
 *
 * For each Jito-bundle token we examine the bonding-curve trade trajectory and ask:
 *   1. When the token declines, is it GRADUAL (many trades down → trail catches ~75%
 *      of peak) or ATOMIC (one trade from high MC to near 0 → we eat the full drop)?
 *   2. What's the largest single-trade MC drop, as % of the pre-drop MC?
 *   3. Compares REALISTIC exit (fill at the actual next-trade price after the stop
 *      triggers — captures atomic dumps) vs IDEAL exit (assume perfect fill at the
 *      stop level). Big gap = dumps are atomic and hurt us.
 *
 * Usage: node --max-old-space-size=2048 scripts/rugshape.mjs
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, "..", "exports", "pumpfundata-pump_fun", "trades.jsonl");

const TRIGGER_SOL = 7;
const PRE_MC      = 18_000;
const ENTRY_SOL   = 0.4;
const SLIP        = 0.05;
const TRAIL       = 0.25;
const HARD        = 0.30;

const state = new Map();
let lineCount = 0;
const rl = readline.createInterface({ input: fs.createReadStream(TRADES_FILE), crlfDelay: Infinity });

for await (const line of rl) {
  lineCount++;
  if (lineCount % 5_000_000 === 0) process.stdout.write(`  ${(lineCount/1e6).toFixed(0)}M\r`);
  let row; try { row = JSON.parse(line); } catch { continue; }
  const mint   = row.mint ?? row.token;
  const sol    = Number(row.amount_sol ?? 0);
  const mc     = Number(row.market_cap ?? row.usd_market_cap ?? 0);
  const isBuy  = row.side !== "sell" && row.is_buy !== false;
  const ts     = row.ts ? new Date(row.ts).getTime() : 0;
  const wallet = row.wallet ?? row.traderPublicKey ?? "";
  if (!mint || !ts || mc <= 0) continue;

  if (!state.has(mint)) {
    state.set(mint, { firstTs: ts, devWallet: wallet, triggered: false, entryMc: 0, seq: [] });
  }
  const s = state.get(mint);
  if (ts < s.firstTs) { s.firstTs = ts; s.devWallet = wallet; }
  if (s.triggered) { if (s.seq.length < 8000) s.seq.push(mc); continue; }
  const ageMs = ts - s.firstTs;
  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC && ageMs <= 1000 && wallet !== s.devWallet) {
    s.triggered = true; s.entryMc = mc; s.seq = [mc];
  }
}
console.log(`\nScanned ${(lineCount/1e6).toFixed(1)}M lines`);

const trig = [...state.values()].filter(s => s.triggered && s.entryMc > 0 && s.seq.length >= 3);
console.log(`Jito-bundle tokens: ${trig.length.toLocaleString()}\n`);

// Realistic stop: fill at the actual trade MC that breaches the stop level.
// Ideal stop: assume perfect fill exactly at the stop level (peak*0.75 or entry*0.70).
function exits(s) {
  let peak = s.entryMc;
  let realistic = s.seq[s.seq.length-1];
  let ideal = s.seq[s.seq.length-1];
  let triggered = false;
  for (const mc of s.seq) {
    if (mc > peak) peak = mc;
    const trailLvl = peak * (1 - TRAIL);
    const hardLvl  = s.entryMc * (1 - HARD);
    const lvl = Math.max(trailLvl, hardLvl);  // whichever stop is higher binds first
    if ((peak > s.entryMc && mc <= trailLvl) || mc <= hardLvl) {
      realistic = mc;          // we actually fill at this (possibly dumped) price
      ideal     = lvl;         // optimistic: fill right at the stop line
      triggered = true;
      break;
    }
  }
  return { realistic, ideal, triggered, peak };
}

// Largest single-trade drop as fraction of the pre-drop value
function maxDrop(s) {
  let worst = 0;
  for (let i = 1; i < s.seq.length; i++) {
    const prev = s.seq[i-1], cur = s.seq[i];
    if (prev <= 0) continue;
    const drop = (prev - cur) / prev;
    if (drop > worst) worst = drop;
  }
  return worst;
}

let atomic = 0, gradual = 0;
let realTot = 0, idealTot = 0;
const realLosers = [];
const dropBuckets = { "<30%":0, "30-50%":0, "50-70%":0, "70-90%":0, ">90%":0 };

for (const s of trig) {
  const { realistic, ideal } = exits(s);
  const rFrac = (realistic/s.entryMc)*(1-SLIP)*(1-SLIP) - 1;
  const iFrac = (ideal/s.entryMc)*(1-SLIP)*(1-SLIP) - 1;
  realTot  += ENTRY_SOL * rFrac;
  idealTot += ENTRY_SOL * iFrac;
  if (rFrac <= 0) realLosers.push(rFrac);

  const d = maxDrop(s);
  if      (d < 0.30) dropBuckets["<30%"]++;
  else if (d < 0.50) dropBuckets["30-50%"]++;
  else if (d < 0.70) dropBuckets["50-70%"]++;
  else if (d < 0.90) dropBuckets["70-90%"]++;
  else               dropBuckets[">90%"]++;

  if (d >= 0.70) atomic++; else gradual++;
}

console.log("═══ RUG SHAPE: largest single-trade MC drop per token ═══");
for (const [k,v] of Object.entries(dropBuckets)) {
  console.log(`  drop ${k.padEnd(6)}: ${String(v).padStart(5)}  (${(v/trig.length*100).toFixed(1)}%)  ${"█".repeat(Math.round(v/trig.length*40))}`);
}
console.log(`\n  Tokens with a ≥70% single-trade drop (ATOMIC dump): ${atomic} (${(atomic/trig.length*100).toFixed(1)}%)`);
console.log(`  Tokens that decline gradually (<70% max drop)     : ${gradual} (${(gradual/trig.length*100).toFixed(1)}%)`);

console.log("\n═══ Does the trailing stop actually fill near its level? ═══");
console.log(`  REALISTIC exit (fill at actual dumped price) : total ${realTot.toFixed(0)} SOL`);
console.log(`  IDEAL exit (perfect fill at stop line)       : total ${idealTot.toFixed(0)} SOL`);
console.log(`  Gap (slippage we eat from atomic dumps)      : ${(idealTot-realTot).toFixed(0)} SOL (${((idealTot-realTot)/idealTot*100).toFixed(1)}% of ideal)`);

// Realistic loser distribution: are losers -30% (caught) or -90% (ate the dump)?
realLosers.sort((a,b)=>a-b);
const lb = { "-100 to -70%":0, "-70 to -50%":0, "-50 to -30%":0, "-30 to 0%":0 };
for (const f of realLosers) {
  const p = f*100;
  if      (p < -70) lb["-100 to -70%"]++;
  else if (p < -50) lb["-70 to -50%"]++;
  else if (p < -30) lb["-50 to -30%"]++;
  else              lb["-30 to 0%"]++;
}
console.log("\n═══ LOSER exit distribution (realistic fills) ═══");
console.log(`  ${realLosers.length} losing trades:`);
for (const [k,v] of Object.entries(lb)) {
  console.log(`    ${k.padEnd(14)}: ${String(v).padStart(5)}  (${(v/realLosers.length*100).toFixed(1)}%)`);
}
const avgLoser = realLosers.reduce((a,b)=>a+b,0)/realLosers.length*100;
console.log(`  Avg loser PnL: ${avgLoser.toFixed(1)}%  (if this is ~ -30%, the hard stop catches dumps; if ~ -80%, we eat them)`);
console.log("\nDone.\n");
