/**
 * Copy-trade backtest with train/validation split — the honest test of
 * "follow the winners".
 *
 * TRAIN (older tokens): find "leader" wallets that made real money (net SOL,
 * enough round-trips, decent win rate). VALIDATION (newer, unseen tokens): for
 * each token, if a leader buys early we copy-enter at their entry MC and exit
 * when that same leader exits (or a time-stop). PnL is after a FEE that also
 * absorbs latency/slippage. If validation PnL is positive, the edge is real and
 * not survivorship — and it's directly deployable as live copy-trading.
 *
 * Read-only.  node scripts/copytrade.mjs [exports/<dir>]
 * Tunables (env): FEE_PCT(.04) SPLIT(.65) MIN_NET(5) MIN_TRIPS(5) MIN_WIN(.6)
 *                 ENTRY_WINDOW_S(120) HOLD_S(120) CONSENSUS(1)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const FEE = Number(process.env.FEE_PCT ?? 0.04);
const SPLIT = Number(process.env.SPLIT ?? 0.65);
const MIN_NET = Number(process.env.MIN_NET ?? 5);
const MIN_TRIPS = Number(process.env.MIN_TRIPS ?? 5);
const MIN_WIN = Number(process.env.MIN_WIN ?? 0.6);
const ENTRY_WINDOW_S = Number(process.env.ENTRY_WINDOW_S ?? 120);
const HOLD_S = Number(process.env.HOLD_S ?? 120);
const CONSENSUS = Number(process.env.CONSENSUS ?? 1);

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
    trades.push({ mint: r.mint, wallet: r.wallet, side: r.side, sol: Number(r.amount_sol) || 0, mc: Number(r.market_cap) || 0, ts: Date.parse(r.ts) })
  );
} else {
  const CONNECTION = process.env.DATABASE_URL ||
    "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";
  console.log(`\nLoading from DB ...`);
  const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const tk = await client.query(`SELECT mint, extract(epoch from created_at)*1000 AS c FROM tokens`);
  for (const t of tk.rows) createdMs.set(t.mint, Number(t.c));
  const tr = await client.query(`SELECT mint, wallet, side, amount_sol::float8 AS sol, market_cap::float8 AS mc, extract(epoch from ts)*1000 AS ts FROM trades`);
  trades = tr.rows.map((r) => ({ mint: r.mint, wallet: r.wallet, side: r.side, sol: Number(r.sol) || 0, mc: Number(r.mc) || 0, ts: Number(r.ts) }));
  await client.end();
}

// time split point
const times = [...createdMs.values()].filter((x) => x).sort((a, b) => a - b);
const splitTs = times[Math.floor(times.length * SPLIT)];
const isTrain = (mint) => (createdMs.get(mint) ?? Infinity) <= splitTs;

// trades per mint sorted
const byMint = new Map();
for (const t of trades) {
  if (!t.wallet || t.wallet === "UNKNOWN_WALLET") continue;
  let a = byMint.get(t.mint); if (!a) { a = []; byMint.set(t.mint, a); }
  a.push(t);
}
for (const a of byMint.values()) a.sort((x, y) => x.ts - y.ts);

// ── TRAIN: leader selection by realized net SOL ──────────────────────────────
const wstat = new Map(); // wallet -> {net, trips, wins, solIn}
for (const [mint, arr] of byMint) {
  if (!isTrain(mint)) continue;
  const pos = new Map(); // wallet -> {in,out}
  for (const t of arr) {
    let p = pos.get(t.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(t.wallet, p); }
    if (t.side === "buy") p.in += t.sol; else if (t.side === "sell") p.out += t.sol;
  }
  for (const [w, p] of pos) {
    if (p.out <= 0 && p.in <= 0) continue;
    let s = wstat.get(w); if (!s) { s = { net: 0, trips: 0, wins: 0, solIn: 0 }; wstat.set(w, s); }
    const realized = p.out - p.in;
    s.net += realized; s.solIn += p.in;
    if (p.out > 0) { s.trips++; if (realized > 0) s.wins++; }
  }
}
const leaders = new Set();
for (const [w, s] of wstat) {
  if (s.net >= MIN_NET && s.trips >= MIN_TRIPS && s.wins / Math.max(1, s.trips) >= MIN_WIN) leaders.add(w);
}

// ── VALIDATION: copy leaders on unseen tokens ────────────────────────────────
let entered = 0, wins = 0, sumNet = 0, covered = 0;
let valTokens = 0;
const nets = [];
for (const [mint, arr] of byMint) {
  if (isTrain(mint)) continue;
  valTokens++;
  const cms = createdMs.get(mint); if (!cms) continue;

  // collect early leader buys
  const leaderBuys = [];
  for (const t of arr) {
    if (t.side !== "buy" || !leaders.has(t.wallet) || t.mc <= 0) continue;
    if ((t.ts - cms) / 1000 > ENTRY_WINDOW_S) continue;
    leaderBuys.push(t);
  }
  if (leaderBuys.length < CONSENSUS) continue;
  covered++;

  // entry = the CONSENSUS-th distinct leader's buy (or first if consensus=1)
  const distinct = [];
  const seenL = new Set();
  for (const b of leaderBuys) { if (!seenL.has(b.wallet)) { seenL.add(b.wallet); distinct.push(b); } }
  if (distinct.length < CONSENSUS) continue;
  const entry = distinct[CONSENSUS - 1];
  const followWallet = distinct[0].wallet; // follow the first leader's exit
  const entryMc = entry.mc, entryTs = entry.ts;

  // exit = first leader (followWallet) sell after entry, else time-stop
  let exitMc = entryMc, exited = false;
  for (const t of arr) {
    if (t.ts <= entryTs || t.mc <= 0) continue;
    if (t.side === "sell" && t.wallet === followWallet) { exitMc = t.mc; exited = true; break; }
    if ((t.ts - entryTs) / 1000 >= HOLD_S) { exitMc = t.mc; exited = true; break; }
    exitMc = t.mc;
  }
  void exited;
  const net = (exitMc / entryMc) * (1 - FEE) - 1;
  nets.push(net); sumNet += net; entered++; if (net > 0) wins++;
}

nets.sort((a, b) => a - b);
const pct = (v) => (v * 100).toFixed(1) + "%";
const med = nets.length ? nets[Math.floor(nets.length / 2)] : 0;

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(` COPY-TRADE BACKTEST  (train/validation split @ ${pct(SPLIT)} by token age)`);
console.log(`   leaders: train net ≥${MIN_NET} SOL, ≥${MIN_TRIPS} trips, win ≥${pct(MIN_WIN)}  →  ${leaders.size} wallets`);
console.log(`   copy rule: enter when ${CONSENSUS} leader(s) buy ≤${ENTRY_WINDOW_S}s, exit on leader sell / ${HOLD_S}s stop`);
console.log(`   fee+slippage: ${pct(FEE)} round-trip`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(`\n  validation tokens:     ${valTokens.toLocaleString()}`);
console.log(`  tokens with a leader:  ${covered.toLocaleString()}  (${pct(covered / Math.max(1, valTokens))} coverage)`);
console.log(`  trades taken:          ${entered.toLocaleString()}`);
console.log(`  win rate:              ${pct(entered ? wins / entered : 0)}`);
console.log(`  avg net/trade:         ${pct(entered ? sumNet / entered : 0)}`);
console.log(`  median net/trade:      ${pct(med)}`);
console.log(`  total PnL (per 1 SOL): ${(sumNet >= 0 ? "+" : "") + sumNet.toFixed(1)}`);
console.log(`\nPositive avg net on VALIDATION = the leaders' edge persists out-of-sample.\n`);
