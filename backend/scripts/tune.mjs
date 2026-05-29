/**
 * Closed-loop strategy tuner.
 *
 * Sweeps entry-gate thresholds × exit strategies against the matured-token
 * backtest, but with an honest TRAIN / VALIDATION split (older tokens train,
 * newer tokens validate) so we don't just overfit noise. It ranks configs by
 * train PnL, then re-scores the leaders out-of-sample. The winner is only
 * `promoted` (adopted by the live engine) if it ALSO makes money on the holdout
 * and clears a minimum sample size — otherwise it's written unpromoted and the
 * live engine keeps the conservative defaults.
 *
 * Writes config/strategy.json. Read-only against the DB.
 * Run:  node scripts/tune.mjs
 * Tunables (env): MATURITY_MIN, ENTRY_WINDOW_MIN, SLIP_PCT, MIN_SAMPLE, VAL_FRACTION
 */

import pg from "pg";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const MATURITY_MIN = Number(process.env.MATURITY_MIN ?? 25);
const ENTRY_WINDOW_MIN = Number(process.env.ENTRY_WINDOW_MIN ?? 5);
const SLIP_PCT = Number(process.env.SLIP_PCT ?? 4);
const MIN_SAMPLE = Number(process.env.MIN_SAMPLE ?? 8);
const VAL_FRACTION = Number(process.env.VAL_FRACTION ?? 0.3);
const FEE = 1 - SLIP_PCT / 100;
const ENTRY_MS = ENTRY_WINDOW_MIN * 60 * 1000;

// ── Parameter grid ───────────────────────────────────────────────────────────
const GRID = {
  minBuyers: [5, 8, 12, 15, 20],
  minAvgBuySol: [0.05, 0.1, 0.2],
  maxSellBuyRatio: [0.7, 1.0, 1.5],
  exit: ["hold_to_death", "tp_2x", "tp_3x", "trail_30", "trail_50"],
};

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `SELECT tr.mint, extract(epoch from tr.ts) * 1000 AS ts_ms, tr.side,
          tr.amount_sol::float8 AS sol, tr.market_cap::float8 AS mc, tr.wallet,
          extract(epoch from t.created_at) * 1000 AS created_ms
   FROM trades tr
   JOIN tokens t ON t.mint = tr.mint
   WHERE t.created_at < now() - ($1 || ' minutes')::interval
     AND tr.market_cap > 0
   ORDER BY tr.mint, tr.ts ASC`,
  [String(MATURITY_MIN)]
);
await client.end();

const byMint = new Map();
for (const r of rows) {
  let g = byMint.get(r.mint);
  if (!g) { g = { createdMs: Number(r.created_ms), trades: [] }; byMint.set(r.mint, g); }
  g.trades.push({ ts: Number(r.ts_ms), side: r.side, sol: Number(r.sol), mc: Number(r.mc), wallet: r.wallet });
}

// ── Build per-token features + cached exit returns for every strategy ─────────
function exitReturns(entryMc, post) {
  const lastMc = post.length ? post[post.length - 1].mc : entryMc;
  let peak = entryMc;
  const ex = { hold_to_death: lastMc, tp_2x: null, tp_3x: null, trail_30: null, trail_50: null };
  for (const tr of post) {
    if (tr.mc > peak) peak = tr.mc;
    if (ex.tp_2x === null && tr.mc >= entryMc * 2) ex.tp_2x = entryMc * 2;
    if (ex.tp_3x === null && tr.mc >= entryMc * 3) ex.tp_3x = entryMc * 3;
    if (ex.trail_30 === null && tr.mc <= peak * 0.7 && peak > entryMc) ex.trail_30 = tr.mc;
    if (ex.trail_50 === null && tr.mc <= peak * 0.5 && peak > entryMc) ex.trail_50 = tr.mc;
  }
  for (const k of ["tp_2x", "tp_3x", "trail_30", "trail_50"]) if (ex[k] === null) ex[k] = lastMc;
  const ret = {};
  for (const k of Object.keys(ex)) ret[k] = (ex[k] / entryMc) * FEE;
  return ret;
}

const tokens = [];
for (const [mint, g] of byMint) {
  const early = g.trades.filter((t) => t.ts - g.createdMs <= ENTRY_MS);
  if (early.length === 0) continue;
  const buys = early.filter((t) => t.side === "buy");
  const sells = early.filter((t) => t.side === "sell");
  const uniqueBuyers = new Set(buys.map((t) => t.wallet)).size;
  const avgBuySol = buys.length ? buys.reduce((s, t) => s + t.sol, 0) / buys.length : 0;
  const sellBuyRatio = buys.length ? sells.length / buys.length : sells.length ? 99 : 0;
  const entryMc = early[early.length - 1].mc;
  const post = g.trades.filter((t) => t.ts > early[early.length - 1].ts);
  if (post.length === 0 || entryMc <= 0) continue;
  tokens.push({ createdMs: g.createdMs, uniqueBuyers, avgBuySol, sellBuyRatio, returns: exitReturns(entryMc, post) });
}

if (tokens.length < MIN_SAMPLE * 2) {
  console.log(`Only ${tokens.length} simulatable tokens — need ≥${MIN_SAMPLE * 2} to tune with a holdout.`);
  console.log("Let it collect more matured tokens and re-run. Live engine keeps current config.");
  process.exit(0);
}

// Time-based split: older = train, newer = validation.
tokens.sort((a, b) => a.createdMs - b.createdMs);
const cut = Math.floor(tokens.length * (1 - VAL_FRACTION));
const train = tokens.slice(0, cut);
const val = tokens.slice(cut);

function score(set, gate, exit) {
  const sel = set.filter(
    (t) => t.uniqueBuyers >= gate.minBuyers && t.avgBuySol >= gate.minAvgBuySol && t.sellBuyRatio < gate.maxSellBuyRatio
  );
  if (sel.length === 0) return { n: 0, pnl: -Infinity, win: 0, mean: 0 };
  const rs = sel.map((t) => t.returns[exit]);
  const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
  return { n: sel.length, pnl: mean - 1, win: rs.filter((v) => v > 1).length / rs.length, mean };
}

// ── Sweep ─────────────────────────────────────────────────────────────────────
const results = [];
for (const minBuyers of GRID.minBuyers)
  for (const minAvgBuySol of GRID.minAvgBuySol)
    for (const maxSellBuyRatio of GRID.maxSellBuyRatio)
      for (const exit of GRID.exit) {
        const gate = { minBuyers, minAvgBuySol, maxSellBuyRatio };
        const tr = score(train, gate, exit);
        if (tr.n < MIN_SAMPLE) continue;
        results.push({ gate, exit, train: tr });
      }

if (results.length === 0) {
  console.log(`No config reached the ${MIN_SAMPLE}-token minimum on the training split. Need more data.`);
  process.exit(0);
}

results.sort((a, b) => b.train.pnl - a.train.pnl);

const pct = (v) => (v * 100).toFixed(0) + "%";
const sol = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);

console.log(`\n═══ TUNER  (train ${train.length} · validate ${val.length} tokens) ═══`);
console.log("Top configs by TRAIN PnL/1SOL, then validated out-of-sample:\n");
console.log("  buyers avgBuy s/b   exit          trainPnL trN  valPnL  valN");

let promoted = null;
const top = results.slice(0, 12);
for (const r of top) {
  const v = score(val, r.gate, r.exit);
  const valStr = v.n > 0 ? `${sol(v.pnl)} ${String(v.n).padStart(3)}` : "  n/a  -";
  console.log(
    `  ${String(r.gate.minBuyers).padStart(5)} ${String(r.gate.minAvgBuySol).padStart(5)} ` +
      `${String(r.gate.maxSellBuyRatio).padStart(3)}   ${r.exit.padEnd(13)} ` +
      `${sol(r.train.pnl).padStart(7)} ${String(r.train.n).padStart(3)}  ${valStr}`
  );
  // Promote the first leader that also clears validation (positive + enough samples).
  if (!promoted && v.n >= Math.max(4, Math.floor(MIN_SAMPLE / 2)) && v.pnl > 0) {
    promoted = { ...r, val: v };
  }
}

const configPath = resolve(__dirname, "../config/strategy.json");
const tpMultiple = promoted?.exit === "tp_3x" ? 3 : 2;
const trailPct = promoted?.exit === "trail_50" ? 0.5 : 0.3;

const out = {
  version: `tuned-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`,
  generatedAt: new Date().toISOString(),
  promoted: Boolean(promoted),
  entry: promoted
    ? { minBuyers: promoted.gate.minBuyers, minAvgBuySol: promoted.gate.minAvgBuySol, maxSellBuyRatio: promoted.gate.maxSellBuyRatio }
    : { minBuyers: 12, minAvgBuySol: 0.1, maxSellBuyRatio: 1.0 },
  exit: promoted ? { strategy: promoted.exit, tpMultiple, trailPct } : { strategy: "trail_30", tpMultiple: 2, trailPct: 0.3 },
  backtest: promoted
    ? {
        trainPnlPerSol: Number(promoted.train.pnl.toFixed(3)),
        trainWinRate: Number(promoted.train.win.toFixed(3)),
        trainN: promoted.train.n,
        valPnlPerSol: Number(promoted.val.pnl.toFixed(3)),
        valWinRate: Number(promoted.val.win.toFixed(3)),
        valN: promoted.val.n,
        slipPct: SLIP_PCT,
        entryWindowMin: ENTRY_WINDOW_MIN,
      }
    : { note: `No config passed out-of-sample validation across ${tokens.length} tokens. Keeping defaults.` },
};

writeFileSync(configPath, JSON.stringify(out, null, 2) + "\n");

console.log("\n──────────────────────────────────────────────");
if (promoted) {
  console.log(`PROMOTED config written to config/strategy.json:`);
  console.log(`  entry: ≥${out.entry.minBuyers} buyers, avg ≥${out.entry.minAvgBuySol} SOL, sell/buy <${out.entry.maxSellBuyRatio}`);
  console.log(`  exit : ${out.exit.strategy}`);
  console.log(`  train ${sol(promoted.train.pnl)}/SOL (win ${pct(promoted.train.win)}, n=${promoted.train.n})`);
  console.log(`  valid ${sol(promoted.val.pnl)}/SOL (win ${pct(promoted.val.win)}, n=${promoted.val.n})`);
  console.log("\nCommit & push config/strategy.json to deploy it live.");
} else {
  console.log("No config survived out-of-sample validation — wrote an UNPROMOTED config.");
  console.log("The live engine will keep the conservative defaults. Collect more data and re-run.");
}
console.log("");
