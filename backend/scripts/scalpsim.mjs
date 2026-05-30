/**
 * Scalp backtest — validate the behavior we observed in profitable wallets:
 * enter EARLY on coins with breadth, take a SMALL profit FAST, hard time-stop.
 *
 * For every token: walk trades chronologically. Enter at the first buy once the
 * coin has >= MIN_BUYERS unique buyers AND we're still inside ENTRY_WINDOW_S of
 * launch. Then exit on whichever comes first: take-profit (TP), stop-loss (SL),
 * or a hard time-stop (HOLD_S). PnL multiple = exitMc/entryMc, minus round-trip
 * FEE. Sweeps a grid and reports net PnL per 1 SOL, win rate, avg/median.
 *
 * Read-only.  node scripts/scalpsim.mjs [exports/<dir>]
 * Tunables (env): FEE_PCT (0.03), ENTRY_WINDOW_S (90), MIN_BUYERS (8)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const FEE = Number(process.env.FEE_PCT ?? 0.03);
const ENTRY_WINDOW_S = Number(process.env.ENTRY_WINDOW_S ?? 90);
const MIN_BUYERS = Number(process.env.MIN_BUYERS ?? 8);

const dirArg = process.argv[2];
let trades = [];
const createdMs = new Map();

async function readJsonl(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) onRow(JSON.parse(line));
}

if (dirArg) {
  const dir = path.resolve(process.cwd(), dirArg);
  console.log(`\nLoading export from ${dir} ...`);
  await readJsonl(path.join(dir, "tokens.jsonl"), (t) => createdMs.set(t.mint, Date.parse(t.created_at)));
  await readJsonl(path.join(dir, "trades.jsonl"), (r) =>
    trades.push({ mint: r.mint, wallet: r.wallet, side: r.side, mc: Number(r.market_cap) || 0, ts: Date.parse(r.ts) })
  );
} else {
  const CONNECTION = process.env.DATABASE_URL ||
    "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";
  console.log(`\nLoading from DB ...`);
  const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const tk = await client.query(`SELECT mint, extract(epoch from created_at)*1000 AS c FROM tokens`);
  for (const t of tk.rows) createdMs.set(t.mint, Number(t.c));
  const tr = await client.query(
    `SELECT mint, wallet, side, market_cap::float8 AS mc, extract(epoch from ts)*1000 AS ts FROM trades`
  );
  trades = tr.rows.map((r) => ({ mint: r.mint, wallet: r.wallet, side: r.side, mc: Number(r.mc) || 0, ts: Number(r.ts) }));
  await client.end();
}

// Group trades by mint, sorted by time.
const byMint = new Map();
for (const t of trades) {
  let a = byMint.get(t.mint);
  if (!a) { a = []; byMint.set(t.mint, a); }
  a.push(t);
}
for (const a of byMint.values()) a.sort((x, y) => x.ts - y.ts);

// Simulate one config over all tokens.
function run(TP, SL, HOLD_S) {
  let entered = 0, wins = 0, sumNet = 0;
  const nets = [];
  for (const [mint, arr] of byMint) {
    const cms = createdMs.get(mint);
    if (!cms) continue;
    // find entry: first buy after >= MIN_BUYERS unique buyers, within window
    const seen = new Set();
    let entryMc = 0, entryTs = 0;
    for (const t of arr) {
      if (t.side === "buy") {
        if (t.wallet && t.wallet !== "UNKNOWN_WALLET") seen.add(t.wallet);
        const ageS = (t.ts - cms) / 1000;
        if (seen.size >= MIN_BUYERS && ageS <= ENTRY_WINDOW_S && t.mc > 0) { entryMc = t.mc; entryTs = t.ts; break; }
      }
    }
    if (!entryMc) continue;
    entered++;
    // walk forward for exit
    let exitMc = entryMc;
    for (const t of arr) {
      if (t.ts <= entryTs || t.mc <= 0) continue;
      const mult = t.mc / entryMc;
      const heldS = (t.ts - entryTs) / 1000;
      if (mult >= TP) { exitMc = entryMc * TP; break; }
      if (mult <= SL) { exitMc = entryMc * SL; break; }
      if (heldS >= HOLD_S) { exitMc = t.mc; break; }
      exitMc = t.mc; // last known
    }
    const net = (exitMc / entryMc) * (1 - FEE) - 1;
    nets.push(net);
    sumNet += net;
    if (net > 0) wins++;
  }
  nets.sort((a, b) => a - b);
  const med = nets.length ? nets[Math.floor(nets.length / 2)] : 0;
  return { entered, winRate: entered ? wins / entered : 0, avgNet: entered ? sumNet / entered : 0, medNet: med, totalPnl: sumNet };
}

const pct = (v) => (v * 100).toFixed(1) + "%";
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(` SCALP BACKTEST — ${byMint.size.toLocaleString()} tokens · fee ${pct(FEE)} round-trip`);
console.log(`   entry: first buy after ≥${MIN_BUYERS} unique buyers, within ${ENTRY_WINDOW_S}s of launch`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(`\n   TP    SL   hold   entered  win%    avgNet   medNet    PnL/coin`);

const TPs = [1.2, 1.3, 1.5, 2.0, 3.0];
const SLs = [0.7, 0.8];
const HOLDs = [45, 90, 180, 600];
const results = [];
for (const TP of TPs) for (const SL of SLs) for (const HOLD of HOLDs) {
  const r = run(TP, SL, HOLD);
  results.push({ TP, SL, HOLD, ...r });
}
results.sort((a, b) => b.avgNet - a.avgNet);
for (const r of results) {
  console.log(
    `  ${r.TP.toFixed(1)}×  ${r.SL.toFixed(1)}×  ${String(r.HOLD).padStart(3)}s   ` +
    String(r.entered).padStart(6) + pct(r.winRate).padStart(7) +
    pct(r.avgNet).padStart(9) + pct(r.medNet).padStart(9) +
    (r.avgNet >= 0 ? "+" : "") + (r.avgNet * r.entered).toFixed(1).padStart(8)
  );
}
console.log(`\nReading it: avgNet = mean per-trade return after fees. Positive avgNet`);
console.log(`across many 'entered' coins = a real edge. Best rows are at the top.\n`);
