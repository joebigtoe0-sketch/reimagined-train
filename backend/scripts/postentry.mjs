/**
 * postentry.mjs — Since the creation bundle is identical for rugs and runners,
 * the edge must come AFTER entry. This measures early post-trigger behaviour
 * (first 15s / 30s / 60s) for Jito-bundle tokens and asks:
 *
 *   Is there an early signal that separates RUNNERS from RUGS?
 *
 * For each Jito-bundle token (same-second ≥7 SOL non-dev buy) we record, in each
 * window after the trigger:
 *   - # of buys, # of sells
 *   - # of distinct buyer wallets (organic interest / "crime")
 *   - net SOL flow (buys − sells)
 *   - max MC reached
 *   - MC growth ratio vs entry
 *
 * Outcome classes:
 *   RUG    = peak MC < 20k  (dies at/near bundle level)
 *   MEH    = peak 20k–40k
 *   RUN    = peak ≥ 40k     (the "crimed" ones)
 *
 * Usage: node --max-old-space-size=2048 scripts/postentry.mjs
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, "..", "exports", "pumpfundata-pump_fun", "trades.jsonl");

const TRIGGER_SOL = 7;
const PRE_MC      = 18_000;
const WINDOWS     = [15_000, 30_000, 60_000];  // ms after trigger
const RUN_MC      = 40_000;
const RUG_MC      = 20_000;

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
    state.set(mint, { firstTs: ts, devWallet: wallet, triggered: false, triggerTs: 0,
                      entryMc: 0, peakMc: mc, events: [] });
  }
  const s = state.get(mint);
  if (ts < s.firstTs) { s.firstTs = ts; s.devWallet = wallet; }
  if (mc > s.peakMc) s.peakMc = mc;

  if (s.triggered) {
    // keep events within 60s of trigger for window analysis
    if (ts - s.triggerTs <= 60_000 && s.events.length < 5000) {
      s.events.push({ ts, sol, mc, isBuy, wallet });
    }
    continue;
  }

  const ageMs = ts - s.firstTs;
  if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC && ageMs <= 1000 && wallet !== s.devWallet) {
    s.triggered = true;
    s.triggerTs = ts;
    s.entryMc   = mc;
    s.events    = [{ ts, sol, mc, isBuy, wallet }];
  }
}

console.log(`\nScanned ${(lineCount/1e6).toFixed(1)}M lines`);

const trig = [...state.values()].filter(s => s.triggered && s.entryMc > 0);
console.log(`Jito-bundle tokens: ${trig.length.toLocaleString()}\n`);

// Classify + compute window features
function windowFeats(s, win) {
  const cutoff = s.triggerTs + win;
  let buys=0, sells=0, buySol=0, sellSol=0, maxMc=s.entryMc;
  const buyers = new Set();
  for (const e of s.events) {
    if (e.ts > cutoff) continue;
    if (e.mc > maxMc) maxMc = e.mc;
    if (e.isBuy) { buys++; buySol += e.sol; if (e.wallet) buyers.add(e.wallet); }
    else { sells++; sellSol += e.sol; }
  }
  return { buys, sells, buySol, sellSol, netSol: buySol - sellSol,
           uniqueBuyers: buyers.size, maxMc, growth: maxMc / s.entryMc };
}

for (const s of trig) {
  s.cls = s.peakMc >= RUN_MC ? "RUN" : s.peakMc < RUG_MC ? "RUG" : "MEH";
}

const groups = { RUN: trig.filter(s=>s.cls==="RUN"), MEH: trig.filter(s=>s.cls==="MEH"), RUG: trig.filter(s=>s.cls==="RUG") };
console.log(`Outcome split:  RUN(≥40k)=${groups.RUN.length}  MEH(20-40k)=${groups.MEH.length}  RUG(<20k)=${groups.RUG.length}\n`);

for (const win of WINDOWS) {
  console.log(`\n═══ First ${win/1000}s after entry ═══════════════════════════════════════`);
  console.log("Class │  n    │ avgBuys │ avgSells │ B/S  │ uniqBuyers │ netSOL │ avgGrowth");
  console.log("─".repeat(80));
  for (const cls of ["RUN","MEH","RUG"]) {
    const g = groups[cls];
    if (!g.length) continue;
    const f = g.map(s => windowFeats(s, win));
    const avg = (k) => f.reduce((a,x)=>a+x[k],0)/f.length;
    const bs = avg("buys") / Math.max(avg("sells"), 0.01);
    console.log(
      `${cls.padEnd(5)} │ ${String(g.length).padStart(5)} │ ${avg("buys").toFixed(1).padStart(7)} │ ${avg("sells").toFixed(1).padStart(8)} │ ${bs.toFixed(1).padStart(4)} │ ${avg("uniqueBuyers").toFixed(1).padStart(10)} │ ${avg("netSol").toFixed(1).padStart(6)} │ ${avg("growth").toFixed(2).padStart(8)}x`
    );
  }
}

// ── Find a usable threshold: use 30s window features to predict RUN ──
console.log("\n\n═══ THRESHOLD TEST: can 30s-window features flag RUNs early? ═══");
const win = 30_000;
const feat = trig.map(s => ({ ...windowFeats(s, win), cls: s.cls, peakMc: s.peakMc }));

// Test simple rules and report precision/recall for catching RUN+MEH (anything ≥20k)
function testRule(name, pred) {
  let tp=0, fp=0, fn=0, tn=0;
  for (const f of feat) {
    const good = f.cls !== "RUG";       // worth holding (≥20k)
    const flag = pred(f);
    if (flag && good) tp++;
    else if (flag && !good) fp++;
    else if (!flag && good) fn++;
    else tn++;
  }
  const prec = tp/(tp+fp||1)*100;
  const rec  = tp/(tp+fn||1)*100;
  console.log(`  ${name.padEnd(34)}: precision=${prec.toFixed(1)}% recall=${rec.toFixed(1)}%  (flags ${tp+fp}, ${tp} good)`);
}

const baseGood = feat.filter(f=>f.cls!=="RUG").length / feat.length * 100;
console.log(`  Baseline (hold everything)        : ${baseGood.toFixed(1)}% of tokens reach ≥20k\n`);
testRule("uniqueBuyers >= 8", f => f.uniqueBuyers >= 8);
testRule("uniqueBuyers >= 12", f => f.uniqueBuyers >= 12);
testRule("uniqueBuyers >= 20", f => f.uniqueBuyers >= 20);
testRule("netSol >= 5", f => f.netSol >= 5);
testRule("netSol >= 10", f => f.netSol >= 10);
testRule("growth >= 1.5x", f => f.growth >= 1.5);
testRule("growth >= 2x", f => f.growth >= 2);
testRule("buys >= 15", f => f.buys >= 15);
testRule("uniqBuyers>=12 AND netSol>=5", f => f.uniqueBuyers>=12 && f.netSol>=5);
testRule("growth>=1.5x AND uniqBuyers>=10", f => f.growth>=1.5 && f.uniqueBuyers>=10);

console.log("\nDone.\n");
