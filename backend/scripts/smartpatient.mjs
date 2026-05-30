/**
 * Smart-selection + patient-exit — the synthesis.
 *
 * Findings so far:
 *  - Scalpers win on speed we can't match (leaderdna.mjs).
 *  - A blind price-based entry rule is strongly negative (patientstrat.mjs):
 *    the profitable wallets' edge is SELECTION, not observable price action.
 *  - Copy-trade (follow their buys AND sells) validated positive but is
 *    latency-bound on the exit.
 *
 * Hypothesis tested here: use proven-profitable wallets ONLY as a selection
 * filter (≥N of them buy a fresh coin), then manage the exit OURSELVES with a
 * patient rule (TP / trailing / SL / time-stop over minutes). Because we hold
 * through their exit, being a few seconds late on entry no longer matters.
 *
 * Three time segments to avoid leakage:
 *   [0,50%)   define leaders (realized SOL profit)
 *   [50,75%)  tune exit params
 *   [75,100%) VALIDATE (out-of-sample)
 *
 *   node scripts/smartpatient.mjs [exports/<dir>]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const FEE = 0.96;
const CONSENSUS = 2;       // # distinct leaders that must buy
const ENTRY_MAX_S = 180;   // must form within first 3 min

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

const firsts = [...byMint].map(([m, a]) => [m, a[0].ts]).filter(([, t]) => t).sort((x, y) => x[1] - y[1]);
const t50 = firsts[Math.floor(firsts.length * 0.5)][1];
const t75 = firsts[Math.floor(firsts.length * 0.75)][1];
const seg = (lo, hi) => firsts.filter(([, t]) => t >= lo && (hi == null || t < hi)).map(([m]) => m);
const defMints = seg(0, t50), tuneMints = seg(t50, t75), valMints = seg(t75, null);

// leaders from definition segment only
const wstat = new Map();
for (const m of defMints) {
  const arr = byMint.get(m); const pos = new Map();
  for (const t of arr) { let p = pos.get(t.wallet); if (!p) { p = { in: 0, out: 0 }; pos.set(t.wallet, p); } if (t.side === "buy") p.in += t.sol; else p.out += t.sol; }
  for (const [w, p] of pos) { let s = wstat.get(w); if (!s) { s = { net: 0, trips: 0, wins: 0 }; wstat.set(w, s); } s.net += p.out - p.in; if (p.out > 0) { s.trips++; if (p.out - p.in > 0) s.wins++; } }
}
const leaders = new Set();
for (const [w, s] of wstat) if (s.net >= 5 && s.trips >= 5 && s.wins / s.trips >= 0.6) leaders.add(w);
console.log(`${byMint.size} tokens · ${leaders.size} leaders from def-segment · tune ${tuneMints.length} / val ${valMints.length}`);

function sim(arr, created, p) {
  if (!created) return null;
  // entry: when CONSENSUS distinct leaders have bought within ENTRY_MAX_S
  const seen = new Set(); let entry = null;
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i]; const ageS = (t.ts - created) / 1000;
    if (ageS > ENTRY_MAX_S) break;
    if (t.side === "buy" && t.mc > 0 && leaders.has(t.wallet)) {
      seen.add(t.wallet);
      if (seen.size >= CONSENSUS) { entry = { i, mc: t.mc, ts: t.ts }; break; }
    }
  }
  if (!entry) return null;
  let peak = entry.mc;
  for (let j = entry.i + 1; j < arr.length; j++) {
    const t = arr[j]; if (t.mc <= 0) continue;
    const held = (t.ts - entry.ts) / 1000;
    if (t.mc > peak) peak = t.mc;
    const mult = t.mc / entry.mc;
    if (mult >= p.tp) return p.tp * FEE - 1;
    if (mult <= p.sl) return mult * FEE - 1;
    if (peak > entry.mc && t.mc <= peak * (1 - p.trail)) return mult * FEE - 1;
    if (held >= p.maxHoldS) return mult * FEE - 1;
  }
  const last = arr[arr.length - 1];
  return (last.mc / entry.mc) * FEE - 1;
}
function evaluate(mints, p) {
  let n = 0, wins = 0, sum = 0;
  for (const m of mints) { const r = sim(byMint.get(m), createdMs.get(m), p); if (r == null) continue; n++; sum += r; if (r > 0) wins++; }
  return { n, winRate: n ? wins / n : 0, avg: n ? sum / n : 0, total: sum };
}

// also a copy-exit baseline: exit when first leader sells (or timestop)
function simCopy(arr, created, maxHoldS) {
  if (!created) return null;
  const seen = new Set(); let entry = null;
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i]; const ageS = (t.ts - created) / 1000;
    if (ageS > ENTRY_MAX_S) break;
    if (t.side === "buy" && t.mc > 0 && leaders.has(t.wallet)) { seen.add(t.wallet); if (seen.size >= CONSENSUS) { entry = { i, mc: t.mc, ts: t.ts }; break; } }
  }
  if (!entry) return null;
  for (let j = entry.i + 1; j < arr.length; j++) {
    const t = arr[j]; if (t.mc <= 0) continue;
    const held = (t.ts - entry.ts) / 1000;
    if (t.side === "sell" && leaders.has(t.wallet)) return (t.mc / entry.mc) * FEE - 1;
    if (held >= maxHoldS) return (t.mc / entry.mc) * FEE - 1;
  }
  const last = arr[arr.length - 1];
  return (last.mc / entry.mc) * FEE - 1;
}
function evalCopy(mints, maxHoldS) {
  let n = 0, wins = 0, sum = 0;
  for (const m of mints) { const r = simCopy(byMint.get(m), createdMs.get(m), maxHoldS); if (r == null) continue; n++; sum += r; if (r > 0) wins++; }
  return { n, winRate: n ? wins / n : 0, avg: n ? sum / n : 0, total: sum };
}

const grid = [];
for (const tp of [1.3, 1.5, 2.0, 3.0])
  for (const trail of [0.2, 0.3, 0.4])
    for (const sl of [0.6, 0.75])
      for (const maxHoldS of [180, 300, 600])
        grid.push({ tp, trail, sl, maxHoldS });

let best = null;
for (const p of grid) { const tu = evaluate(tuneMints, p); if (tu.n < 15) continue; if (!best || tu.avg > best.tu.avg) best = { p, tu }; }

console.log(`\n══ PATIENT EXIT (proven-wallet selection + our own exit) ════════════════`);
if (!best) {
  console.log("Not enough consensus signals in tune segment — CONSENSUS too strict or sparse data.");
} else {
  const p = best.p; const val = evaluate(valMints, p);
  console.log(`  selection: ≥${CONSENSUS} leaders buy within ${ENTRY_MAX_S}s`);
  console.log(`  best exit (tuned): TP ${p.tp}x · trail ${p.trail*100}% · SL ${p.sl}x · time-stop ${p.maxHoldS}s`);
  console.log(`  TUNE: ${best.tu.n} trades · win ${(best.tu.winRate*100).toFixed(0)}% · avg ${(best.tu.avg*100).toFixed(1)}%/trade`);
  console.log(`  VAL : ${val.n} trades · win ${(val.winRate*100).toFixed(0)}% · avg ${(val.avg*100).toFixed(1)}%/trade · total ${(val.total*100).toFixed(0)}%`);
}

console.log(`\n══ COPY EXIT baseline (exit when a leader sells) ════════════════════════`);
for (const h of [180, 300, 600]) {
  const v = evalCopy(valMints, h);
  console.log(`  timestop ${h}s: VAL ${v.n} trades · win ${(v.winRate*100).toFixed(0)}% · avg ${(v.avg*100).toFixed(1)}%/trade · total ${(v.total*100).toFixed(0)}%`);
}
console.log(`\nWhichever VAL avg%/trade is positive (and trade count is usable) wins.\n`);
