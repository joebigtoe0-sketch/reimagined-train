/**
 * bundleexpand.mjs — mine the full 20-day backfill to build a precise gang wallet list.
 *
 * Strategy:
 *   Pass A: scan all trades, record which of the 19 SEED wallets bought pre-20k per mint.
 *           A mint is a "gang token" if ≥2 seed wallets appear pre-20k.
 *   Pass B: scan again, collect ALL pre-20k buyers for those gang tokens only.
 *           A wallet earns "gang status" only if it appears in ≥EXPAND_THRESHOLD gang tokens.
 *           This prevents the explosive over-expansion of a loose ≥2 threshold.
 *
 * Outputs:
 *   backend/scripts/lib/gangWallets.json  — final gang wallet list (small, precise)
 *   backend/scripts/lib/gangTokens.json   — confirmed gang tokens + metadata
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
const OUT_DIR = path.resolve(__dirname, "lib");
const DEFAULT_DB = "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const PRE_BUNDLE_MC = 20_000;
const MIN_GANG_WALLETS = 2;       // A token is a gang token if ≥2 known gang wallets bought pre-20k
const EXPAND_THRESHOLD = 8;       // A new wallet earns gang status only if it appears in ≥8 gang tokens
                                   // (out of ~1700, this is ~0.5% — strong signal of deliberate repetition)

const SEED_GANG_WALLETS = new Set([
  "2jJKTKDutvjjrvidauACS9efVdyRbYN5ymqbFTcPnH8V",
  "GRANRPGS4wFKVAGwM5ScD6rreNHFs7SmET7GhH2U7EWB",
  "3NxtfjKwBj2HD2myH6DRu2Hzzz6qNZyWwUL7aUyVDC5L",
  "C9Efxy4pJtfRTYWxrSYGaR7g3KXco7DdDmCRjZyabS7B",
  "CyPYsEpWQqS2Cc9kofDXbrVVtmD1PpqMikkhSko9PTgt",
  "HkhDTEEnsPbyNxfBknG693Bhd3mqczXcDo9RQctR7Pyz",
  "3MXhTXKbxwo4YV4RqTtkN2oHPdxGdALPfXjvMQfPdKB2",
  "F4nx9DbZxQhR2nf8TfRnZ9hFxWJa9tC2BK6ZVrEG2ky9",
  "5eBXiivHtjcC7mLywBAHBwsTfWT5MEpdfVk2RrGdZgWB",
  "4zvSPaPCYDd7cprVHnGKrAaMCFRKQ8Bb9YuxrmHonYNG",
  "FiqF4oTdUGatFQvaEcv41yzaamedkxFgZ7BSxx49TsMZ",
  "4h5DvYLwGQyiC5ojub42PBeArsaBGxVkZqwvENjutm1D",
  "5QC5ydrKn3wigKB27g24PdNPAzkRZitLxdV7tA6c1Yk1",
  "3TxCFKgMUgCB99YQJ8TgEJjP9Uzgk8FUXcH1p7rxRF1e",
  "DGidLoNkmkHHSSNi8nS4fF6FvUrhRaNkpGyNQ5qcvE83",
  "FZ8yTKQxBYf29VELRWxAkd8avHPB1wFxtfwvKbH9SGur",
  "864SeaHY5H7FGBcY6JzHfYDPf9nzBNNDxu1zdyExVQUF",
  "Hn9B5qcoHAQZg6YsjT6twgugzw1YTNF9qahC1n7UKBao",
  "78e9BM4nBbHDrXhoPNa9GZ1DRe6ZVBbem8KEfCyhtWB7",
]);

const argv = process.argv.slice(2);
const useDb = !argv.includes("--no-db");

function parseMc(r) { return Number(r.market_cap ?? r.mc) || 0; }
function parseSol(r) { return Number(r.amount_sol ?? r.sol) || 0; }

function getExportDirs() {
  if (!fs.existsSync(EXPORTS_ROOT)) return [];
  return fs
    .readdirSync(EXPORTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => path.join(EXPORTS_ROOT, d.name))
    .filter((d) => fs.existsSync(path.join(d, "trades.jsonl")));
}

async function streamJsonl(file, onRow) {
  if (!fs.existsSync(file)) return 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRow(JSON.parse(line)); n++; } catch { /* skip */ }
  }
  return n;
}

/** Pass A: track only known gang wallets per mint, pre-20k — very lean. */
async function passA(gangWallets) {
  const preGangByMint = new Map(); // mint -> Set<gangWallet>

  const onTrade = (r) => {
    if (!r.mint || r.side !== "buy") return;
    const mc = parseMc(r);
    if (mc <= 0 || mc >= PRE_BUNDLE_MC) return;
    if (!gangWallets.has(r.wallet)) return;
    let s = preGangByMint.get(r.mint);
    if (!s) { s = new Set(); preGangByMint.set(r.mint, s); }
    s.add(r.wallet);
  };

  for (const dir of getExportDirs()) {
    process.stdout.write(`  A: ${path.basename(dir)}/trades … `);
    const n = await streamJsonl(path.join(dir, "trades.jsonl"), onTrade);
    console.log(`${(n / 1e6).toFixed(1)}M rows`);
  }

  if (useDb) {
    const client = new Client({ connectionString: process.env.DATABASE_URL || DEFAULT_DB, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      process.stdout.write("  A: DB … ");
      const res = await client.query(
        `SELECT mint, wallet, side, market_cap::float8 AS market_cap
         FROM trades WHERE side='buy' AND market_cap > 0 AND market_cap < $1`,
        [PRE_BUNDLE_MC]
      );
      console.log(`${res.rows.length} rows`);
      for (const r of res.rows) onTrade(r);
    } catch (e) { console.warn(`  DB skipped: ${e.message}`); }
    finally { try { await client.end(); } catch { /* noop */ } }
  }

  return preGangByMint;
}

/** Pass B: collect full per-mint stats for confirmed gang mints only. */
async function passB(gangMints) {
  // mint -> { walletCounts: Map<wallet,count>, allBuys, allSells, peakMc, largestPreBuy, preBuyCnt }
  const mintStats = new Map();
  for (const m of gangMints) {
    mintStats.set(m, { walletCounts: new Map(), allBuys: 0, allSells: 0, peakMc: 0, largestPreBuy: 0, preBuyCnt: 0 });
  }

  const onTrade = (r) => {
    const stats = mintStats.get(r.mint);
    if (!stats) return;
    const mc = parseMc(r);
    const sol = parseSol(r);
    if (mc > stats.peakMc) stats.peakMc = mc;
    if (r.side === "buy") {
      stats.allBuys++;
      if (mc > 0 && mc < PRE_BUNDLE_MC && r.wallet) {
        stats.preBuyCnt++;
        if (sol > stats.largestPreBuy) stats.largestPreBuy = sol;
        stats.walletCounts.set(r.wallet, (stats.walletCounts.get(r.wallet) || 0) + 1);
      }
    } else if (r.side === "sell") {
      stats.allSells++;
    }
  };

  for (const dir of getExportDirs()) {
    process.stdout.write(`  B: ${path.basename(dir)}/trades … `);
    const n = await streamJsonl(path.join(dir, "trades.jsonl"), onTrade);
    console.log(`${(n / 1e6).toFixed(1)}M rows`);
  }

  if (useDb) {
    const client = new Client({ connectionString: process.env.DATABASE_URL || DEFAULT_DB, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      process.stdout.write("  B: DB … ");
      const res = await client.query(
        `SELECT mint, wallet, side, amount_sol::float8 AS amount_sol, market_cap::float8 AS market_cap
         FROM trades WHERE mint = ANY($1)`,
        [[...gangMints]]
      );
      console.log(`${res.rows.length} rows`);
      for (const r of res.rows) onTrade(r);
    } catch (e) { console.warn(`  DB skipped: ${e.message}`); }
    finally { try { await client.end(); } catch { /* noop */ } }
  }

  return mintStats;
}

// ─── main ─────────────────────────────────────────────────────────────────────
console.log("\n=== Bundle Gang Expander ===\n");

// Load token metadata
const tokenMeta = new Map();
for (const dir of getExportDirs()) {
  await streamJsonl(path.join(dir, "tokens.jsonl"), (t) => {
    if (t.mint && !tokenMeta.has(t.mint)) tokenMeta.set(t.mint, { symbol: t.symbol || "?", createdAt: t.created_at });
  });
}
console.log(`Token metadata: ${tokenMeta.size} tokens\n`);

// ── Pass A: identify gang tokens with seed wallets ────────────────────────────
console.log("Pass A: identify gang tokens with seed wallets …");
const preGangByMint = await passA(SEED_GANG_WALLETS);

const gangMints = new Set(
  [...preGangByMint.entries()].filter(([, s]) => s.size >= MIN_GANG_WALLETS).map(([m]) => m)
);
console.log(`\n  Confirmed gang tokens: ${gangMints.size}  (≥${MIN_GANG_WALLETS} seed wallets pre-20k)\n`);

// ── Pass B: collect full stats for gang tokens ────────────────────────────────
console.log("Pass B: collect full buyer data for gang tokens …");
const mintStats = await passB(gangMints);

// ── Expand wallet list with strict threshold ──────────────────────────────────
// Count how many gang tokens each wallet bought pre-20k
const globalWalletCount = new Map();
for (const stats of mintStats.values()) {
  for (const [w] of stats.walletCounts) {
    globalWalletCount.set(w, (globalWalletCount.get(w) || 0) + 1);
  }
}

const finalGang = new Set(SEED_GANG_WALLETS);
const newWallets = [];
for (const [w, cnt] of globalWalletCount) {
  if (cnt >= EXPAND_THRESHOLD) {
    finalGang.add(w);
    if (!SEED_GANG_WALLETS.has(w)) newWallets.push({ wallet: w, appearances: cnt });
  }
}
newWallets.sort((a, b) => b.appearances - a.appearances);

console.log(`\nExpanded gang wallets: ${SEED_GANG_WALLETS.size} → ${finalGang.size}`);
console.log(`  (threshold: ≥${EXPAND_THRESHOLD} of ${gangMints.size} gang tokens = ${((EXPAND_THRESHOLD/gangMints.size)*100).toFixed(2)}%)`);
if (newWallets.length > 0) {
  console.log("\n  Top new gang wallets:");
  for (const { wallet, appearances } of newWallets.slice(0, 20)) {
    console.log(`    ${wallet}  (${appearances} tokens)`);
  }
}

// ── Build token records ───────────────────────────────────────────────────────
const gangTokenRecords = [];
for (const [mint, stats] of mintStats) {
  const meta = tokenMeta.get(mint) || {};
  const gangWalletsForMint = [...(preGangByMint.get(mint) || [])];
  gangTokenRecords.push({
    mint,
    symbol: meta.symbol || "?",
    createdAt: meta.createdAt || null,
    gangWallets: gangWalletsForMint,
    gangWalletCount: gangWalletsForMint.length,
    preBuyCnt: stats.preBuyCnt,
    largestPreBuy: +stats.largestPreBuy.toFixed(3),
    allBuys: stats.allBuys,
    allSells: stats.allSells,
    peakMc: Math.round(stats.peakMc),
    buyToSell: stats.allSells > 0 ? +(stats.allBuys / stats.allSells).toFixed(2) : stats.allBuys,
  });
}

// ── Write outputs ─────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "gangWallets.json"), JSON.stringify([...finalGang], null, 2));
fs.writeFileSync(path.join(OUT_DIR, "gangTokens.json"), JSON.stringify(gangTokenRecords, null, 2));

console.log(`\nWrote ${finalGang.size} gang wallets → ${OUT_DIR}/gangWallets.json`);
console.log(`Wrote ${gangTokenRecords.length} gang tokens  → ${OUT_DIR}/gangTokens.json`);

// ── Summary ───────────────────────────────────────────────────────────────────
const n = gangTokenRecords.length || 1;
const peaked50k = gangTokenRecords.filter((t) => t.peakMc >= 50_000).length;
const peaked30k = gangTokenRecords.filter((t) => t.peakMc >= 30_000).length;
const peaked15k = gangTokenRecords.filter((t) => t.peakMc >= 15_000).length;
const avgPeak = gangTokenRecords.reduce((s, t) => s + t.peakMc, 0) / n;
const avgBuySell = gangTokenRecords.reduce((s, t) => s + t.buyToSell, 0) / n;
const avgLargestBuy = gangTokenRecords.reduce((s, t) => s + t.largestPreBuy, 0) / n;

console.log("\n─── Summary ─────────────────────────────────────────────────────────");
console.log(`  Gang tokens total      : ${gangTokenRecords.length}`);
console.log(`  Peaked ≥50k MC         : ${peaked50k}  (${((peaked50k/n)*100).toFixed(1)}%)`);
console.log(`  Peaked ≥30k MC         : ${peaked30k}  (${((peaked30k/n)*100).toFixed(1)}%)`);
console.log(`  Peaked ≥15k MC         : ${peaked15k}  (${((peaked15k/n)*100).toFixed(1)}%)`);
console.log(`  Avg peak MC            : $${Math.round(avgPeak).toLocaleString()}`);
console.log(`  Avg buy/sell ratio     : ${avgBuySell.toFixed(1)}`);
console.log(`  Avg largest pre buy    : ${avgLargestBuy.toFixed(2)} SOL`);
console.log();
