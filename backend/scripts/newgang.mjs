/**
 * newgang.mjs — stream-search the pumpfundata trades.jsonl for 4 target mints,
 * find early buyers, cross-check against gangWallets.json.
 *
 * Usage: node --max-old-space-size=512 scripts/newgang.mjs
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_ROOT = path.resolve(__dirname, "..", "exports");
const TRADES_FILE = path.join(EXPORTS_ROOT, "pumpfundata-pump_fun", "trades.jsonl");
const TOKENS_FILE = path.join(EXPORTS_ROOT, "pumpfundata-pump_fun", "tokens.jsonl");

const SEEDS = new Set([
  "9VsMhN46CJdn8Zyo1BEVbMDvQopt8nCE7znAEwpUpump",
  "5Umo7FpVnevvPDxGWyeZZW2N2bcgfhEMiZWgiXP1pump",
  "AWvNAvCu7Rmmpp6Fqfmg9zqSYkVfFWn3Xf8jsnSWpump",
  "DzNXtgo1bzvMSHH5snZCikxAMLAxAxN2jjDBmds2pump",
]);

const PRE_BUNDLE_MC = 18_000;

const gangPath = path.resolve(__dirname, "lib", "gangWallets.json");
const existingGang = fs.existsSync(gangPath)
  ? new Set(JSON.parse(fs.readFileSync(gangPath, "utf8")))
  : new Set();
console.log(`Loaded ${existingGang.size} existing gang wallets`);

// ─── stream trades.jsonl ──────────────────────────────────────────────────────
console.log(`\nStreaming ${TRADES_FILE}…`);
console.log("(This file is ~14GB — may take a few minutes)\n");

const mintTrades = new Map(); // mint -> [{wallet, sol, mc, isBuy}]
for (const m of SEEDS) mintTrades.set(m, []);

let lineCount = 0;
let hitCount = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(TRADES_FILE),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  lineCount++;
  if (lineCount % 2_000_000 === 0) {
    process.stdout.write(`  Lines: ${(lineCount / 1e6).toFixed(1)}M  Hits: ${hitCount}\r`);
  }
  // Fast pre-filter: check if ANY seed mint appears in the line before parsing JSON
  let seedHit = false;
  for (const m of SEEDS) {
    if (line.includes(m)) { seedHit = true; break; }
  }
  if (!seedHit) continue;

  let row;
  try { row = JSON.parse(line); } catch { continue; }

  const mint = row.mint ?? row.token;
  if (!SEEDS.has(mint)) continue;

  mintTrades.get(mint).push({
    wallet: row.wallet ?? row.user ?? row.trader,
    sol: Number(row.amount_sol ?? row.sol ?? 0),
    mc: Number(row.market_cap ?? row.mc ?? row.usd_market_cap ?? 0),
    isBuy: row.is_buy !== false && row.is_buy !== 0 && row.side !== "sell",
    ts: row.timestamp ?? row.created_at ?? 0,
  });
  hitCount++;
}

console.log(`\n\nScanned ${(lineCount / 1e6).toFixed(1)}M lines — found ${hitCount} matching trades\n`);

// ─── analyse each mint ────────────────────────────────────────────────────────
function analyseMint(trades) {
  if (!trades.length) return null;
  trades.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // Pre-bundle: trades before PRE_BUNDLE_MC threshold
  const preBundleBuyers = new Map();
  const allBuyers = new Map();
  let peakMc = 0;

  for (const t of trades) {
    if (!t.wallet) continue;
    if (t.mc > peakMc) peakMc = t.mc;

    if (t.isBuy) {
      if (!allBuyers.has(t.wallet)) allBuyers.set(t.wallet, { buys: 0, totalSol: 0, maxSol: 0 });
      const b = allBuyers.get(t.wallet);
      b.buys++;
      b.totalSol += t.sol;
      if (t.sol > b.maxSol) b.maxSol = t.sol;

      if (t.mc < PRE_BUNDLE_MC || t.mc === 0) {
        if (!preBundleBuyers.has(t.wallet)) preBundleBuyers.set(t.wallet, { buys: 0, totalSol: 0, maxSol: 0 });
        const pb = preBundleBuyers.get(t.wallet);
        pb.buys++;
        pb.totalSol += t.sol;
        if (t.sol > pb.maxSol) pb.maxSol = t.sol;
      }
    }
  }

  return { preBundleBuyers, allBuyers, peakMc, total: trades.length };
}

const mintStats = {};
for (const [mint, trades] of mintTrades) {
  console.log(`${"═".repeat(64)}`);
  console.log(`Mint: ${mint}`);

  if (trades.length === 0) {
    console.log("  NOT FOUND in trades.jsonl");
    console.log("  → This token launched AFTER our data cutoff (likely today, May 31)");
    mintStats[mint] = null;
    continue;
  }

  const stats = analyseMint(trades);
  mintStats[mint] = stats;
  const { preBundleBuyers, allBuyers, peakMc } = stats;

  console.log(`  Trades: ${trades.length}  |  Unique buyers: ${allBuyers.size}  |  Peak MC: $${peakMc > 0 ? Math.round(peakMc).toLocaleString() : "?"}`);
  console.log(`  Pre-bundle wallets (<$${PRE_BUNDLE_MC.toLocaleString()} MC): ${preBundleBuyers.size}`);

  const sorted = [...preBundleBuyers.entries()].sort((a, b) => b[1].totalSol - a[1].totalSol);
  const knownHits = sorted.filter(([w]) => existingGang.has(w));
  const newHits = sorted.filter(([w]) => !existingGang.has(w));

  if (knownHits.length > 0) {
    console.log(`\n  ✓ KNOWN gang wallets (${knownHits.length}):`);
    for (const [w, d] of knownHits) {
      console.log(`    ${w}  buys=${d.buys}  total=${d.totalSol.toFixed(3)}◎  max=${d.maxSol.toFixed(3)}◎`);
    }
  } else {
    console.log("  No existing gang wallets in pre-bundle phase");
  }

  console.log("\n  Top new pre-bundle wallets:");
  for (const [w, d] of newHits.slice(0, 10)) {
    console.log(`  ${w}  buys=${d.buys}  total=${d.totalSol.toFixed(3)}◎  max=${d.maxSol.toFixed(3)}◎`);
  }
  console.log();
}

// ─── cross-mint analysis ──────────────────────────────────────────────────────
console.log(`${"═".repeat(64)}`);
console.log("CROSS-MINT ANALYSIS — wallets in 2+ of the 4 tokens");
console.log("═".repeat(64));

const walletMints = new Map();
for (const [mint, stats] of Object.entries(mintStats)) {
  if (!stats) continue;
  for (const [wallet] of stats.preBundleBuyers) {
    if (!walletMints.has(wallet)) walletMints.set(wallet, new Set());
    walletMints.get(wallet).add(mint);
  }
}

const shared = [...walletMints.entries()].filter(([, m]) => m.size >= 2).sort((a, b) => b[1].size - a[1].size);
const newShared = shared.filter(([w]) => !existingGang.has(w));
const knownShared = shared.filter(([w]) => existingGang.has(w));

console.log(`\nShared wallets: ${shared.length}  |  known: ${knownShared.length}  |  NEW: ${newShared.length}`);

if (knownShared.length > 0) {
  console.log("\n[Known gang wallets active in new tokens — same gang, different mints:]");
  for (const [w, mints] of knownShared) {
    console.log(`  ${w}  → ${mints.size}/4 tokens`);
  }
}

if (newShared.length > 0) {
  console.log("\n[NEW wallet candidates — in 2+ tokens, not yet in gang list:]");
  for (const [w, mints] of newShared) {
    const amts = [...mints].map(m => {
      const d = mintStats[m]?.preBundleBuyers?.get(w);
      return d ? d.totalSol.toFixed(3) + "◎" : "?";
    });
    console.log(`  ${w}  (${mints.size}/4)  ${amts.join(" | ")}`);
  }
  const outPath = path.resolve(__dirname, "lib", "newGangCandidates.json");
  fs.writeFileSync(outPath, JSON.stringify(newShared.map(([w]) => w), null, 2));
  console.log(`\n→ Saved ${newShared.length} new wallet candidates to scripts/lib/newGangCandidates.json`);
}

// Single-token known gang hits
const anyKnown = [...walletMints.entries()].filter(([w]) => existingGang.has(w));
if (anyKnown.length > 0) {
  console.log("\n[Known gang wallet appearances (any single token):]");
  for (const [w, mints] of anyKnown) {
    console.log(`  ${w.slice(0, 16)}…  ${mints.size} token(s)`);
  }
}

const dataAvailable = Object.values(mintStats).filter(Boolean).length;
if (dataAvailable === 0) {
  console.log("\n⚠ NONE of the 4 tokens appear in our local data.");
  console.log("All 4 likely launched TODAY (May 31) — after our PumpFunData cutoff (May 30).");
  console.log("\nThese tokens are very fresh. Options:");
  console.log("  1. Look up each bonding curve on solscan.io manually:");
  console.log("     - 9VsMhN46…  BC: use bundleexpand to derive");
  console.log("  2. Wait for tomorrow's PumpFunData download to include today's data.");
  console.log("  3. Check if our LIVE system captured them in Railway DB (they may appear later).");
  console.log("\n  Most likely this is SAME gang but our detector MISSED them. Key question:");
  console.log("  Did any gang wallet buy BEFORE the bundle? Check with gangWallets.json against");
  console.log("  the pump.fun trade history on the website.");
}

console.log("\nDone.");
