/**
 * buyat12k.mjs — Test the "only buy once MC reaches 12k (real $83), sell winners
 * at migration" idea. Filters out all tokens that peak below the entry threshold.
 *
 * Entry: first trade (after the bundle) where MC >= THRESHOLD. If never reached, skip.
 * Exit variants tested (sell at migration for winners):
 *   - hard stop -30% / -50% / none, and trailing 30%
 *
 * All MC in real $83 terms (data recorded at $150; factor 0.5533).
 *
 * Usage: node --max-old-space-size=2048 scripts/buyat12k.mjs
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
const MIG_DATA    = 60_000;            // migration (data $150 terms)
const R           = 83 / 150;          // data → real $83
const toData      = (real) => real / R;
const toReal      = (data) => Math.round(data * R);

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
console.log(`Total bundle tokens: ${trig.length.toLocaleString()}\n`);

// Enter at first trade with mc >= threshold (data). Returns {entryMc, entryDt} or null.
function entryAtThreshold(s, threshData) {
  for (const e of s.seq) {
    if (e.dt <= 0) continue;                 // skip the trigger tick itself
    if (e.mc >= threshData) return { entryMc: e.mc, entryDt: e.dt };
  }
  return null;                                // never reached threshold → no trade
}

// Exit: sell at migration if reached; hard stop at entry*(1-hard); optional trailing.
function exitRide(s, entryMc, entryDt, hard, trail) {
  let peak = entryMc, last = entryMc, mig = false;
  for (const e of s.seq) {
    if (e.dt < entryDt) continue;
    if (e.mc > peak) peak = e.mc;
    if (e.mc >= MIG_DATA) { return { mc: e.mc, mig: true }; }
    if (hard  && e.mc <= entryMc * (1 - hard))           return { mc: e.mc, mig:false };
    if (trail && peak > entryMc && e.mc <= peak*(1-trail)) return { mc: e.mc, mig:false };
    last = e.mc;
  }
  return { mc: last, mig };
}

function run(threshReal, hard, trail, label) {
  const thresh = toData(threshReal);
  let trades=0, wins=0, migs=0, totSol=0, sumEntry=0;
  for (const s of trig) {
    const ent = entryAtThreshold(s, thresh);
    if (!ent) continue;                       // skipped (peaked below threshold)
    const { mc: exitMc, mig } = exitRide(s, ent.entryMc, ent.entryDt, hard, trail);
    const f = (exitMc/ent.entryMc)*(1-SLIP)*(1-SLIP) - 1;
    trades++; if (f>0) wins++; if (mig) migs++; totSol += ENTRY_SOL*f; sumEntry += ent.entryMc;
  }
  return { label, threshReal, trades, wins, migs, totSol, win: trades?wins/trades*100:0,
           avgEntryReal: trades?toReal(sumEntry/trades):0 };
}

function show(r) {
  console.log(
    `${r.label.padEnd(40)} │ ${String(r.trades).padStart(5)} │ ${r.win.toFixed(1).padStart(5)}% │ mig ${String(r.migs).padStart(4)} │ ${(r.totSol>=0?"+":"")}${r.totSol.toFixed(0).padStart(6)} SOL/mo`
  );
}

console.log("Strategy                                 │ Trades │  Win%  │ migrated │ Net PnL (sell winners @ migration)");
console.log("─".repeat(104));

// Baseline reminder: buy everything at post-bundle (~10.4k), -30% stop
show(run(0,        0.30, 0, "buy ALL (~10.4k), hard -30%"));
console.log("  ── only buy once MC reaches threshold ──");
show(run(12_000,   0.30, 0, "buy@12k, hard -30%"));
show(run(12_000,   0.50, 0, "buy@12k, hard -50%"));
show(run(12_000,   0,    0, "buy@12k, NO stop (diamond to migration)"));
show(run(12_000,   0,    0.40, "buy@12k, trailing 40%"));
show(run(15_000,   0.40, 0, "buy@15k, hard -40%"));
show(run(15_000,   0,    0, "buy@15k, NO stop"));
show(run(18_000,   0,    0, "buy@18k, NO stop"));
console.log("─".repeat(104));

// Detail on the 12k / -30% case the user asked about
const r = run(12_000, 0.30, 0, "x");
console.log(`\nDETAIL — buy@12k real, hard -30%, sell winners at migration:`);
console.log(`  Trades taken      : ${r.trades}  (skipped ${trig.length - r.trades} that never reached 12k)`);
console.log(`  Reached migration : ${r.migs}  (${(r.migs/r.trades*100).toFixed(1)}% of trades)`);
console.log(`  Win rate          : ${r.win.toFixed(1)}%`);
console.log(`  Avg entry         : $${r.avgEntryReal.toLocaleString()} real`);
console.log(`  NET (sell at migration, NO post-migration upside): ${r.totSol>=0?"+":""}${r.totSol.toFixed(0)} SOL/mo`);

// Breakeven post-migration multiple for the 12k/-30% case
function netMult(threshReal, hard, M) {
  const thresh = toData(threshReal);
  let t=0;
  for (const s of trig) {
    const ent = entryAtThreshold(s, thresh); if (!ent) continue;
    const { mc: exitMc, mig } = exitRide(s, ent.entryMc, ent.entryDt, hard, 0);
    const fill = mig ? MIG_DATA*M : exitMc;
    t += ENTRY_SOL * ((fill/ent.entryMc)*(1-SLIP)*(1-SLIP) - 1);
  }
  return t;
}
console.log(`\n  If migrated tokens avg Xx beyond migration:`);
for (const M of [1,1.5,2,3,5]) {
  console.log(`     ${M}x ($${toReal(MIG_DATA*M).toLocaleString()} real): ${netMult(12000,0.30,M)>=0?"+":""}${netMult(12000,0.30,M).toFixed(0)} SOL/mo`);
}
let lo=1,hi=20; for(let i=0;i<40;i++){const m=(lo+hi)/2; if(netMult(12000,0.30,m)<0)lo=m;else hi=m;}
console.log(`  ➤ Breakeven post-migration multiple: ~${((lo+hi)/2).toFixed(2)}x ($${toReal(MIG_DATA*(lo+hi)/2).toLocaleString()} real)`);
console.log(`\nDone.\n`);
