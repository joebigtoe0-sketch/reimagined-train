/**
 * PumpFunData backfill — turns purchased hourly Parquet history into a local
 * analysis dataset (no live SOL metering involved).
 *
 *   1. Downloads hourly Parquet files from https://api.pumpfundata.com (each file
 *      costs 1 credit). Raw files are CACHED to backend/exports/_pfd_raw/ and
 *      re-runs SKIP anything already on disk, so you never pay for a file twice.
 *   2. Parses them and writes the export format our analysis scripts read:
 *        backend/exports/pumpfundata-<exchange>/{tokens,trades,token_outcomes}.jsonl
 *      which loadDataset() (lib/dataset.mjs) auto-discovers and merges.
 *
 * Everything lives under backend/exports/ which is already .gitignored — local
 * only, never pushed.
 *
 * Setup: add your key to backend/.env →   PUMPFUNDATA_API_KEY=pfd_xxx
 *
 * Usage (run from backend/):
 *   node scripts/backfill.mjs                       # default: last 7 days, pump_fun
 *   node scripts/backfill.mjs --days 20             # more history (more credits)
 *   node scripts/backfill.mjs --start 2026-05-01 --end 2026-05-10
 *   node scripts/backfill.mjs --exchange pump_amm   # graduated-AMM trades
 *   node scripts/backfill.mjs --max-credits 480     # hard cap on credits to spend
 *   node scripts/backfill.mjs --parse-only          # re-parse cache, download nothing
 *
 * Credits = number of hourly files downloaded. The plan is printed before any
 * download so you can see the spend; the most RECENT hours are fetched first.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_ROOT = path.resolve(__dirname, "..", "exports");
const RAW_ROOT = path.join(EXPORTS_ROOT, "_pfd_raw");
const API = "https://api.pumpfundata.com";
const TOKEN_SUPPLY = 1_000_000_000; // pump.fun fixed supply (tokens)
const RATE_DELAY_MS = 2_200; // stay under the 30 req/min limit

function parseFlags(argv) {
  const f = { exchange: "pump_fun", days: 7, start: null, end: null, maxCredits: 240, parseOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exchange") f.exchange = argv[++i];
    else if (a === "--days") f.days = Number(argv[++i]);
    else if (a === "--start") f.start = argv[++i];
    else if (a === "--end") f.end = argv[++i];
    else if (a === "--max-credits") f.maxCredits = Number(argv[++i]);
    else if (a === "--parse-only") f.parseOnly = true;
  }
  if (f.exchange !== "pump_fun" && f.exchange !== "pump_amm") {
    throw new Error(`--exchange must be pump_fun or pump_amm (got ${f.exchange})`);
  }
  return f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** Build the descending (newest-first) list of {date, hour} in [start, end]. */
function hoursInRange(startDay, endDay) {
  const out = [];
  const start = new Date(`${startDay}T00:00:00Z`);
  const end = new Date(`${endDay}T23:00:00Z`);
  for (let t = end.getTime(); t >= start.getTime(); t -= 3_600_000) {
    const d = new Date(t);
    out.push({ date: dayStr(d), hour: pad2(d.getUTCHours()) });
  }
  return out;
}

async function getRange(key, exchange) {
  const res = await fetch(`${API}/range?exchange=${exchange}`, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`/range failed: ${res.status} ${await res.text()}`);
  return res.json(); // { exchange, start, end, files }
}

async function download(key, exchange, date, hour, dest) {
  const url = `${API}/download?exchange=${exchange}&date=${date}&hour=${hour}`;
  const res = await fetch(url, { headers: { "X-API-Key": key } });
  if (res.status === 404) return "missing"; // hour has no file — skip, no credit
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    throw new Error(`STOP — auth/credit error ${res.status}: ${await res.text()}`);
  }
  if (!res.ok) { console.warn(`  ! ${date} ${hour}: ${res.status}, skipping`); return "error"; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return "ok";
}

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

/** Bonding-curve / AMM market cap in USD from pool reserves. */
function marketCapUsd(row, exchange, solUsd) {
  let vlr, vtr;
  if (exchange === "pump_fun") { vlr = num(row.virtual_lamports_reserve); vtr = num(row.virtual_token_reserve); }
  else { vlr = num(row.real_lamports_reserve); vtr = num(row.real_token_reserve); }
  if (!vtr) return 0;
  // price(SOL/token) = (vlr/1e9 lamports) / (vtr/1e6 base units); MC = price * supply
  const mcSol = (vlr / vtr) * 1e6;
  return Math.round(mcSol * solUsd);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const key = process.env.PUMPFUNDATA_API_KEY;
  const solUsd = Number(process.env.SOL_USD_ESTIMATE) || 150;
  const rawDir = path.join(RAW_ROOT, flags.exchange);

  if (!flags.parseOnly) {
    if (!key) {
      console.error("✗ PUMPFUNDATA_API_KEY not set. Add it to backend/.env:\n    PUMPFUNDATA_API_KEY=pfd_your_key_here");
      process.exit(1);
    }
    const range = await getRange(key, flags.exchange);
    console.log(`available ${flags.exchange}: ${range.start} → ${range.end} (${range.files} files)`);

    let startDay = flags.start, endDay = flags.end || range.end;
    if (!startDay) {
      const d = new Date(`${endDay}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - (flags.days - 1));
      startDay = dayStr(d);
    }
    if (startDay < range.start) startDay = range.start;
    if (endDay > range.end) endDay = range.end;

    let hours = hoursInRange(startDay, endDay); // newest first
    const needed = hours.filter((h) => !fs.existsSync(path.join(rawDir, h.date, `${h.hour}.parquet`)));
    let toFetch = needed;
    if (needed.length > flags.maxCredits) {
      toFetch = needed.slice(0, flags.maxCredits); // newest within budget
      console.log(`⚠ ${needed.length} new hours exceeds --max-credits ${flags.maxCredits}; fetching the most recent ${flags.maxCredits}.`);
    }
    console.log(`window ${startDay} → ${endDay}: ${hours.length} hours, ${hours.length - needed.length} cached, downloading ${toFetch.length} (= ${toFetch.length} credits)\n`);

    let ok = 0, missing = 0, i = 0;
    for (const h of toFetch) {
      const dest = path.join(rawDir, h.date, `${h.hour}.parquet`);
      const r = await download(key, flags.exchange, h.date, h.hour, dest);
      if (r === "ok") ok++; else if (r === "missing") missing++;
      if (++i % 24 === 0 || i === toFetch.length) process.stdout.write(`\r  downloaded ${ok}, missing ${missing}  (${i}/${toFetch.length})   `);
      await sleep(RATE_DELAY_MS);
    }
    console.log(`\n✓ download done: ${ok} files (~${ok} credits spent), ${missing} hours had no file.\n`);
  }

  // ── parse the cache → export jsonl ─────────────────────────────────────────
  if (!fs.existsSync(rawDir)) { console.error(`no cached data at ${rawDir}`); process.exit(1); }
  const files = [];
  for (const date of fs.readdirSync(rawDir).sort()) {
    const dDir = path.join(rawDir, date);
    if (!fs.statSync(dDir).isDirectory()) continue;
    for (const f of fs.readdirSync(dDir).sort()) if (f.endsWith(".parquet")) files.push(path.join(dDir, f));
  }
  console.log(`parsing ${files.length} cached parquet file(s)...`);

  const outDir = path.join(EXPORTS_ROOT, `pumpfundata-${flags.exchange}`);
  fs.mkdirSync(outDir, { recursive: true });
  const tradesOut = fs.createWriteStream(path.join(outDir, "trades.jsonl"));
  const tokens = new Map(); // mint -> aggregate

  let nTrades = 0, nRows = 0;
  for (let fi = 0; fi < files.length; fi++) {
    const file = await asyncBufferFromFile(files[fi]);
    const rows = await parquetReadObjects({ file, compressors });
    for (const r of rows) {
      nRows++;
      const mint = r.token_mint;
      if (!mint) continue;
      const tsMs = Math.round(num(r.timestamp) * 1000);
      let tk = tokens.get(mint);
      if (!tk) { tk = { mint, name: "", symbol: "", dev: r.token_creator || "", createdMs: tsMs, peakMc: 0, migrated: false }; tokens.set(mint, tk); }
      if (r.token_creator && !tk.dev) tk.dev = r.token_creator;

      if (r.event_type === "create") {
        tk.name = r.name || tk.name;
        tk.symbol = r.symbol || tk.symbol;
        if (r.token_creator) tk.dev = r.token_creator;
        tk.createdMs = tsMs; // authoritative launch time
      } else if (r.event_type === "bonding_complete") {
        tk.migrated = true;
      } else if (r.event_type === "swap") {
        if (tsMs < tk.createdMs) tk.createdMs = tsMs;
        const mc = marketCapUsd(r, flags.exchange, solUsd);
        if (mc > tk.peakMc) tk.peakMc = mc;
        const wallet = r.user_wallet;
        if (wallet) {
          tradesOut.write(JSON.stringify({
            mint, wallet, side: r.action === "sell" ? "sell" : "buy",
            amount_sol: num(r.lamports_amount) / 1e9, market_cap: mc,
            token_amount: num(r.token_amount) / 1e6, ts: new Date(tsMs).toISOString(),
            signature: r.signature || ""
          }) + "\n");
          nTrades++;
        }
      }
    }
    if ((fi + 1) % 25 === 0 || fi === files.length - 1) process.stdout.write(`\r  parsed ${fi + 1}/${files.length} files, ${nTrades} trades   `);
  }
  await new Promise((res) => tradesOut.end(res));

  const tokensOut = fs.createWriteStream(path.join(outDir, "tokens.jsonl"));
  const outcomesOut = fs.createWriteStream(path.join(outDir, "token_outcomes.jsonl"));
  for (const tk of tokens.values()) {
    tokensOut.write(JSON.stringify({
      mint: tk.mint, name: tk.name, symbol: tk.symbol, dev_wallet: tk.dev,
      created_at: new Date(tk.createdMs).toISOString(), ath_mc: tk.peakMc,
      lifecycle: tk.migrated ? "migrated" : "new", insider_concentration: 0
    }) + "\n");
    outcomesOut.write(JSON.stringify({
      mint: tk.mint, reached_25k: tk.peakMc >= 25_000, reached_100k: tk.peakMc >= 100_000,
      migrated: tk.migrated, rugged: false
    }) + "\n");
  }
  await new Promise((res) => tokensOut.end(res));
  await new Promise((res) => outcomesOut.end(res));

  const winners15k = [...tokens.values()].filter((t) => t.peakMc >= 15_000).length;
  console.log(`\n\n✓ wrote ${outDir}`);
  console.log(`  tokens: ${tokens.size}  |  trades: ${nTrades}  |  rows scanned: ${nRows}`);
  console.log(`  peak≥$15k: ${winners15k}  |  migrated: ${[...tokens.values()].filter((t) => t.migrated).length}`);
  console.log(`\nNow run an analysis script (it auto-merges this export):  node scripts/playbook.mjs --no-db`);
}

main().catch((err) => { console.error("\n✗", err instanceof Error ? err.message : err); process.exit(1); });
