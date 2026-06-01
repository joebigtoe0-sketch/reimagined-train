/**
 * realisticentry.mjs — Re-run the Jito-bundle backtest with REALISTIC entry timing.
 *
 * The old backtest entered at the MC of the FIRST 7 SOL bundle buy. But in reality:
 *   - All 4 gang buys (~34 SOL) land in the SAME block (T+0), pushing MC up fast.
 *   - Our retrocheck only detects at T+800ms / 2s / 8s / 20s.
 *   - The paper bot then fills at the THEN-current (post-bundle) price.
 *
 * So real entry MC is much higher than the first-buy MC. This script simulates
 * entry at several delays and at the post-bundle peak, to bracket the TRUE PnL.
 *
 * Exit: trailing 25% / hard 30%, realistic fills (actual trade MC), 5% slippage.
 *
 * Usage: node --max-old-space-size=2048 scripts/realisticentry.mjs
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
const SOL_USD     = 150;     // the price the data was recorded at
const REAL_SOL    = 83;      // today's price, for a real-world MC column

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
    state.set(mint, { firstTs: ts, devWallet: wallet, triggered: false, triggerTs: 0, firstBuyMc: 0, seq: [] });
  }
  const s = state.get(mint);
  if (ts < s.firstTs) { s.firstTs = ts; s.devWallet = wallet; }
  if (s.triggered) { if (s.seq.length < 8000) s.seq.push({ dt: ts - s.triggerTs, mc }); continue; }
  const ageMs = ts - s.firstTs;
  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC && ageMs <= 1000 && wallet !== s.devWallet) {
    s.triggered = true; s.triggerTs = ts; s.firstBuyMc = mc; s.seq = [{ dt: 0, mc }];
  }
}
console.log(`\nScanned ${(lineCount/1e6).toFixed(1)}M lines`);

const trig = [...state.values()].filter(s => s.triggered && s.firstBuyMc > 0 && s.seq.length >= 3);
console.log(`Jito-bundle tokens: ${trig.length.toLocaleString()}\n`);

// entry MC = first trade at/after the given delay (ms)
function entryAt(s, delayMs) {
  for (const e of s.seq) if (e.dt >= delayMs) return { mc: e.mc, dt: e.dt };
  const last = s.seq[s.seq.length-1];
  return { mc: last.mc, dt: last.dt };
}
// post-bundle peak = highest MC within first `winMs` (models buying the bundle spike top)
function bundlePeak(s, winMs) {
  let mc = s.seq[0].mc, dt = 0;
  for (const e of s.seq) { if (e.dt > winMs) break; if (e.mc > mc) { mc = e.mc; dt = e.dt; } }
  return { mc, dt };
}
// trailing/hard stop from a given entry point; realistic fill at actual trade MC
function simFrom(s, entryMc, entryDt) {
  let peak = entryMc, exit = entryMc;
  for (const e of s.seq) {
    if (e.dt < entryDt) continue;
    if (e.mc > peak) peak = e.mc;
    if (e.mc <= entryMc * (1 - HARD))                 return e.mc;
    if (peak > entryMc && e.mc <= peak * (1 - TRAIL)) return e.mc;
    exit = e.mc;
  }
  return exit;
}

function runScenario(name, entryFn) {
  let trades=0, wins=0, totFrac=0;
  let sumEntryMc = 0;
  for (const s of trig) {
    const { mc: entryMc, dt: entryDt } = entryFn(s);
    if (entryMc <= 0) continue;
    const exitMc = simFrom(s, entryMc, entryDt);
    const f = (exitMc/entryMc)*(1-SLIP)*(1-SLIP) - 1;
    trades++; if (f > 0) wins++; totFrac += f; sumEntryMc += entryMc;
  }
  const avgEntry = sumEntryMc/trades;
  return {
    name, trades, win: wins/trades*100, avgPnl: totFrac/trades*100,
    totSol: totFrac*ENTRY_SOL, avgEntryData: avgEntry, avgEntryReal: avgEntry/SOL_USD*REAL_SOL,
  };
}

const scenarios = [
  ["T+0  first-buy MC (old/optimistic)", s => entryAt(s, 0)],
  ["T+1s",                               s => entryAt(s, 1000)],
  ["T+2s",                               s => entryAt(s, 2000)],
  ["T+3s",                               s => entryAt(s, 3000)],
  ["T+5s",                               s => entryAt(s, 5000)],
  ["post-bundle PEAK (worst case)",      s => bundlePeak(s, 2000)],
];

const rows = scenarios.map(([n,f]) => runScenario(n, f));

console.log("Scenario                              │ Trades │ Win%  │ AvgPnL  │ Total SOL │ avgEntry($150) │ avgEntry($83)");
console.log("─".repeat(108));
for (const r of rows) {
  console.log(
    `${r.name.padEnd(37)} │ ${String(r.trades).padStart(6)} │ ${r.win.toFixed(1).padStart(4)}% │ ${(r.avgPnl>=0?"+":"")}${r.avgPnl.toFixed(1).padStart(6)}% │ ${(r.totSol>=0?"+":"")}${r.totSol.toFixed(0).padStart(7)} │ ${("$"+Math.round(r.avgEntryData).toLocaleString()).padStart(13)} │ ${("$"+Math.round(r.avgEntryReal).toLocaleString()).padStart(12)}`
  );
}
console.log("─".repeat(108));
console.log(`\nEntry 0.4 SOL, trailing 25% / hard 30%, 5% slippage each side, 30 days.`);
console.log(`~${(rows[0].trades/30).toFixed(1)} trades/day. PnL is SOL-denominated (unaffected by SOL price).`);

// Realistic estimate: detection ~T+2s typically
const real = rows.find(r => r.name === "T+2s");
console.log(`\n➤ REALISTIC (entry ≈ T+2s): ${real.win.toFixed(1)}% win, ${real.avgPnl>=0?"+":""}${real.avgPnl.toFixed(1)}% avg PnL, ${real.totSol>=0?"+":""}${real.totSol.toFixed(0)} SOL/month`);
console.log(`   vs old optimistic T+0: ${rows[0].totSol.toFixed(0)} SOL/month → realistic is ${(real.totSol/rows[0].totSol*100).toFixed(0)}% of that.\n`);
