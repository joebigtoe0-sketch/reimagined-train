/**
 * countandride.mjs — Clean counts in $83 SOL terms + test the "ride winners to
 * migration (and beyond)" thesis.
 *
 * All MC shown in REAL $83 terms (data was recorded at $150, factor 0.5533).
 * Realistic entry = first trade ~2s after the bundle (post-bundle price).
 *
 * Reports:
 *   1. Total tokens matching (bundle + ≥7 SOL buy)
 *   2. How many reach bonding/migration (data ends there)
 *   3. Rug-level distribution for the rest (real $83 MC)
 *   4. "Ride to migration" PnL + breakeven post-migration multiple
 *
 * Usage: node --max-old-space-size=2048 scripts/countandride.mjs
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
const HARD        = 0.30;
const ENTRY_DELAY = 2000;        // realistic detection+fill delay
const MIG_DATA    = 60_000;      // bonding-curve completion (data $150 terms)
const R           = 83 / 150;    // data($150) → real($83) conversion

const usd83 = (dataMc) => Math.round(dataMc * R);

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
    state.set(mint, { firstTs: ts, devWallet: wallet, triggered: false, triggerTs: 0, peakMc: 0, seq: [] });
  }
  const s = state.get(mint);
  if (ts < s.firstTs) { s.firstTs = ts; s.devWallet = wallet; }
  if (mc > s.peakMc) s.peakMc = mc;
  if (s.triggered) { if (s.seq.length < 8000) s.seq.push({ dt: ts - s.triggerTs, mc }); continue; }
  const ageMs = ts - s.firstTs;
  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC && ageMs <= 1000 && wallet !== s.devWallet) {
    s.triggered = true; s.triggerTs = ts; s.seq = [{ dt: 0, mc }];
  }
}
console.log(`\nScanned ${(lineCount/1e6).toFixed(1)}M lines`);

const trig = [...state.values()].filter(s => s.triggered && s.seq.length >= 3);
// realistic entry
for (const s of trig) {
  s.entryMc = (s.seq.find(e => e.dt >= ENTRY_DELAY) ?? s.seq[s.seq.length-1]).mc;
  s.migrated = s.peakMc >= MIG_DATA;
}
const valid = trig.filter(s => s.entryMc > 0);

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  COUNTS (real $83 SOL terms; entry ≈ post-bundle T+2s)`);
console.log(`══════════════════════════════════════════════════════════════════`);
const avgEntry = valid.reduce((a,s)=>a+s.entryMc,0)/valid.length;
console.log(`  1. Total tokens matching (bundle + ≥7 SOL buy) : ${valid.length.toLocaleString()}`);
const migrated = valid.filter(s => s.migrated);
console.log(`  2. Reached bonding/migration (~$34k real)      : ${migrated.length.toLocaleString()}  (${(migrated.length/valid.length*100).toFixed(1)}%)`);
console.log(`     (data ends at migration; real upside beyond is invisible here)`);
console.log(`     Avg realistic entry: $${usd83(avgEntry).toLocaleString()} real  ($${Math.round(avgEntry).toLocaleString()} in data)`);

// 3. Rug-level distribution (non-migrated), by REAL peak MC
console.log(`\n  3. RUG LEVELS — where the ${(valid.length-migrated.length).toLocaleString()} non-migrated tokens peaked (real $83 MC):`);
const rugs = valid.filter(s => !s.migrated);
const rb = [
  ["peak < $8k",       s => usd83(s.peakMc) < 8000],
  ["$8k – $12k",       s => usd83(s.peakMc) >= 8000  && usd83(s.peakMc) < 12000],
  ["$12k – $15k",      s => usd83(s.peakMc) >= 12000 && usd83(s.peakMc) < 15000],
  ["$15k – $20k",      s => usd83(s.peakMc) >= 20000*0+15000 && usd83(s.peakMc) < 20000],
  ["$20k – $25k",      s => usd83(s.peakMc) >= 20000 && usd83(s.peakMc) < 25000],
  ["$25k – $34k",      s => usd83(s.peakMc) >= 25000 && usd83(s.peakMc) < 34000],
];
for (const [label, fn] of rb) {
  const g = rugs.filter(fn);
  console.log(`     ${label.padEnd(16)}: ${String(g.length).padStart(5)}  (${(g.length/valid.length*100).toFixed(1)}% of all)`);
}
const avgRugPeak = rugs.reduce((a,s)=>a+usd83(s.peakMc),0)/rugs.length;
console.log(`     Avg rug peak: $${Math.round(avgRugPeak).toLocaleString()} real   (vs our ~$${usd83(avgEntry).toLocaleString()} entry)`);
const rugAboveEntry = rugs.filter(s => s.peakMc > s.entryMc).length;
console.log(`     Rugs that NEVER traded above our entry: ${rugs.length - rugAboveEntry} (${((rugs.length-rugAboveEntry)/rugs.length*100).toFixed(1)}% of rugs) → instant losers`);

// 4. RIDE-TO-MIGRATION strategy from realistic entry
//    Exit: sell at migration price if it migrates; else hard-stop at -30% (realistic fill); else hold to end.
function rideExit(s) {
  let exit = s.seq[s.seq.length-1].mc;
  for (const e of s.seq) {
    if (e.dt < ENTRY_DELAY) continue;
    if (e.mc >= MIG_DATA) return { mc: e.mc, mig: true };          // sell at migration
    if (e.mc <= s.entryMc * (1 - HARD)) return { mc: e.mc, mig: false }; // hard stop
    exit = e.mc;
  }
  return { mc: exit, mig: false };
}

let tot = 0, wins = 0, migSold = 0;
let migGainSol = 0, loserLossSol = 0;
for (const s of valid) {
  const { mc: exitMc, mig } = rideExit(s);
  const f = (exitMc/s.entryMc)*(1-SLIP)*(1-SLIP) - 1;
  tot += ENTRY_SOL * f;
  if (f > 0) wins++;
  if (mig) { migSold++; migGainSol += ENTRY_SOL * f; }
  else loserLossSol += ENTRY_SOL * f;
}
console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  4. "RIDE TO MIGRATION" strategy (sell at migration, hard-stop losers)`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  Trades: ${valid.length}   Win rate: ${(wins/valid.length*100).toFixed(1)}%`);
console.log(`  Sold at migration: ${migSold}  → +${migGainSol.toFixed(0)} SOL`);
console.log(`  Everyone else    : ${valid.length-migSold}  → ${loserLossSol.toFixed(0)} SOL`);
console.log(`  NET (selling at migration, no post-migration upside): ${tot>=0?"+":""}${tot.toFixed(0)} SOL / month`);

// Breakeven: what avg post-migration multiple on migrated tokens makes NET = 0 and profitable?
const lossesOnly = loserLossSol;                       // negative
const migSoldCount = migSold;
// if migrated tokens are sold at migration×M instead of at migration:
//   migGain(M) = sum over migrated of ENTRY_SOL*((migMc*M/entry)*(0.9025) - 1)
// We approximate by scaling: gain scales ~linearly with M for the price part.
// Compute exact by re-walking migrated tokens with a post-migration multiplier.
function netWithMultiplier(M) {
  let t = 0;
  for (const s of valid) {
    const { mc: exitMc, mig } = rideExit(s);
    let fillMc = exitMc;
    if (mig) fillMc = MIG_DATA * M;     // assume we ride to migration×M after it migrates
    const f = (fillMc/s.entryMc)*(1-SLIP)*(1-SLIP) - 1;
    t += ENTRY_SOL * f;
  }
  return t;
}
console.log(`\n  ── "Ride winners PAST migration" — net PnL if migrated tokens avg Xx beyond migration ──`);
for (const M of [1, 1.5, 2, 3, 5, 8]) {
  const net = netWithMultiplier(M);
  console.log(`     migrated sold at ${M}x migration ($${usd83(MIG_DATA*M).toLocaleString()} real): net ${net>=0?"+":""}${net.toFixed(0)} SOL/mo`);
}
// solve breakeven M
let lo=1, hi=20;
for (let i=0;i<40;i++){ const mid=(lo+hi)/2; if (netWithMultiplier(mid)<0) lo=mid; else hi=mid; }
console.log(`\n  ➤ BREAKEVEN: migrated tokens must average ~${((lo+hi)/2).toFixed(2)}x beyond migration ($${usd83(MIG_DATA*(lo+hi)/2).toLocaleString()} real avg sell) just to not lose money.`);
console.log(`\nDone.\n`);
