/**
 * Wallet forensics — who is actually making money, and HOW do they trade?
 *
 * Reconstructs every wallet's per-token round-trips from the trades log and
 * computes REAL realized SOL PnL (SOL received from sells − SOL spent on buys;
 * unsold bags are treated as a loss, which is the conservative truth on
 * pump.fun). Then it profiles behavior — entry timing, hold time, scale-out,
 * flip rate — ranks winners vs losers, flags bot-like wallets, and extracts the
 * exit behavior of profitable round-trips so we can turn it into entry/exit rules.
 *
 * Read-only. Run against the live DB:   node scripts/walletstudy.mjs
 *           or a saved export:          node scripts/walletstudy.mjs exports/<timestamp>
 *
 * Tunables (env): MIN_TOKENS (5), MIN_VOL_SOL (1), TOP (30)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;

const MIN_TOKENS = Number(process.env.MIN_TOKENS ?? 5);
const MIN_VOL_SOL = Number(process.env.MIN_VOL_SOL ?? 1);
const TOP = Number(process.env.TOP ?? 30);

// ── Load data: from a JSONL export dir if given, else the live DB ────────────
const dirArg = process.argv[2];
let trades = [];
const createdMsByMint = new Map();

async function readJsonl(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) onRow(JSON.parse(line));
  }
}

if (dirArg) {
  const dir = path.resolve(process.cwd(), dirArg);
  console.log(`\nLoading export from ${dir} ...`);
  await readJsonl(path.join(dir, "tokens.jsonl"), (t) => {
    createdMsByMint.set(t.mint, Date.parse(t.created_at));
  });
  await readJsonl(path.join(dir, "trades.jsonl"), (r) => {
    trades.push({
      mint: r.mint,
      wallet: r.wallet,
      side: r.side,
      sol: Number(r.amount_sol) || 0,
      tok: Number(r.token_amount) || 0,
      mc: Number(r.market_cap) || 0,
      ts: Date.parse(r.ts)
    });
  });
} else {
  const CONNECTION =
    process.env.DATABASE_URL ||
    "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";
  console.log(`\nLoading from DB ...`);
  const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const tokens = await client.query(`SELECT mint, extract(epoch from created_at)*1000 AS c FROM tokens`);
  for (const t of tokens.rows) createdMsByMint.set(t.mint, Number(t.c));
  const tr = await client.query(
    `SELECT mint, wallet, side, amount_sol::float8 AS sol, token_amount::float8 AS tok,
            market_cap::float8 AS mc, extract(epoch from ts)*1000 AS ts
     FROM trades WHERE wallet <> 'UNKNOWN_WALLET'`
  );
  trades = tr.rows.map((r) => ({
    mint: r.mint, wallet: r.wallet, side: r.side,
    sol: Number(r.sol) || 0, tok: Number(r.tok) || 0, mc: Number(r.mc) || 0, ts: Number(r.ts)
  }));
  await client.end();
}

// ── Group into (wallet, mint) positions ──────────────────────────────────────
const posMap = new Map(); // key wallet|mint
for (const t of trades) {
  if (!t.wallet || t.wallet === "UNKNOWN_WALLET") continue;
  const key = t.wallet + "|" + t.mint;
  let p = posMap.get(key);
  if (!p) {
    p = { wallet: t.wallet, mint: t.mint, solIn: 0, solOut: 0, buys: 0, sells: 0,
          firstBuyTs: null, lastSellTs: null, entryMc: 0, exitMc: 0 };
    posMap.set(key, p);
  }
  if (t.side === "buy") {
    p.solIn += t.sol; p.buys++;
    if (p.firstBuyTs === null || t.ts < p.firstBuyTs) { p.firstBuyTs = t.ts; if (t.mc > 0) p.entryMc = t.mc; }
  } else if (t.side === "sell") {
    p.solOut += t.sol; p.sells++;
    if (p.lastSellTs === null || t.ts > p.lastSellTs) { p.lastSellTs = t.ts; if (t.mc > 0) p.exitMc = t.mc; }
  }
}

// ── Per-wallet aggregation ────────────────────────────────────────────────────
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const wallets = new Map();
for (const p of posMap.values()) {
  const realized = p.solOut - p.solIn;
  const closed = p.solOut > 0; // sold something
  const createdMs = createdMsByMint.get(p.mint);
  const entryDelay = createdMs && p.firstBuyTs ? (p.firstBuyTs - createdMs) / 1000 : null;
  const holdSec = closed && p.firstBuyTs && p.lastSellTs ? (p.lastSellTs - p.firstBuyTs) / 1000 : null;
  const solMult = p.solIn > 0 && closed ? p.solOut / p.solIn : null;
  const mcMult = p.entryMc > 0 && p.exitMc > 0 ? p.exitMc / p.entryMc : null;

  let w = wallets.get(p.wallet);
  if (!w) {
    w = { wallet: p.wallet, nPos: 0, nClosed: 0, wins: 0, solIn: 0, solOut: 0,
          holds: [], delays: [], buySizes: [], sellsPerPos: [], flips: 0, winTrips: [] };
    wallets.set(p.wallet, w);
  }
  w.nPos++;
  w.solIn += p.solIn;
  w.solOut += p.solOut;
  if (entryDelay !== null && entryDelay >= 0) w.delays.push(entryDelay);
  if (p.buys > 0) w.buySizes.push(p.solIn / p.buys);
  if (closed) {
    w.nClosed++;
    w.sellsPerPos.push(p.sells);
    if (holdSec !== null) { w.holds.push(holdSec); if (holdSec < 60) w.flips++; }
    if (realized > 0) {
      w.wins++;
      w.winTrips.push({ solMult, mcMult, holdSec });
    }
  }
}

// ── Rank ──────────────────────────────────────────────────────────────────────
const active = [...wallets.values()]
  .filter((w) => w.nPos >= MIN_TOKENS && w.solIn >= MIN_VOL_SOL)
  .map((w) => ({
    ...w,
    net: w.solOut - w.solIn,
    roi: w.solIn > 0 ? (w.solOut - w.solIn) / w.solIn : 0,
    winRate: w.nClosed ? w.wins / w.nClosed : 0,
    medHold: median(w.holds),
    medDelay: median(w.delays),
    medBuy: median(w.buySizes),
    flipRate: w.nClosed ? w.flips / w.nClosed : 0
  }));

const winners = active.filter((w) => w.net > 0).sort((a, b) => b.net - a.net);
const losers = active.filter((w) => w.net <= 0).sort((a, b) => a.net - b.net);

const f = (n, d = 2) => Number(n).toFixed(d);
const pct = (v) => (v * 100).toFixed(0) + "%";
const secs = (s) => (s >= 120 ? (s / 60).toFixed(1) + "m" : Math.round(s) + "s");

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log(` WALLET FORENSICS — ${trades.length.toLocaleString()} trades · ${posMap.size.toLocaleString()} positions · ${wallets.size.toLocaleString()} wallets`);
console.log(`   active filter: ≥${MIN_TOKENS} tokens & ≥${MIN_VOL_SOL} SOL in   →  ${active.length} wallets`);
console.log(`   PnL = SOL out − SOL in (unsold bags count as a loss)`);
console.log("══════════════════════════════════════════════════════════════════════");

console.log(`\n── TOP ${TOP} PROFITABLE WALLETS ───────────────────────────────────────`);
console.log("  wallet                                        netSOL   ROI   tok  win%  medHold  entryDelay flip%  buySOL");
for (const w of winners.slice(0, TOP)) {
  console.log(
    "  " + w.wallet.padEnd(44) +
    f(w.net).padStart(7) + (pct(w.roi)).padStart(7) +
    String(w.nPos).padStart(5) + pct(w.winRate).padStart(6) +
    secs(w.medHold).padStart(8) + secs(w.medDelay).padStart(11) +
    pct(w.flipRate).padStart(6) + f(w.medBuy).padStart(7)
  );
}

console.log(`\n── 10 BIGGEST LOSERS (for contrast) ──────────────────────────────────`);
console.log("  wallet                                        netSOL   ROI   tok  win%  medHold  entryDelay flip%");
for (const w of losers.slice(0, 10)) {
  console.log(
    "  " + w.wallet.padEnd(44) +
    f(w.net).padStart(7) + pct(w.roi).padStart(7) +
    String(w.nPos).padStart(5) + pct(w.winRate).padStart(6) +
    secs(w.medHold).padStart(8) + secs(w.medDelay).padStart(11) +
    pct(w.flipRate).padStart(6)
  );
}

// ── Winners vs losers: average behavior ──────────────────────────────────────
const avg = (arr, sel) => (arr.length ? arr.reduce((s, x) => s + sel(x), 0) / arr.length : 0);
console.log(`\n── WINNERS vs LOSERS (avg behavior) ──────────────────────────────────`);
console.log("  metric                 winners      losers");
const rows = [
  ["count", winners.length, losers.length, (v) => String(v)],
  ["median hold time", avg(winners, (w) => w.medHold), avg(losers, (w) => w.medHold), secs],
  ["entry delay (s)", avg(winners, (w) => w.medDelay), avg(losers, (w) => w.medDelay), secs],
  ["win rate", avg(winners, (w) => w.winRate), avg(losers, (w) => w.winRate), pct],
  ["flip rate (<60s)", avg(winners, (w) => w.flipRate), avg(losers, (w) => w.flipRate), pct],
  ["tokens traded", avg(winners, (w) => w.nPos), avg(losers, (w) => w.nPos), (v) => f(v, 0)],
  ["avg buy size SOL", avg(winners, (w) => w.medBuy), avg(losers, (w) => w.medBuy), (v) => f(v, 3)]
];
for (const [name, wv, lv, fmt] of rows) {
  console.log("  " + name.padEnd(22) + fmt(wv).padStart(8) + fmt(lv).padStart(12));
}

// ── Bot signatures: high volume + very consistent short holds ────────────────
const bots = active
  .filter((w) => w.nClosed >= 8 && w.medHold > 0 && w.medHold < 180)
  .map((w) => {
    const sorted = w.holds.slice().sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const q3 = sorted[Math.floor(sorted.length * 0.75)] || 0;
    return { ...w, holdSpread: q3 - q1 };
  })
  .sort((a, b) => b.nClosed - a.nClosed)
  .slice(0, 15);
console.log(`\n── LIKELY BOTS (≥8 closed trips, median hold <3m) ────────────────────`);
console.log("  wallet                                        trips medHold  flip%  win%   netSOL");
for (const w of bots) {
  console.log(
    "  " + w.wallet.padEnd(44) +
    String(w.nClosed).padStart(5) + secs(w.medHold).padStart(8) +
    pct(w.flipRate).padStart(7) + pct(w.winRate).padStart(6) + f(w.net).padStart(8)
  );
}

// ── Exit timing from WINNING round-trips of profitable wallets ───────────────
const winTrips = [];
for (const w of winners) for (const t of w.winTrips) if (t.solMult) winTrips.push(t);
winTrips.sort((a, b) => a.solMult - b.solMult);
const p = (q) => winTrips.length ? winTrips[Math.floor(winTrips.length * q)] : null;
console.log(`\n── EXIT BEHAVIOR of winning round-trips (n=${winTrips.length}) ─────────────`);
if (winTrips.length) {
  const ms = winTrips.map((t) => t.solMult);
  const hs = winTrips.filter((t) => t.holdSec != null).map((t) => t.holdSec).sort((a, b) => a - b);
  console.log(`  SOL multiple (out/in):  p25 ${f(p(0.25).solMult)}×   median ${f(p(0.5).solMult)}×   p75 ${f(p(0.75).solMult)}×   p90 ${f(p(0.9).solMult)}×`);
  console.log(`  hold time:              p25 ${secs(hs[Math.floor(hs.length*0.25)])}   median ${secs(hs[Math.floor(hs.length*0.5)])}   p75 ${secs(hs[Math.floor(hs.length*0.75)])}`);
  const quick = winTrips.filter((t) => t.holdSec != null && t.holdSec < 120).length;
  console.log(`  ${pct(quick / winTrips.length)} of winning exits happen within 2 minutes of entry.`);
}

console.log("\nDone.\n");
