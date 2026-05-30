/**
 * Leader archetypes — find a profitable trading pattern we can ACTUALLY execute.
 *
 * The fast scalpers (leaderdna.mjs) win on sub-second speed + ~1.0x moves; we
 * can't reach that (we're seconds behind + pay ~4% fees). So here we measure
 * every profitable round-trip in REAL SOL (solOut/solIn) and segment by:
 *   - entry age (how late after launch they got in — later = reachable by us)
 *   - hold time (how long they held)
 * to locate the region that is profitable AFTER our 4% fee floor AND late enough
 * that our latency doesn't kill it.  Read-only.
 *
 *   node scripts/leaderarchetypes.mjs [exports/<dir>]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;
const FEE = 1.04; // round-trip multiple we must clear to net positive for us

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
    trades.push({ mint: r.mint, wallet: r.wallet, side: r.side, sol: Number(r.amount_sol) || 0, ts: Date.parse(r.ts) })
  );
} else {
  const CONNECTION = process.env.DATABASE_URL ||
    "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";
  console.log(`\nLoading from DB ...`);
  const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const tk = await client.query(`SELECT mint, extract(epoch from created_at)*1000 AS c FROM tokens`);
  for (const t of tk.rows) createdMs.set(t.mint, Number(t.c));
  const tr = await client.query(`SELECT mint, wallet, side, amount_sol::float8 AS sol, extract(epoch from ts)*1000 AS ts FROM trades`);
  trades = tr.rows.map((r) => ({ mint: r.mint, wallet: r.wallet, side: r.side, sol: Number(r.sol) || 0, ts: Number(r.ts) }));
  await client.end();
}

const byMint = new Map();
for (const t of trades) {
  if (!t.wallet || t.wallet === "UNKNOWN_WALLET") continue;
  let a = byMint.get(t.mint); if (!a) { a = []; byMint.set(t.mint, a); }
  a.push(t);
}
for (const a of byMint.values()) a.sort((x, y) => x.ts - y.ts);

// Reconstruct round-trips per (wallet, mint): a trip = buys then a flatten via sells.
// We treat the whole position on a mint as one trip (entry = first buy, exit = last sell).
const trips = []; // {wallet, entryAgeS, holdS, solIn, solOut, mult}
const wnet = new Map();
for (const [mint, arr] of byMint) {
  const created = createdMs.get(mint);
  const pos = new Map(); // wallet -> {in,out,firstBuyTs,lastSellTs}
  for (const t of arr) {
    let p = pos.get(t.wallet);
    if (!p) { p = { in: 0, out: 0, firstBuyTs: 0, lastSellTs: 0 }; pos.set(t.wallet, p); }
    if (t.side === "buy") { p.in += t.sol; if (!p.firstBuyTs) p.firstBuyTs = t.ts; }
    else { p.out += t.sol; p.lastSellTs = t.ts; }
  }
  for (const [w, p] of pos) {
    let n = wnet.get(w) || 0; wnet.set(w, n + (p.out - p.in));
    if (p.out > 0 && p.in > 0 && p.firstBuyTs && p.lastSellTs > p.firstBuyTs) {
      trips.push({
        wallet: w,
        entryAgeS: created ? (p.firstBuyTs - created) / 1000 : null,
        holdS: (p.lastSellTs - p.firstBuyTs) / 1000,
        solIn: p.in, solOut: p.out, mult: p.out / p.in
      });
    }
  }
}

// Profitable wallets only (the ones worth learning from).
const winners = new Set([...wnet].filter(([, n]) => n >= 5).map(([w]) => w));
const wtrips = trips.filter((t) => winners.has(t.wallet) && t.entryAgeS != null && t.entryAgeS >= 0);
console.log(`\n${winners.size} net-profitable wallets · ${wtrips.length} of their round-trips with clean entry/exit`);

const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const f = (n, d = 2) => Number(n).toFixed(d);
function summarize(label, arr) {
  if (!arr.length) { console.log("  " + label.padEnd(16) + " (none)"); return; }
  const m = arr.map((t) => t.mult);
  const win = arr.filter((t) => t.mult > 1).length / arr.length * 100;
  const winFee = arr.filter((t) => t.mult >= FEE).length / arr.length * 100;
  const med = q(m, 0.5), avg = m.reduce((s, x) => s + x, 0) / m.length;
  const hold = arr.map((t) => t.holdS);
  console.log(
    "  " + label.padEnd(16) +
    `n=${String(arr.length).padStart(5)}  win ${f(win,0)}%  win@fee ${f(winFee,0)}%  ` +
    `mult med ${f(med)}x avg ${f(avg)}x  hold med ${f(q(hold,0.5),0)}s`
  );
}

console.log(`\n══ BY ENTRY AGE (when they first bought after launch) ══════════════════`);
console.log(`   win@fee = % of trips clearing our ${((FEE-1)*100).toFixed(0)}% round-trip fee`);
const ageBuckets = [[0,5],[5,15],[15,30],[30,60],[60,120],[120,300],[300,1e9]];
for (const [lo, hi] of ageBuckets) summarize(`${lo}-${hi===1e9?"∞":hi}s`, wtrips.filter((t) => t.entryAgeS >= lo && t.entryAgeS < hi));

console.log(`\n══ BY HOLD TIME ════════════════════════════════════════════════════════`);
const holdBuckets = [[0,10],[10,30],[30,60],[60,120],[120,300],[300,900],[900,1e9]];
for (const [lo, hi] of holdBuckets) summarize(`${lo}-${hi===1e9?"∞":hi}s`, wtrips.filter((t) => t.holdS >= lo && t.holdS < hi));

console.log(`\n══ REACHABLE-BY-US region (entry age ≥ 15s) — by target multiple ════════`);
const reachable = wtrips.filter((t) => t.entryAgeS >= 15);
console.log(`  ${reachable.length} reachable trips (entered ≥15s after launch)`);
for (const tgt of [1.1, 1.25, 1.5, 2, 3]) {
  const hits = reachable.filter((t) => t.mult >= tgt).length;
  console.log(`  reached ≥${tgt}x : ${(hits/reachable.length*100).toFixed(1)}%  (${hits} trips)`);
}
const rfee = reachable.filter((t) => t.mult >= FEE).length / reachable.length * 100;
console.log(`  → ${f(rfee,0)}% of reachable trips clear our fee floor; median mult ${f(q(reachable.map(t=>t.mult),0.5))}x`);
console.log(`\nIf the reachable region still wins after fees, that's the strategy to build.\n`);
