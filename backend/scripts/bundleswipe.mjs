/**
 * bundleswipe.mjs — quick parameter sweep for the bundle sniper strategy.
 * Tests combinations of MIN_TRIGGER_BUY_SOL and MIN_GANG_WALLETS_BEFORE_ENTRY.
 * Run from backend/: node scripts/bundleswipe.mjs --no-db
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

const EXIT_MC = 42_000;
const STOP_LOSS_FRAC = 0.70;
const SLIPPAGE_FRAC = 0.03;
const DEAD_WINDOW_MS = 10 * 60_000;
const argv = process.argv.slice(2);
const useDb = !argv.includes("--no-db");

const gangWallets = new Set(JSON.parse(fs.readFileSync(path.join(LIB_DIR, "gangWallets.json"), "utf8")));
const gangTokenList = JSON.parse(fs.readFileSync(path.join(LIB_DIR, "gangTokens.json"), "utf8"));
const gangMints = new Set(gangTokenList.map(t => t.mint));

// Load trades
const tradesByMint = new Map();
for (const m of gangMints) tradesByMint.set(m, []);

function parseMc(r) { return Number(r.market_cap ?? r.mc) || 0; }
function parseSol(r) { return Number(r.amount_sol ?? r.sol) || 0; }
function parseTs(r) {
  const v = r.ts ?? r.created_at;
  if (!v) return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  return Date.parse(String(v)) || 0;
}

async function streamJsonl(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRow(JSON.parse(line)); } catch { /* skip */ }
  }
}

const exportDirs = fs.existsSync(EXPORTS_ROOT)
  ? fs.readdirSync(EXPORTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("_"))
      .map(d => path.join(EXPORTS_ROOT, d.name))
      .filter(d => fs.existsSync(path.join(d, "trades.jsonl")))
  : [];

for (const dir of exportDirs) {
  process.stdout.write(`Loading ${path.basename(dir)} … `);
  let n = 0;
  await streamJsonl(path.join(dir, "trades.jsonl"), r => {
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
      `SELECT mint, wallet, side, amount_sol::float8, market_cap::float8, extract(epoch from ts)*1000 AS ts FROM trades WHERE mint = ANY($1)`,
      [[...gangMints]]
    );
    process.stdout.write(`DB: ${res.rows.length} … `);
    for (const r of res.rows) {
      const arr = tradesByMint.get(r.mint);
      if (arr) arr.push({ wallet: r.wallet, side: r.side, sol: Number(r.amount_sol)||0, mc: Number(r.market_cap)||0, ts: Number(r.ts)||0 });
    }
    console.log("done");
  } catch (e) { console.warn(`DB skipped: ${e.message}`); }
  finally { try { await client.end(); } catch { /* noop */ } }
}

for (const arr of tradesByMint.values()) arr.sort((a, b) => a.ts - b.ts);

// ─── sweep ─────────────────────────────────────────────────────────────────
function sim(minSol, minWallets) {
  let wins = 0, losses = 0, totalPnl = 0;
  for (const [, trades] of tradesByMint) {
    if (!trades.length) continue;
    const seenGang = new Set();
    let entryIdx = -1;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      if (t.side !== "buy" || !gangWallets.has(t.wallet) || t.mc <= 0) continue;
      seenGang.add(t.wallet);
      if (t.sol >= minSol && seenGang.size >= minWallets) { entryIdx = i; break; }
    }
    if (entryIdx < 0) continue;
    const entryMc = trades[entryIdx].mc;
    const stopMc = entryMc * STOP_LOSS_FRAC;
    let exitMc = null;
    let lastTs = trades[entryIdx].ts;
    let peakMc = entryMc;
    for (let i = entryIdx + 1; i < trades.length; i++) {
      const t = trades[i];
      if (t.mc > peakMc) peakMc = t.mc;
      if (t.ts - lastTs > DEAD_WINDOW_MS) { exitMc = t.mc > 0 ? t.mc : peakMc * 0.5; break; }
      lastTs = t.ts;
      if (t.mc >= EXIT_MC) { exitMc = EXIT_MC; break; }
      if (t.mc > 0 && t.mc <= stopMc) { exitMc = t.mc; break; }
    }
    if (exitMc === null) exitMc = trades[trades.length - 1].mc || peakMc * 0.3;
    const pnl = (exitMc / entryMc) * (1 - SLIPPAGE_FRAC) ** 2 - 1;
    totalPnl += pnl;
    if (pnl >= 0) wins++; else losses++;
  }
  const n = wins + losses;
  return { n, wr: n ? (wins/n*100).toFixed(1) : "0", avg: n ? (totalPnl/n*100).toFixed(1) : "0", tot: (totalPnl*100).toFixed(0) };
}

console.log("\n=== Bundle Strategy Parameter Sweep ===\n");
console.log("minSol  minW  trades  WR%   avgPnL%  totalEdge%");
console.log("────────────────────────────────────────────────");
for (const minSol of [0, 2, 4, 5, 6, 7, 8, 9]) {
  for (const minW of [1, 2, 3]) {
    const r = sim(minSol, minW);
    console.log(`≥${String(minSol).padEnd(4)} gW≥${minW}  ${String(r.n).padStart(5)}  ${String(r.wr).padStart(5)}%  ${String(r.avg).padStart(8)}%  ${String(r.tot).padStart(6)}%`);
  }
  console.log();
}
