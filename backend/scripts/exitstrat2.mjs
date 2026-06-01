/**
 * exitstrat2.mjs — Since the bundle is identical for rugs/runners, compare
 * POST-ENTRY exit strategies that use early flow to cut rugs fast and ride runners.
 *
 * Strategies (all enter on the Jito bundle at entryMc, 0.4 SOL, 5% slippage):
 *   A. BASELINE        : trailing 25% / hard stop 30% (current bot)
 *   B. FAST-CUT 15s    : at T+15s, if growth < 1.3x → exit now; else trailing/hard
 *   C. FAST-CUT 30s    : at T+30s, if growth < 1.5x → exit now; else trailing/hard
 *   D. CONFIRM-ENTRY   : DON'T buy on bundle. Wait to T+15s; only enter if
 *                        growth ≥ 1.5x, then trailing/hard from that price.
 *   E. NETFLOW-CUT 15s : at T+15s, if netSOL < 5 → exit now; else trailing/hard
 *
 * Usage: node --max-old-space-size=2048 scripts/exitstrat2.mjs
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
    state.set(mint, { firstTs: ts, devWallet: wallet, triggered: false, triggerTs: 0, entryMc: 0, seq: [] });
  }
  const s = state.get(mint);
  if (ts < s.firstTs) { s.firstTs = ts; s.devWallet = wallet; }

  if (s.triggered) {
    if (s.seq.length < 6000) s.seq.push({ dt: ts - s.triggerTs, mc, sol, isBuy });
    continue;
  }
  const ageMs = ts - s.firstTs;
  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC && ageMs <= 1000 && wallet !== s.devWallet) {
    s.triggered = true;
    s.triggerTs = ts;
    s.entryMc   = mc;
    s.seq       = [{ dt: 0, mc, sol, isBuy }];
  }
}

console.log(`\nScanned ${(lineCount/1e6).toFixed(1)}M lines`);
const trig = [...state.values()].filter(s => s.triggered && s.entryMc > 0 && s.seq.length >= 2);
console.log(`Jito-bundle tokens: ${trig.length.toLocaleString()}\n`);

// helpers
function growthAt(s, atMs) {
  let mc = s.entryMc;
  for (const e of s.seq) { if (e.dt > atMs) break; mc = e.mc; }
  return mc / s.entryMc;
}
function netSolBy(s, atMs) {
  let net = 0;
  for (const e of s.seq) { if (e.dt > atMs) break; net += e.isBuy ? e.sol : -e.sol; }
  return net;
}
// trailing/hard stop walk starting from a given index/price
function trailFrom(s, startMc, startDt) {
  let peak = startMc, exit = startMc;
  for (const e of s.seq) {
    if (e.dt < startDt) continue;
    if (e.mc > peak) peak = e.mc;
    if (e.mc <= startMc * (1 - HARD))            { return e.mc; }
    if (peak > startMc && e.mc <= peak*(1-TRAIL)){ return e.mc; }
    exit = e.mc;
  }
  return exit;
}

function pnlFrac(entryMc, exitMc) { return (exitMc/entryMc) * (1-SLIP) * (1-SLIP) - 1; }

function runStrategy(kind) {
  let trades=0, wins=0, totFrac=0;
  for (const s of trig) {
    let entryMc = s.entryMc, exitMc;
    if (kind === "A") {
      exitMc = trailFrom(s, entryMc, 0);
    } else if (kind === "B") {
      if (growthAt(s,15_000) < 1.3) exitMc = mcAt(s,15_000);
      else exitMc = trailFrom(s, entryMc, 0);
    } else if (kind === "C") {
      if (growthAt(s,30_000) < 1.5) exitMc = mcAt(s,30_000);
      else exitMc = trailFrom(s, entryMc, 0);
    } else if (kind === "D") {
      if (growthAt(s,15_000) < 1.5) continue;     // no trade
      entryMc = mcAt(s,15_000);
      exitMc  = trailFrom(s, entryMc, 15_000);
    } else if (kind === "E") {
      if (netSolBy(s,15_000) < 5) exitMc = mcAt(s,15_000);
      else exitMc = trailFrom(s, entryMc, 0);
    }
    const f = pnlFrac(entryMc, exitMc);
    trades++; if (f > 0) wins++; totFrac += f;
  }
  return { trades, wins, totFrac, totSol: totFrac*ENTRY_SOL };
}
function mcAt(s, atMs) { let mc=s.entryMc; for (const e of s.seq){ if(e.dt>atMs) break; mc=e.mc; } return mc; }

const labels = {
  A: "A. Baseline (trail25/hard30)",
  B: "B. Fast-cut 15s (<1.3x → exit)",
  C: "C. Fast-cut 30s (<1.5x → exit)",
  D: "D. Confirm-entry 15s (≥1.5x only)",
  E: "E. Netflow-cut 15s (<5 SOL → exit)",
};

console.log("Strategy                            │ Trades │ Win%  │ AvgPnL  │ TotalSOL │ Monthly");
console.log("─".repeat(86));
for (const k of ["A","B","C","D","E"]) {
  const r = runStrategy(k);
  const win = r.wins/r.trades*100;
  const avg = r.totFrac/r.trades*100;
  console.log(
    `${labels[k].padEnd(35)} │ ${String(r.trades).padStart(6)} │ ${win.toFixed(1).padStart(4)}% │ ${(avg>=0?"+":"")}${avg.toFixed(1).padStart(6)}% │ ${(r.totSol>=0?"+":"")}${r.totSol.toFixed(1).padStart(7)} │ +${r.totSol.toFixed(0)}/mo`
  );
}
console.log("─".repeat(86));
console.log("\n(Entry 0.4 SOL, 5% slippage each side, 30 days of data)\n");
