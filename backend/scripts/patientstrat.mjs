/**
 * Patient-strategy backtest — validate the archetype the data pointed to:
 *   ENTER ~60-120s after launch (no speed race) once the coin has SURVIVED and
 *   is still being bought, HOLD minutes, exit on take-profit / trailing-stop /
 *   stop-loss / time-stop. This is a strategy WE can execute (we're seconds
 *   behind, so tick-zero scalping is impossible; a 1-minute-in entry is not).
 *
 * Honest test: mechanical rule applied to EVERY token, train/validation split
 * by time, 4% round-trip fees. Entry/exit use the live marketCap series (same
 * one our engine computes), so results reflect what we could actually trade.
 *
 *   node scripts/patientstrat.mjs [exports/<dir>]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const FEE = 0.96; // 4% round-trip (fee + slippage), applied to exit proceeds

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
  if (t.mc <= 0) continue;
  let a = byMint.get(t.mint); if (!a) { a = []; byMint.set(t.mint, a); }
  a.push(t);
}
for (const a of byMint.values()) a.sort((x, y) => x.ts - y.ts);

// time split: older 60% = train, newer 40% = validation
const firsts = [...byMint].map(([m, a]) => [m, a[0].ts]).filter(([, t]) => t).sort((x, y) => x[1] - y[1]);
const splitTs = firsts[Math.floor(firsts.length * 0.6)][1];

/**
 * Simulate the rule on one token. Returns net return (e.g. +0.30) or null if no entry.
 * params: { entryMinS, entryMaxS, recentWin, minRecentTrades, tp, trail, sl, maxHoldS }
 */
function sim(arr, created, p) {
  if (!created) return null;
  // find entry: first trade in [entryMinS,entryMaxS] with sustained buying
  let entry = null;
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    const ageS = (t.ts - created) / 1000;
    if (ageS < p.entryMinS) continue;
    if (ageS > p.entryMaxS) break;
    // aliveness + momentum in the trailing window
    let rt = 0, net = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (arr[j].ts < t.ts - p.recentWin * 1000) break;
      rt++; net += arr[j].side === "buy" ? arr[j].sol : -arr[j].sol;
    }
    if (rt >= p.minRecentTrades && net > 0) { entry = { i, mc: t.mc, ts: t.ts }; break; }
  }
  if (!entry) return null;
  // manage position forward
  let peak = entry.mc;
  for (let j = entry.i + 1; j < arr.length; j++) {
    const t = arr[j];
    const held = (t.ts - entry.ts) / 1000;
    if (t.mc > peak) peak = t.mc;
    const mult = t.mc / entry.mc;
    if (mult >= p.tp) return p.tp * FEE - 1;                         // take profit
    if (mult <= p.sl) return mult * FEE - 1;                         // stop loss
    if (peak > entry.mc && t.mc <= peak * (1 - p.trail)) return mult * FEE - 1; // trailing
    if (held >= p.maxHoldS) return mult * FEE - 1;                   // time stop
  }
  // ran out of data: mark out at last seen price
  const last = arr[arr.length - 1];
  return (last.mc / entry.mc) * FEE - 1;
}

function evaluate(mints, p) {
  let n = 0, wins = 0, sum = 0;
  for (const m of mints) {
    const r = sim(byMint.get(m), createdMs.get(m), p);
    if (r == null) continue;
    n++; sum += r; if (r > 0) wins++;
  }
  return { n, winRate: n ? wins / n : 0, avg: n ? sum / n : 0, total: sum };
}

const trainMints = firsts.filter(([, t]) => t < splitTs).map(([m]) => m);
const valMints = firsts.filter(([, t]) => t >= splitTs).map(([m]) => m);
console.log(`${byMint.size} tokens · train ${trainMints.length} / val ${valMints.length}\n`);

const grid = [];
for (const entryMinS of [45, 60, 90])
  for (const [entryMaxS] of [[150], [240]])
    for (const minRecentTrades of [4, 8])
      for (const tp of [1.3, 1.5, 2.0])
        for (const trail of [0.25, 0.35])
          for (const sl of [0.7])
            for (const maxHoldS of [240, 360])
              grid.push({ entryMinS, entryMaxS, recentWin: 30, minRecentTrades, tp, trail, sl, maxHoldS });

let best = null;
for (const p of grid) {
  const tr = evaluate(trainMints, p);
  if (tr.n < 40) continue; // need enough signals
  if (!best || tr.avg > best.tr.avg) best = { p, tr };
}
if (!best) { console.log("No config produced enough trades on train."); process.exit(0); }

const val = evaluate(valMints, best.p);
const p = best.p;
console.log(`══ BEST CONFIG (chosen on TRAIN by avg return/trade) ════════════════════`);
console.log(`  enter age ${p.entryMinS}-${p.entryMaxS}s, need ≥${p.minRecentTrades} trades & net+ in last ${p.recentWin}s`);
console.log(`  exit: TP ${p.tp}x · trail ${p.trail*100}% · SL ${p.sl}x · time-stop ${p.maxHoldS}s · fee ${((1-FEE)*100).toFixed(0)}%`);
console.log(`\n  TRAIN:      ${best.tr.n} trades · win ${(best.tr.winRate*100).toFixed(0)}% · avg ${(best.tr.avg*100).toFixed(1)}%/trade · total ${(best.tr.total*100).toFixed(0)}%`);
console.log(`  VALIDATION: ${val.n} trades · win ${(val.winRate*100).toFixed(0)}% · avg ${(val.avg*100).toFixed(1)}%/trade · total ${(val.total*100).toFixed(0)}%`);
console.log(`\n  → avg %/trade is AFTER ${((1-FEE)*100).toFixed(0)}% fees. Positive on VALIDATION = out-of-sample edge.\n`);

// show top 5 train configs for context
const scored = grid.map((pp) => ({ pp, tr: evaluate(trainMints, pp) })).filter((x) => x.tr.n >= 40)
  .sort((a, b) => b.tr.avg - a.tr.avg).slice(0, 5);
console.log(`── top 5 train configs ──`);
for (const s of scored) {
  const v = evaluate(valMints, s.pp);
  console.log(`  ${s.pp.entryMinS}-${s.pp.entryMaxS}s tp${s.pp.tp} trail${s.pp.trail} hold${s.pp.maxHoldS}s minT${s.pp.minRecentTrades}: ` +
    `train ${(s.tr.avg*100).toFixed(1)}%/t (n${s.tr.n})  →  val ${(v.avg*100).toFixed(1)}%/t (n${v.n}, win ${(v.winRate*100).toFixed(0)}%)`);
}
console.log();
