/**
 * Deep dive on a SINGLE wallet — reconstruct every position and profile exactly
 * how it trades: entry timing vs launch, hold time, scale in/out, realized SOL
 * PnL per coin, win/loss, selectivity (coins/day).
 *
 * Run:  node scripts/walletdeep.mjs <wallet> [exports/<dir>]
 *       (no dir → live DB)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const WALLET = process.argv[2];
if (!WALLET) { console.error("Usage: node scripts/walletdeep.mjs <wallet> [exports/<dir>]"); process.exit(1); }
const dirArg = process.argv[3];

let trades = [];
const created = new Map();
const sym = new Map();

async function readJsonl(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) onRow(JSON.parse(line));
}

if (dirArg) {
  const dir = path.resolve(process.cwd(), dirArg);
  console.log(`\nLoading export from ${dir} ...`);
  await readJsonl(path.join(dir, "tokens.jsonl"), (t) => { created.set(t.mint, Date.parse(t.created_at)); sym.set(t.mint, t.symbol || t.mint.slice(0, 6)); });
  await readJsonl(path.join(dir, "trades.jsonl"), (r) => {
    if (r.wallet !== WALLET) return;
    trades.push({ mint: r.mint, side: r.side, sol: Number(r.amount_sol) || 0, tok: Number(r.token_amount) || 0, mc: Number(r.market_cap) || 0, ts: Date.parse(r.ts) });
  });
} else {
  const CONNECTION = process.env.DATABASE_URL ||
    "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";
  console.log(`\nLoading from DB ...`);
  const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const tr = await client.query(
    `SELECT tr.mint, tr.side, tr.amount_sol::float8 AS sol, tr.token_amount::float8 AS tok, tr.market_cap::float8 AS mc,
            extract(epoch from tr.ts)*1000 AS ts, t.symbol, extract(epoch from t.created_at)*1000 AS c
     FROM trades tr LEFT JOIN tokens t ON t.mint = tr.mint WHERE tr.wallet = $1 ORDER BY tr.ts ASC`,
    [WALLET]
  );
  for (const r of tr.rows) {
    trades.push({ mint: r.mint, side: r.side, sol: Number(r.sol) || 0, tok: Number(r.tok) || 0, mc: Number(r.mc) || 0, ts: Number(r.ts) });
    if (r.c) created.set(r.mint, Number(r.c));
    sym.set(r.mint, r.symbol || r.mint.slice(0, 6));
  }
  await client.end();
}

if (trades.length === 0) { console.log(`\nNo trades found for ${WALLET}.\n`); process.exit(0); }

// Build positions per mint
const pos = new Map();
for (const t of trades) {
  let p = pos.get(t.mint);
  if (!p) { p = { mint: t.mint, buys: [], sells: [] }; pos.set(t.mint, p); }
  (t.side === "buy" ? p.buys : p.sells).push(t);
}

const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const secs = (s) => (s == null ? "—" : s >= 120 ? (s / 60).toFixed(1) + "m" : Math.round(s) + "s");
const f = (n, d = 2) => Number(n).toFixed(d);

const rows = [];
let netTotal = 0, firstTs = Infinity, lastTs = 0;
for (const p of pos.values()) {
  const solIn = p.buys.reduce((s, x) => s + x.sol, 0);
  const solOut = p.sells.reduce((s, x) => s + x.sol, 0);
  const entryTs = p.buys.length ? Math.min(...p.buys.map((x) => x.ts)) : null;
  const exitTs = p.sells.length ? Math.max(...p.sells.map((x) => x.ts)) : null;
  const entryMc = p.buys.length ? p.buys.slice().sort((a, b) => a.ts - b.ts)[0].mc : 0;
  const exitMc = p.sells.length ? p.sells.slice().sort((a, b) => a.ts - b.ts).at(-1).mc : 0;
  const cms = created.get(p.mint);
  const realized = solOut - solIn;
  netTotal += realized;
  if (entryTs) { firstTs = Math.min(firstTs, entryTs); lastTs = Math.max(lastTs, entryTs); }
  rows.push({
    sym: sym.get(p.mint) || p.mint.slice(0, 6),
    mint: p.mint,
    entryDelay: cms && entryTs ? (entryTs - cms) / 1000 : null,
    hold: entryTs && exitTs ? (exitTs - entryTs) / 1000 : null,
    nBuys: p.buys.length, nSells: p.sells.length,
    solIn, solOut, realized,
    mult: solIn > 0 ? solOut / solIn : null,
    mcMult: entryMc > 0 && exitMc > 0 ? exitMc / entryMc : null,
    entryTs
  });
}
rows.sort((a, b) => (a.entryTs || 0) - (b.entryTs || 0));

const closed = rows.filter((r) => r.solOut > 0);
const wins = closed.filter((r) => r.realized > 0);
const activeDays = Math.max(1, (lastTs - firstTs) / 86400000);

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(` WALLET DEEP DIVE — ${WALLET}`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(`  tokens traded:        ${pos.size}`);
console.log(`  total trades:         ${trades.length}  (${trades.filter(t=>t.side==='buy').length} buys / ${trades.filter(t=>t.side==='sell').length} sells)`);
console.log(`  net realized SOL:     ${netTotal >= 0 ? "+" : ""}${f(netTotal)}`);
console.log(`  closed positions:     ${closed.length}   win rate: ${closed.length ? (wins.length / closed.length * 100).toFixed(0) : 0}%`);
console.log(`  median entry delay:   ${secs(median(rows.filter(r=>r.entryDelay!=null).map(r=>r.entryDelay)))}  (after launch)`);
console.log(`  median hold time:     ${secs(median(closed.map(r=>r.hold).filter(h=>h!=null)))}`);
console.log(`  median realized mult: ${f(median(closed.map(r=>r.mult).filter(Boolean)))}×`);
console.log(`  avg buy size:         ${f(median(rows.filter(r=>r.nBuys>0).map(r=>r.solIn/r.nBuys)),3)} SOL`);
console.log(`  scale in/out:         ${f(median(rows.map(r=>r.nBuys)),0)} buys / ${f(median(closed.map(r=>r.nSells)),0)} sells per position`);
console.log(`  selectivity:          ${f(pos.size/activeDays,1)} coins/day  (over ${f(activeDays,1)} days)`);
const flips = closed.filter(r => r.hold != null && r.hold < 60).length;
console.log(`  fast flips (<60s):    ${closed.length ? (flips/closed.length*100).toFixed(0) : 0}%`);

console.log(`\n── EVERY POSITION (chronological) ────────────────────────────────────`);
console.log("  symbol        entryDelay  hold     buys/sells   solIn  solOut   net      mult");
for (const r of rows) {
  console.log(
    "  " + (r.sym || "").padEnd(13).slice(0, 13) +
    secs(r.entryDelay).padStart(9) + secs(r.hold).padStart(9) +
    `${r.nBuys}/${r.nSells}`.padStart(11) +
    f(r.solIn).padStart(8) + f(r.solOut).padStart(8) +
    ((r.realized >= 0 ? "+" : "") + f(r.realized)).padStart(8) +
    (r.mult != null ? f(r.mult) + "×" : "—").padStart(8)
  );
}
console.log(`\n(net = SOL out − SOL in; positions with solOut 0 are still-held/never-sold bags)\n`);
