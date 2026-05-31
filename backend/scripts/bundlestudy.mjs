/**
 * bundlestudy.mjs — analyse the "slow-crawl → bundle-pump → migrate" scam pattern.
 *
 * Provide a list of known example mints (SEEDS). The script:
 *   1. Streams local JSONL exports + queries live DB for ONLY those mints.
 *   2. Reconstructs the per-mint trade timeline with market-cap progression.
 *   3. Identifies "early wallets" (active before the 20k MC threshold) and
 *      measures how many of them are SHARED across seeds (the smoking gun).
 *   4. Measures bundle-phase signals: volume spike, buy clustering, velocity.
 *   5. Prints a detection summary: what you can observe BEFORE 20k MC that
 *      reliably flags the pattern.
 *
 * Usage (run from backend/):
 *   node --max-old-space-size=512 scripts/bundlestudy.mjs
 *   node scripts/bundlestudy.mjs --no-db          # skip live DB
 *   node scripts/bundlestudy.mjs --no-exports     # skip local files
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
const DEFAULT_DB =
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

// ─── seeds ────────────────────────────────────────────────────────────────────
const SEEDS = new Set([
  "BRF1frPXwawTXBpPvWP5MjXbedX9SakRANK89SUhpump",
  "JCeibekvryvCzfN9eK7WKgRZ7dSg15UacL7fUspZpump",
  "58362FRym37k1j8H42hDxnEJLRRegbvBxkiBNq1wpump",
  "44irAmSmpjixNCsX82ZqmLchHLVGyXsMU6GeEv9jpump",
  "8aqh8vn3fkFmUBLN1G2v8x5Vw1wuCNobHFYYKzngpump",
  "8kHw8KXd32bMFZ2m5TQHo9eLtL8emkToxBTdWmqQpump",
]);

const PRE_BUNDLE_MC = 20_000;   // MC threshold that separates crawl from bundle phase
const BUNDLE_END_MC = 55_000;   // approximate migration ceiling
const CLUSTER_WINDOW_MS = 60_000; // trades within 60s count as a "cluster"

// ─── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const useDb = !argv.includes("--no-db");
const useExports = !argv.includes("--no-exports");

// ─── data structures ──────────────────────────────────────────────────────────
// mint -> { symbol, devWallet, createdMs }
const tokenMeta = new Map();
// mint -> [ { wallet, side, sol, mc, ts } ]
const tradesByMint = new Map();

for (const m of SEEDS) tradesByMint.set(m, []);

// ─── loaders ──────────────────────────────────────────────────────────────────
async function streamJsonl(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRow(JSON.parse(line)); } catch { /* skip */ }
  }
}

function addTrade(t) {
  const arr = tradesByMint.get(t.mint);
  if (!arr) return;
  arr.push({ wallet: t.wallet, side: t.side, sol: Number(t.sol) || 0, mc: Number(t.mc) || 0, ts: Number(t.ts) });
}

async function loadExports() {
  if (!fs.existsSync(EXPORTS_ROOT)) return;
  const dirs = fs
    .readdirSync(EXPORTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => path.join(EXPORTS_ROOT, d.name))
    .filter((d) => fs.existsSync(path.join(d, "tokens.jsonl")));

  for (const dir of dirs) {
    console.log(`  scanning ${path.basename(dir)}/tokens.jsonl …`);
    await streamJsonl(path.join(dir, "tokens.jsonl"), (t) => {
      if (!SEEDS.has(t.mint)) return;
      tokenMeta.set(t.mint, {
        symbol: t.symbol || "?",
        devWallet: t.dev_wallet || "",
        createdMs: Date.parse(t.created_at) || 0,
      });
    });

    console.log(`  scanning ${path.basename(dir)}/trades.jsonl … (may take a while)`);
    let n = 0;
    await streamJsonl(path.join(dir, "trades.jsonl"), (r) => {
      if (!SEEDS.has(r.mint)) return;
      n++;
      addTrade({
        mint: r.mint,
        wallet: r.wallet,
        side: r.side,
        sol: r.amount_sol ?? r.sol,
        mc: r.market_cap ?? r.mc,
        ts: r.ts ? (String(r.ts).length > 12 ? Number(r.ts) : Number(r.ts) * 1000) : Date.parse(r.created_at),
      });
    });
    console.log(`    → found ${n} matching trades`);
  }
}

async function loadDb() {
  const connectionString = process.env.DATABASE_URL || DEFAULT_DB;
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const mintList = [...SEEDS].map((m, i) => `$${i + 1}`).join(",");
    const seeds = [...SEEDS];

    const tk = await client.query(
      `SELECT mint, symbol, dev_wallet, extract(epoch from created_at)*1000 AS c
       FROM tokens WHERE mint = ANY($1)`,
      [seeds]
    );
    for (const r of tk.rows) {
      tokenMeta.set(r.mint, {
        symbol: r.symbol || "?",
        devWallet: r.dev_wallet || "",
        createdMs: Number(r.c) || 0,
      });
    }

    const tr = await client.query(
      `SELECT mint, wallet, side, amount_sol::float8 AS sol,
              market_cap::float8 AS mc,
              extract(epoch from ts)*1000 AS ts
       FROM trades WHERE mint = ANY($1)
       ORDER BY ts`,
      [seeds]
    );
    console.log(`  DB: ${tr.rows.length} trades for seeds`);
    for (const r of tr.rows) {
      addTrade({ mint: r.mint, wallet: r.wallet, side: r.side, sol: r.sol, mc: r.mc, ts: Number(r.ts) });
    }
  } catch (err) {
    console.warn(`  DB skipped: ${err.message}`);
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

// ─── analysis ─────────────────────────────────────────────────────────────────
function analyseToken(mint, trades, meta) {
  if (!trades.length) return null;
  trades.sort((a, b) => a.ts - b.ts);

  const t0 = meta?.createdMs || trades[0].ts;
  const symbol = meta?.symbol || mint.slice(0, 6);
  const devWallet = meta?.devWallet || "";

  // Split into phases
  const preTrades = trades.filter((t) => t.mc > 0 && t.mc < PRE_BUNDLE_MC);
  const bundleTrades = trades.filter((t) => t.mc >= PRE_BUNDLE_MC && t.mc < BUNDLE_END_MC);
  const allBuys = trades.filter((t) => t.side === "buy");

  // When did MC first exceed 20k?
  const firstBundle = bundleTrades[0];
  const msTo20k = firstBundle ? firstBundle.ts - t0 : null;

  // --- pre-bundle fingerprint ---
  const preWallets = new Set(preTrades.filter((t) => t.side === "buy").map((t) => t.wallet));
  const preVolSol = preTrades.filter((t) => t.side === "buy").reduce((s, t) => s + t.sol, 0);
  const preBuyCount = preTrades.filter((t) => t.side === "buy").length;
  const preSellCount = preTrades.filter((t) => t.side === "sell").length;

  // --- bundle fingerprint ---
  const bundleWallets = new Set(bundleTrades.filter((t) => t.side === "buy").map((t) => t.wallet));
  const bundleVolSol = bundleTrades.filter((t) => t.side === "buy").reduce((s, t) => s + t.sol, 0);
  const bundleBuyCount = bundleTrades.filter((t) => t.side === "buy").length;

  // Clustering: max buys in any 60s window during bundle phase
  let maxCluster = 0;
  for (let i = 0; i < bundleTrades.length; i++) {
    const window = bundleTrades.filter(
      (t) => t.side === "buy" && t.ts >= bundleTrades[i].ts && t.ts < bundleTrades[i].ts + CLUSTER_WINDOW_MS
    );
    if (window.length > maxCluster) maxCluster = window.length;
  }

  // How many pre-bundle wallets also appear in the bundle phase?
  const preInBundle = [...preWallets].filter((w) => bundleWallets.has(w)).length;

  // Velocity change: avg sol/min in pre vs bundle
  const preDurationMin = preTrades.length > 1
    ? (preTrades[preTrades.length - 1].ts - preTrades[0].ts) / 60000 || 1 : 1;
  const bundleDurationMin = bundleTrades.length > 1
    ? (bundleTrades[bundleTrades.length - 1].ts - bundleTrades[0].ts) / 60000 || 1 : 1;
  const preVelSolMin = preVolSol / preDurationMin;
  const bundleVelSolMin = bundleVolSol / bundleDurationMin;
  const velMultiplier = preVelSolMin > 0 ? bundleVelSolMin / preVelSolMin : 0;

  // First few buys (earlyest 10) — look for large single buys
  const first10 = allBuys.slice(0, 10);
  const maxEarlyBuy = Math.max(...first10.map((t) => t.sol), 0);

  return {
    mint, symbol, devWallet,
    t0, msTo20k,
    preBuyCount, preSellCount, preWallets, preVolSol,
    bundleBuyCount, bundleWallets, bundleVolSol,
    preInBundle,
    maxCluster,
    velMultiplier,
    maxEarlyBuy,
    totalTrades: trades.length,
  };
}

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a"; }
const fmt = (n) => n.toFixed(2);
const fmtMs = (ms) => {
  if (ms === null) return "?";
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
};

// ─── main ─────────────────────────────────────────────────────────────────────
console.log("\n=== Bundle-Pump Study ===\n");
console.log(`Seeds: ${[...SEEDS].length} tokens`);

if (useExports) {
  console.log("\n[1/2] Scanning local exports …");
  await loadExports();
}
if (useDb) {
  console.log("\n[2/2] Querying live DB …");
  await loadDb();
}

// Sort and deduplicate by (wallet, side, ts) — DB and export may overlap
for (const [mint, arr] of tradesByMint) {
  const seen = new Set();
  const deduped = arr.filter((t) => {
    const k = `${t.wallet}:${t.side}:${t.ts}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) => a.ts - b.ts);
  tradesByMint.set(mint, deduped);
}

console.log("\n─── Per-token breakdown ───────────────────────────────────────────\n");

const results = [];
for (const [mint, trades] of tradesByMint) {
  const meta = tokenMeta.get(mint);
  const r = analyseToken(mint, trades, meta);
  if (!r) {
    console.log(`  $${meta?.symbol || mint.slice(0,8)}  — NO DATA FOUND`);
    continue;
  }
  results.push(r);

  console.log(`$${r.symbol}  (${mint.slice(0, 12)}…)`);
  console.log(`  total trades       : ${r.totalTrades}`);
  console.log(`  time → 20k MC      : ${fmtMs(r.msTo20k)}`);
  console.log(`  pre-20k  buys/sells: ${r.preBuyCount} / ${r.preSellCount}  (${r.preWallets.size} unique wallets,  ${fmt(r.preVolSol)} SOL)`);
  console.log(`  bundle phase buys  : ${r.bundleBuyCount}  (${r.bundleWallets.size} unique wallets,  ${fmt(r.bundleVolSol)} SOL)`);
  console.log(`  pre wallets → bundle: ${r.preInBundle}/${r.preWallets.size}  (${pct(r.preInBundle, r.preWallets.size)} crossover)`);
  console.log(`  velocity ×         : ${r.velMultiplier.toFixed(1)}x  (sol/min bundle vs pre)`);
  console.log(`  max cluster (60s)  : ${r.maxCluster} buys`);
  console.log(`  largest early buy  : ${fmt(r.maxEarlyBuy)} SOL`);
  if (r.devWallet) console.log(`  dev                : ${r.devWallet}`);
  console.log();
}

// ─── shared wallet analysis ───────────────────────────────────────────────────
console.log("─── Shared early wallets (pre-20k across ≥2 tokens) ──────────────\n");

const walletToTokens = new Map();
for (const r of results) {
  for (const w of r.preWallets) {
    const s = walletToTokens.get(w) || new Set();
    s.add(r.symbol);
    walletToTokens.set(w, s);
  }
}

const sharedWallets = [...walletToTokens.entries()]
  .filter(([, s]) => s.size >= 2)
  .sort((a, b) => b[1].size - a[1].size);

if (sharedWallets.length === 0) {
  console.log("  No wallet appeared in pre-20k phase of ≥2 seeds.");
  console.log("  (This could mean different operator wallets per token, or data gaps.)");
} else {
  console.log(`  Found ${sharedWallets.length} recurring early wallets:\n`);
  for (const [w, tokens] of sharedWallets.slice(0, 30)) {
    console.log(`  ${w}  →  ${[...tokens].join(", ")}`);
  }
}

// ─── dev wallet overlap ───────────────────────────────────────────────────────
const devWallets = [...new Set(results.map((r) => r.devWallet).filter(Boolean))];
console.log(`\n─── Dev wallets (${devWallets.length} unique across ${results.length} tokens) ───`);
const devCount = new Map();
for (const r of results) if (r.devWallet) devCount.set(r.devWallet, (devCount.get(r.devWallet) || 0) + 1);
for (const [w, c] of [...devCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${w}  (${c} tokens)`);
}

// ─── detection summary ────────────────────────────────────────────────────────
console.log("\n─── Detection signal summary ──────────────────────────────────────\n");

if (results.length > 0) {
  const avg = (fn) => results.reduce((s, r) => s + fn(r), 0) / results.length;
  console.log("  Average across seeds:");
  console.log(`    time to 20k MC     : ${fmtMs(avg((r) => r.msTo20k ?? 0))}`);
  console.log(`    pre-20k buy count  : ${avg((r) => r.preBuyCount).toFixed(1)}`);
  console.log(`    pre-20k sell count : ${avg((r) => r.preSellCount).toFixed(1)}`);
  console.log(`    pre-20k vol (SOL)  : ${avg((r) => r.preVolSol).toFixed(2)}`);
  console.log(`    pre-20k wallets    : ${avg((r) => r.preWallets.size).toFixed(1)}`);
  console.log(`    velocity spike     : ${avg((r) => r.velMultiplier).toFixed(1)}x`);
  console.log(`    max 60s cluster    : ${avg((r) => r.maxCluster).toFixed(1)} buys`);
  console.log(`    largest early buy  : ${avg((r) => r.maxEarlyBuy).toFixed(3)} SOL`);

  const buyToSell = results.map((r) => r.preSellCount > 0 ? r.preBuyCount / r.preSellCount : r.preBuyCount);
  console.log(`    buy/sell ratio     : ${(buyToSell.reduce((a, b) => a + b, 0) / buyToSell.length).toFixed(1)}`);
}

console.log(`\n  Shared early wallets : ${sharedWallets.length} wallets seen pre-20k in ≥2 tokens`);
console.log(`  Same dev wallet      : ${devWallets.length === 1 ? "YES — single operator" : devWallets.length + " different devs"}`);

// ─── what can you flag BEFORE 20k? ───────────────────────────────────────────
console.log("\n─── Early detection playbook ──────────────────────────────────────\n");
console.log("  Signals observable BEFORE 20k MC (the bundle kick-off):");
console.log("  1. Very few sells relative to buys (buys only, no pressure relief)");
console.log("  2. Low but steady buy velocity — then a sudden spike (velocity × > 5)");
console.log("  3. Early wallet(s) in the pre-20k phase that appear on known bundle tokens");
console.log("  4. Dev wallet matches a known bundler (check devCount above)");
console.log("  5. Large single early buy (>0.5 SOL) with no corresponding sell");
console.log("  6. Fewer than ~20 unique buyers at 10k MC (thin, no organic spread)");
console.log();

console.log("Done.\n");
