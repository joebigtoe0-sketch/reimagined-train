/**
 * bundlebacktest.mjs — backtest the "buy on first gang-wallet detection" strategy.
 *
 * Requires: bundleexpand.mjs to have run first (produces gangWallets.json + gangTokens.json)
 *
 * For each confirmed gang token:
 *   - Entry:  buy at the MC when the FIRST gang wallet trade is seen
 *   - Exit:   sell at the FIRST of:
 *               a) MC reaches EXIT_MC (target, just before migration)
 *               b) MC falls ≤ STOP_LOSS_FRAC × entry MC
 *               c) Token is dead (no activity for DEAD_WINDOW_MS)
 *   - Fee:    SLIPPAGE_FRAC applied on both entry and exit
 *
 * Usage (from backend/):
 *   node scripts/bundlebacktest.mjs
 *   node scripts/bundlebacktest.mjs --no-db
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_ROOT = path.resolve(__dirname, "..", "exports");
const LIB_DIR = path.resolve(__dirname, "lib");
const DEFAULT_DB = "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

// ─── strategy params ──────────────────────────────────────────────────────────
const EXIT_MC = 42_000;          // take profit just below migration (~50k)
const STOP_LOSS_FRAC = 0.70;     // -30% stop
const SLIPPAGE_FRAC = 0.03;      // 3% round-trip slippage
const DEAD_WINDOW_MS = 10 * 60_000; // 10 min no trades → dead

// ── Entry quality filters (the key finding from bundlecompare.mjs) ──────────
// Enter only when the triggering gang wallet buy is this large (real op size ~8 SOL)
const MIN_TRIGGER_BUY_SOL = 7;
// Require at least this many distinct gang wallet buys before entering
// (1 = any, 2 = at least two separate gang wallets, etc.)
const MIN_GANG_WALLETS_BEFORE_ENTRY = 1;

const argv = process.argv.slice(2);
const useDb = !argv.includes("--no-db");

// ─── load gang data ───────────────────────────────────────────────────────────
const gangWalletsPath = path.join(LIB_DIR, "gangWallets.json");
const gangTokensPath = path.join(LIB_DIR, "gangTokens.json");

if (!fs.existsSync(gangWalletsPath) || !fs.existsSync(gangTokensPath)) {
  console.error("Run bundleexpand.mjs first to generate gangWallets.json and gangTokens.json");
  process.exit(1);
}

const gangWallets = new Set(JSON.parse(fs.readFileSync(gangWalletsPath, "utf8")));
const gangTokenList = JSON.parse(fs.readFileSync(gangTokensPath, "utf8"));
const gangMints = new Set(gangTokenList.map((t) => t.mint));

console.log(`\n=== Bundle Backtest ===`);
console.log(`Gang wallets: ${gangWallets.size}  |  Gang tokens: ${gangMints.size}`);
console.log(`Entry: first gang wallet detection  |  Target: $${EXIT_MC.toLocaleString()} MC  |  Stop: -${((1-STOP_LOSS_FRAC)*100).toFixed(0)}%\n`);

// ─── load trades for gang tokens only ────────────────────────────────────────
// mint -> [{wallet, side, sol, mc, ts}] sorted by ts
const tradesByMint = new Map();
for (const m of gangMints) tradesByMint.set(m, []);

async function streamJsonl(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRow(JSON.parse(line)); } catch { /* skip */ }
  }
}

function parseMc(r) { return Number(r.market_cap ?? r.mc) || 0; }
function parseSol(r) { return Number(r.amount_sol ?? r.sol) || 0; }
function parseTs(r) {
  const v = r.ts ?? r.created_at;
  if (!v) return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  return Date.parse(String(v)) || 0;
}

const exportDirs = fs.existsSync(EXPORTS_ROOT)
  ? fs.readdirSync(EXPORTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => path.join(EXPORTS_ROOT, d.name))
      .filter((d) => fs.existsSync(path.join(d, "trades.jsonl")))
  : [];

for (const dir of exportDirs) {
  process.stdout.write(`Loading ${path.basename(dir)}/trades.jsonl … `);
  let n = 0;
  await streamJsonl(path.join(dir, "trades.jsonl"), (r) => {
    const arr = tradesByMint.get(r.mint);
    if (!arr) return;
    n++;
    arr.push({ wallet: r.wallet, side: r.side, sol: parseSol(r), mc: parseMc(r), ts: parseTs(r) });
  });
  console.log(`${n} matching trades`);
}

if (useDb) {
  const client = new Client({ connectionString: process.env.DATABASE_URL || DEFAULT_DB, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT mint, wallet, side, amount_sol::float8 AS amount_sol,
              market_cap::float8 AS market_cap,
              extract(epoch from ts)*1000 AS ts
       FROM trades WHERE mint = ANY($1)`,
      [[...gangMints]]
    );
    console.log(`DB: ${res.rows.length} matching trades`);
    for (const r of res.rows) {
      const arr = tradesByMint.get(r.mint);
      if (arr) arr.push({ wallet: r.wallet, side: r.side, sol: Number(r.amount_sol)||0, mc: Number(r.market_cap)||0, ts: Number(r.ts)||0 });
    }
  } catch (e) { console.warn(`DB skipped: ${e.message}`); }
  finally { try { await client.end(); } catch { /* noop */ } }
}

// Sort
for (const arr of tradesByMint.values()) arr.sort((a, b) => a.ts - b.ts);

// ─── backtest ─────────────────────────────────────────────────────────────────
const trades_out = [];
let wins = 0, losses = 0, totalPnl = 0;
let sumMultiple = 0, sumDetectionMc = 0;
const pnls = [];

for (const [mint, trades] of tradesByMint) {
  if (!trades.length) continue;
  const meta = gangTokenList.find((t) => t.mint === mint) || {};

  // Step 1: find the first gang wallet buy meeting the quality threshold
  // Track distinct gang wallets seen as we scan
  const seenGangWallets = new Set();
  let entryIdx = -1;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (t.side !== "buy" || !gangWallets.has(t.wallet) || t.mc <= 0) continue;
    seenGangWallets.add(t.wallet);
    // Check quality gates: buy size AND enough gang wallets seen so far
    if (t.sol >= MIN_TRIGGER_BUY_SOL && seenGangWallets.size >= MIN_GANG_WALLETS_BEFORE_ENTRY) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0) continue; // no qualifying entry signal

  const entryTrade = trades[entryIdx];
  const entryMc = entryTrade.mc;
  const stopMc = entryMc * STOP_LOSS_FRAC;
  const entryTs = entryTrade.ts;

  // Count how many gang wallets appeared before entry (could be 1 = just detected)
  const gangAtEntry = new Set(
    trades.slice(0, entryIdx + 1).filter((t) => t.side === "buy" && gangWallets.has(t.wallet)).map((t) => t.wallet)
  ).size;

  // Step 2: simulate exit from entryIdx+1 onwards
  let exitMc = null, exitReason = null;
  let lastTradeTs = entryTs;
  let peakMc = entryMc;

  for (let i = entryIdx + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.mc > peakMc) peakMc = t.mc;
    if (t.ts - lastTradeTs > DEAD_WINDOW_MS) {
      exitMc = t.mc > 0 ? t.mc : peakMc * 0.5;
      exitReason = "dead";
      break;
    }
    lastTradeTs = t.ts;
    if (t.mc >= EXIT_MC) { exitMc = EXIT_MC; exitReason = "target"; break; }
    if (t.mc > 0 && t.mc <= stopMc) { exitMc = t.mc; exitReason = "stop"; break; }
  }

  // If no exit trigger found, exit at last known MC
  if (exitMc === null) {
    exitMc = trades[trades.length - 1].mc || peakMc * 0.3;
    exitReason = "eod";
  }

  // P&L (assuming equal MC → price relationship; actual sol out proportional to MC ratio)
  const mcRatio = entryMc > 0 ? exitMc / entryMc : 1;
  const pnlFrac = mcRatio * (1 - SLIPPAGE_FRAC) * (1 - SLIPPAGE_FRAC) - 1;
  const multiple = mcRatio * (1 - SLIPPAGE_FRAC) ** 2;

  pnls.push(pnlFrac);
  totalPnl += pnlFrac;
  sumMultiple += multiple;
  sumDetectionMc += entryMc;
  if (pnlFrac >= 0) wins++; else losses++;

  trades_out.push({
    mint, symbol: meta.symbol || "?",
    entryMc: Math.round(entryMc), exitMc: Math.round(exitMc),
    gangAtEntry, preBuyCnt: meta.preBuyCnt || 0,
    exitReason, pnlFrac: +pnlFrac.toFixed(4), multiple: +multiple.toFixed(3),
  });
}

// ─── stats ────────────────────────────────────────────────────────────────────
const n = wins + losses;
if (n === 0) { console.log("No trades simulated."); process.exit(0); }

pnls.sort((a, b) => a - b);
const median = pnls[Math.floor(pnls.length / 2)];
const p25 = pnls[Math.floor(pnls.length * 0.25)];
const p75 = pnls[Math.floor(pnls.length * 0.75)];

// Breakdown by exit reason
const byReason = {};
for (const t of trades_out) {
  const b = byReason[t.exitReason] || { n: 0, pnl: 0 };
  b.n++; b.pnl += t.pnlFrac;
  byReason[t.exitReason] = b;
}

console.log("\n─── Results ─────────────────────────────────────────────────────────");
console.log(`  Simulated trades   : ${n}`);
console.log(`  Win rate           : ${((wins/n)*100).toFixed(1)}%  (${wins}W / ${losses}L)`);
console.log(`  Avg P&L per trade  : ${((totalPnl/n)*100).toFixed(1)}%`);
console.log(`  Avg multiple       : ${(sumMultiple/n).toFixed(2)}x`);
console.log(`  Avg detection MC   : $${Math.round(sumDetectionMc/n).toLocaleString()}`);
console.log(`  Median P&L         : ${(median*100).toFixed(1)}%`);
console.log(`  25th pct P&L       : ${(p25*100).toFixed(1)}%`);
console.log(`  75th pct P&L       : ${(p75*100).toFixed(1)}%`);

console.log("\n  By exit reason:");
for (const [r, b] of Object.entries(byReason)) {
  console.log(`    ${r.padEnd(8)}: ${b.n} trades, avg ${((b.pnl/b.n)*100).toFixed(1)}%`);
}

// Breakdown by gangs at entry
console.log("\n  By # gang wallets at entry:");
for (let g = 1; g <= 5; g++) {
  const bucket = trades_out.filter((t) => t.gangAtEntry === g);
  if (!bucket.length) continue;
  const wr = bucket.filter((t) => t.pnlFrac >= 0).length / bucket.length;
  const avg = bucket.reduce((s, t) => s + t.pnlFrac, 0) / bucket.length;
  console.log(`    ${g} wallet${g>1?"s":" "}: ${bucket.length} trades  wr=${((wr)*100).toFixed(0)}%  avg=${((avg)*100).toFixed(1)}%`);
}

// Cumulative equity if you trade every signal with 1 SOL bet
const equity = trades_out.reduce((s, t) => s + t.pnlFrac, 0);
const perTrade = equity / n;
console.log(`\n  Cumulative equity  : ${equity > 0 ? "+" : ""}${(equity*100).toFixed(0)}%  over ${n} trades`);
console.log(`  Edge per trade     : ${(perTrade*100).toFixed(2)}%\n`);

if (equity > 0) {
  console.log("  ✓ PROFITABLE — strategy shows positive expectancy on historical data");
} else {
  console.log("  ✗ NOT PROFITABLE on this dataset — review exit params or wallet quality");
}

console.log("\nDone.\n");
