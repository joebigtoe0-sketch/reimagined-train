/**
 * Leader DNA — reverse-engineer WHY profitable wallets buy and sell, using only
 * features we can compute LIVE from the trade stream (so we can fire our own
 * orders on the same conditions instead of copy-trading them with lag).
 *
 * 1) Find leader wallets (proven realized SOL profit).
 * 2) At each leader ENTRY (their first buy on a coin), snapshot the observable
 *    state at that instant: token age, entry MC, #trades, #unique buyers, buy/
 *    sell ratio, net SOL in, recent velocity (trades in last 10s), short-term MC
 *    slope. Label it with the forward outcome (did MC rise +20% within 60s?).
 * 3) Compare those distributions to a CONTROL of random non-leader buys at
 *    similar age — the gaps are the entry signal.
 * 4) Profile leader EXITS: hold time, exit multiple, drawdown from local peak.
 *
 * Read-only.  node scripts/leaderdna.mjs [exports/<dir>]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const TP = 1.2;       // "good entry" = MC reached +20% ...
const FWD_MS = 60_000; // ... within 60s
const AGE_MIN_S = 5, AGE_MAX_S = 180; // entry/control age window

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

const byMint = new Map();
for (const t of trades) {
  if (!t.wallet || t.wallet === "UNKNOWN_WALLET") continue;
  let a = byMint.get(t.mint); if (!a) { a = []; byMint.set(t.mint, a); }
  a.push(t);
}
for (const a of byMint.values()) a.sort((x, y) => x.ts - y.ts);

// ── Leader selection (realized SOL profit) ───────────────────────────────────
const wstat = new Map();
for (const arr of byMint.values()) {
  const pos = new Map();
  for (const t of arr) { let p = pos.get(t.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(t.wallet, p); } if (t.side === "buy") p.in += t.sol; else p.out += t.sol; }
  for (const [w, p] of pos) { let s = wstat.get(w); if (!s) { s = { net: 0, trips: 0, wins: 0 }; wstat.set(w, s); } s.net += p.out - p.in; if (p.out > 0) { s.trips++; if (p.out - p.in > 0) s.wins++; } }
}
const leaders = new Set();
for (const [w, s] of wstat) if (s.net >= 5 && s.trips >= 5 && s.wins / s.trips >= 0.6) leaders.add(w);

// ── Feature snapshot at index i (state BEFORE trade i), entry price = arr[i].mc
function features(arr, i, created) {
  const e = arr[i];
  const ageS = (e.ts - created) / 1000;
  let buyers = new Set(), sells = 0, buys = 0, netSol = 0, vol = 0, vel10 = 0, mc10 = 0;
  for (let j = 0; j < i; j++) {
    const t = arr[j];
    if (t.side === "buy") { buys++; buyers.add(t.wallet); netSol += t.sol; } else { sells++; netSol -= t.sol; }
    vol += t.sol;
    if (t.ts >= e.ts - 10_000) vel10++;
    if (t.ts <= e.ts - 10_000) mc10 = t.mc;
  }
  if (mc10 === 0 && i > 0) mc10 = arr[0].mc;
  const slope = mc10 > 0 ? (e.mc - mc10) / mc10 : 0;
  // forward outcome: peak within FWD_MS
  let peak = e.mc;
  for (let j = i + 1; j < arr.length; j++) { if (arr[j].ts > e.ts + FWD_MS) break; if (arr[j].mc > peak) peak = arr[j].mc; }
  return { ageS, entryMc: e.mc, nTrades: i, buyers: buyers.size, buySell: sells > 0 ? buys / sells : buys, netSol, vol, vel10, slope, good: e.mc > 0 && peak / e.mc >= TP ? 1 : 0 };
}

const leaderEntries = [];
const control = [];
const exits = [];
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

for (const [mint, arr] of byMint) {
  const created = createdMs.get(mint); if (!created) continue;
  const seenLeader = new Set();
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (t.side !== "buy" || t.mc <= 0) continue;
    const ageS = (t.ts - created) / 1000;
    if (ageS < AGE_MIN_S || ageS > AGE_MAX_S) continue;
    if (leaders.has(t.wallet)) {
      if (seenLeader.has(t.wallet)) continue;
      seenLeader.add(t.wallet);
      leaderEntries.push(features(arr, i, created));
      // exit profile: this leader's last sell on this mint
      const sells = arr.filter((x) => x.wallet === t.wallet && x.side === "sell" && x.ts > t.ts && x.mc > 0);
      if (sells.length) {
        const ex = sells[sells.length - 1];
        let peak = t.mc;
        for (const x of arr) { if (x.ts > t.ts && x.ts <= ex.ts && x.mc > peak) peak = x.mc; }
        exits.push({ held: (ex.ts - t.ts) / 1000, mult: ex.mc / t.mc, ddFromPeak: peak > 0 ? (peak - ex.mc) / peak : 0 });
      }
    } else if (rand() < 0.06) {
      control.push(features(arr, i, created));
    }
  }
}

const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const f = (n, d = 2) => Number(n).toFixed(d);
const col = (a, sel) => { const v = a.map(sel); return `${f(q(v,.25))} / ${f(q(v,.5))} / ${f(q(v,.75))}`; };
const hit = (a) => (a.length ? (a.reduce((s, x) => s + x.good, 0) / a.length * 100).toFixed(0) + "%" : "—");

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(` LEADER DNA — ${leaders.size} leaders · ${leaderEntries.length} leader entries · ${control.length} control buys`);
console.log(`   "good entry" = MC reached +${((TP-1)*100).toFixed(0)}% within ${FWD_MS/1000}s   (age window ${AGE_MIN_S}-${AGE_MAX_S}s)`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(`\n  ★ GOOD-ENTRY HIT RATE:   leaders ${hit(leaderEntries)}   vs   control ${hit(control)}`);
console.log(`\n── ENTRY FEATURES  (p25 / median / p75) ──────────────────────────────`);
console.log("  feature                    leaders                control");
const feats = [
  ["token age (s)", (x) => x.ageS],
  ["entry MC ($)", (x) => x.entryMc],
  ["# trades before", (x) => x.nTrades],
  ["# unique buyers", (x) => x.buyers],
  ["buy/sell ratio", (x) => x.buySell],
  ["net SOL in", (x) => x.netSol],
  ["volume SOL", (x) => x.vol],
  ["velocity (trades/10s)", (x) => x.vel10],
  ["MC slope (last 10s)", (x) => x.slope]
];
for (const [name, sel] of feats) {
  console.log("  " + name.padEnd(24) + col(leaderEntries, sel).padEnd(22) + " " + col(control, sel));
}

console.log(`\n── EXIT DNA  (n=${exits.length}, p25 / median / p75) ──────────────────────`);
console.log("  hold time (s):        " + col(exits, (x) => x.held));
console.log("  exit multiple (MC):   " + col(exits, (x) => x.mult) + "×");
console.log("  drawdown from peak:   " + col(exits.map(x=>({v:x.ddFromPeak*100})), (x) => x.v) + "%");

console.log(`\nReading it: features where leaders' median diverges from control = the buy`);
console.log(`signal. Exit DNA = when/where they take profit. Build the rule from these.\n`);
