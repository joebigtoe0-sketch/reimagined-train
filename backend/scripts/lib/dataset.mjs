/**
 * Shared dataset loader — merges ALL local exports (backend/exports/*) with the
 * live DB into one deduped dataset, so every analysis script learns from the
 * full history (pre-wipe export + post-wipe live data).
 *
 * The pre-wipe export and the current DB are disjoint in time (we wiped between
 * them), so the union is purely additive. Dedup keys guard against any overlap.
 *
 * Usage in a script:
 *   import { loadDataset } from "./lib/dataset.mjs";
 *   const { tokens, tradesByMint, outcomes } = await loadDataset();
 *
 * Flags (argv / env):
 *   --no-db          skip the live DB (fast, exports only)
 *   --no-exports     skip local exports (live DB only)
 *   --dir <path>     use only this export dir (repeatable)
 *   DATABASE_URL     override DB connection
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_ROOT = path.resolve(__dirname, "..", "..", "exports");
const DEFAULT_DB =
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

function parseFlags(argv) {
  const flags = { db: true, exports: true, dirs: [], dedup: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-db") flags.db = false;
    else if (argv[i] === "--no-exports") flags.exports = false;
    else if (argv[i] === "--dir") flags.dirs.push(argv[++i]);
    else if (argv[i] === "--no-dedup") flags.dedup = false; // skip the trade-dedup Set (saves GBs on huge single-source exports)
  }
  return flags;
}

function discoverExportDirs() {
  if (!fs.existsSync(EXPORTS_ROOT)) return [];
  return fs
    .readdirSync(EXPORTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(EXPORTS_ROOT, d.name))
    .filter((d) => fs.existsSync(path.join(d, "tokens.jsonl")));
}

async function readJsonl(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onRow(JSON.parse(line)); } catch { /* skip malformed */ }
  }
}

const tradeKey = (t) => `${t.signature || ""}:${t.mint}:${t.side}:${t.ts}`;

/**
 * @returns {Promise<{tokens: Map, tradesByMint: Map<string, Array>, outcomes: Map, sources: string[]}>}
 *  - tokens:       mint -> { mint, name, symbol, devWallet, createdMs, athMc, lifecycle, ... }
 *  - tradesByMint: mint -> [{ wallet, side, sol, mc, tokenAmt, ts, signature }] (sorted by ts)
 *  - outcomes:     mint -> { reached_25k, reached_100k, migrated, rugged }
 */
export async function loadDataset(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const tokens = new Map();
  const outcomes = new Map();
  const tradeSeen = new Set();
  const tradesByMint = new Map();
  const sources = [];

  // Intern repeated strings on the huge single-source path: ~44M trades share
  // only a few unique sides and ~1-2M wallets, so interning + dropping unused
  // fields (mint is the map key; tokenAmt/signature unused downstream) keeps the
  // dataset in heap instead of OOMing on multi-GB exports.
  const BUY = "buy", SELL = "sell";
  const walletIntern = new Map();
  const internWallet = (w) => { const s = walletIntern.get(w); if (s !== undefined) return s; walletIntern.set(w, w); return w; };

  const addTrade = (t) => {
    if (!t.wallet || t.wallet === "UNKNOWN_WALLET" || !t.mint) return;
    let a = tradesByMint.get(t.mint);
    if (flags.dedup) {
      const k = tradeKey(t);
      if (tradeSeen.has(k)) return;
      tradeSeen.add(k);
      if (!a) { a = []; tradesByMint.set(t.mint, a); }
      a.push(t);
      return;
    }
    if (!a) { a = []; tradesByMint.set(t.mint, a); }
    a.push({ wallet: internWallet(t.wallet), side: t.side === "buy" ? BUY : SELL, sol: t.sol, mc: t.mc, ts: t.ts });
  };
  const addToken = (tk) => { if (tk.mint && !tokens.has(tk.mint)) tokens.set(tk.mint, tk); };
  const addOutcome = (o) => {
    if (!o.mint) return;
    const prev = outcomes.get(o.mint);
    // OR-merge booleans so a positive label from any source sticks.
    outcomes.set(o.mint, {
      mint: o.mint,
      reached_25k: !!(prev?.reached_25k || o.reached_25k),
      reached_100k: !!(prev?.reached_100k || o.reached_100k),
      migrated: !!(prev?.migrated || o.migrated),
      rugged: !!(prev?.rugged || o.rugged)
    });
  };

  const exportDirs = flags.dirs.length
    ? flags.dirs.map((d) => path.resolve(process.cwd(), d))
    : flags.exports ? discoverExportDirs() : [];

  for (const dir of exportDirs) {
    sources.push(`export:${path.basename(dir)}`);
    await readJsonl(path.join(dir, "tokens.jsonl"), (t) =>
      addToken({
        mint: t.mint, name: t.name, symbol: t.symbol, devWallet: t.dev_wallet,
        createdMs: Date.parse(t.created_at), athMc: Number(t.ath_mc ?? t.current_mc) || 0,
        lifecycle: t.lifecycle, insiderConcentration: Number(t.insider_concentration) || 0
      })
    );
    await readJsonl(path.join(dir, "trades.jsonl"), (r) =>
      addTrade({ mint: r.mint, wallet: r.wallet, side: r.side, sol: Number(r.amount_sol) || 0, mc: Number(r.market_cap) || 0, tokenAmt: Number(r.token_amount) || 0, ts: Date.parse(r.ts), signature: r.signature })
    );
    await readJsonl(path.join(dir, "token_outcomes.jsonl"), addOutcome);
  }

  if (flags.db) {
    const connectionString = process.env.DATABASE_URL || DEFAULT_DB;
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      sources.push("db:live");
      const tk = await client.query(`SELECT mint, name, symbol, dev_wallet, extract(epoch from created_at)*1000 AS c, ath_mc::float8 AS ath, lifecycle, insider_concentration::float8 AS ins FROM tokens`);
      for (const t of tk.rows) addToken({ mint: t.mint, name: t.name, symbol: t.symbol, devWallet: t.dev_wallet, createdMs: Number(t.c), athMc: Number(t.ath) || 0, lifecycle: t.lifecycle, insiderConcentration: Number(t.ins) || 0 });
      const tr = await client.query(`SELECT mint, wallet, side, amount_sol::float8 AS sol, market_cap::float8 AS mc, token_amount::float8 AS ta, extract(epoch from ts)*1000 AS ts, signature FROM trades`);
      for (const r of tr.rows) addTrade({ mint: r.mint, wallet: r.wallet, side: r.side, sol: Number(r.sol) || 0, mc: Number(r.mc) || 0, tokenAmt: Number(r.ta) || 0, ts: Number(r.ts), signature: r.signature });
      const oc = await client.query(`SELECT mint, reached_25k, reached_100k, migrated, rugged FROM token_outcomes`);
      for (const o of oc.rows) addOutcome(o);
    } catch (err) {
      console.warn(`[dataset] DB load skipped: ${err instanceof Error ? err.message : err}`);
    } finally {
      try { await client.end(); } catch { /* noop */ }
    }
  }

  for (const a of tradesByMint.values()) a.sort((x, y) => x.ts - y.ts);

  // Derive a max-observed MC per token from trades (our MC label is laggy, but the
  // trade-stream peak is the best ground truth we have for "did it run").
  for (const [mint, arr] of tradesByMint) {
    const tk = tokens.get(mint);
    if (!tk) continue;
    let peak = tk.athMc || 0;
    for (const t of arr) if (t.mc > peak) peak = t.mc;
    tk.peakMc = peak;
  }

  return { tokens, tradesByMint, outcomes, sources };
}
