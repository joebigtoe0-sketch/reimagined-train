/**
 * Strategy backtester / "what if" simulator.
 *
 * For every MATURED token it reconstructs the real market-cap timeline from the
 * trades table, then simulates: "if we ENTERED every coin matching rule X and
 * EXITED with strategy Z, what would have happened?"
 *
 * It compares two cohorts:
 *   ALL      — enter every token (baseline)
 *   BREADTH  — enter only tokens with strong first-5-min participation
 *              (the edge surfaced by analyze.mjs)
 * across several exit strategies, so you can see which rule actually makes money.
 *
 * Entry price  = market cap of the last trade inside the entry window (≈ the
 *                moment we'd realistically detect the signal and ape in).
 * Exit price   = per strategy, from trades AFTER entry only (no look-ahead at
 *                entry time; strategies themselves may use the forward path).
 * A fee/slippage haircut is applied to every round-trip to stay realistic.
 *
 * Read-only. Run:  node scripts/backtest.mjs
 * Tunables (env): MATURITY_MIN, ENTRY_WINDOW_MIN, MIN_BUYERS, MIN_AVG_BUY,
 *                 MAX_SELLBUY, SLIP_PCT
 */

import pg from "pg";
const { Client } = pg;

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const MATURITY_MIN = Number(process.env.MATURITY_MIN ?? 25);
const ENTRY_WINDOW_MIN = Number(process.env.ENTRY_WINDOW_MIN ?? 5);
const MIN_BUYERS = Number(process.env.MIN_BUYERS ?? 12);
const MIN_AVG_BUY = Number(process.env.MIN_AVG_BUY ?? 0.1);
const MAX_SELLBUY = Number(process.env.MAX_SELLBUY ?? 1.0);
const SLIP_PCT = Number(process.env.SLIP_PCT ?? 4); // round-trip fee+slippage %
const FEE = 1 - SLIP_PCT / 100;
const ENTRY_MS = ENTRY_WINDOW_MIN * 60 * 1000;

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

if (rows.length === 0) {
  console.log("No matured token trades yet. Let it collect and re-run.");
  await client.end();
  process.exit(0);
}

// ── Group trades by mint ─────────────────────────────────────────────────────
const byMint = new Map();
for (const r of rows) {
  let g = byMint.get(r.mint);
  if (!g) { g = { createdMs: Number(r.created_ms), trades: [] }; byMint.set(r.mint, g); }
  g.trades.push({ ts: Number(r.ts_ms), side: r.side, sol: Number(r.sol), mc: Number(r.mc), wallet: r.wallet });
}

// ── Per-token: features + simulate each exit strategy ────────────────────────
const STRATEGIES = ["hold_to_death", "tp_2x", "tp_3x", "trail_30", "trail_50", "perfect_exit"];

function simulate(entryMc, post) {
  // post = trades after entry (chronological). Returns map strategy -> exit MC.
  const lastMc = post.length ? post[post.length - 1].mc : entryMc;
  let peak = entryMc;
  const out = { hold_to_death: lastMc, tp_2x: null, tp_3x: null, trail_30: null, trail_50: null, perfect_exit: entryMc };
  for (const tr of post) {
    if (tr.mc > peak) peak = tr.mc;
    if (tr.mc > out.perfect_exit) out.perfect_exit = tr.mc;
    if (out.tp_2x === null && tr.mc >= entryMc * 2) out.tp_2x = entryMc * 2;
    if (out.tp_3x === null && tr.mc >= entryMc * 3) out.tp_3x = entryMc * 3;
    if (out.trail_30 === null && tr.mc <= peak * 0.7 && peak > entryMc) out.trail_30 = tr.mc;
    if (out.trail_50 === null && tr.mc <= peak * 0.5 && peak > entryMc) out.trail_50 = tr.mc;
  }
  // Unfilled take-profits / trails => exit at last observed price.
  for (const k of ["tp_2x", "tp_3x", "trail_30", "trail_50"]) if (out[k] === null) out[k] = lastMc;
  return out;
}

const sims = [];
for (const [mint, g] of byMint) {
  const early = g.trades.filter((t) => t.ts - g.createdMs <= ENTRY_MS);
  if (early.length === 0) continue;
  const buys = early.filter((t) => t.side === "buy");
  const sells = early.filter((t) => t.side === "sell");
  const buySol = buys.reduce((s, t) => s + t.sol, 0);
  const uniqueBuyers = new Set(buys.map((t) => t.wallet)).size;
  const avgBuySol = buys.length ? buySol / buys.length : 0;
  const sellBuyRatio = buys.length ? sells.length / buys.length : (sells.length ? 99 : 0);

  const entryMc = early[early.length - 1].mc; // ≈ enter near end of window
  const post = g.trades.filter((t) => t.ts > early[early.length - 1].ts);
  if (post.length === 0 || entryMc <= 0) continue; // no exit opportunity

  const passesBreadth = uniqueBuyers >= MIN_BUYERS && avgBuySol >= MIN_AVG_BUY && sellBuyRatio < MAX_SELLBUY;
  const exits = simulate(entryMc, post);
  const returns = {};
  for (const s of STRATEGIES) returns[s] = (exits[s] / entryMc) * FEE;
  sims.push({ mint, entryMc, passesBreadth, returns });
}

if (sims.length === 0) {
  console.log("Not enough tokens with a tradeable timeline yet. Re-run after more data.");
  await client.end();
  process.exit(0);
}

// ── Aggregate ────────────────────────────────────────────────────────────────
function agg(subset, strat) {
  const rs = subset.map((x) => x.returns[strat]).sort((a, b) => a - b);
  const n = rs.length;
  if (n === 0) return null;
  const mean = rs.reduce((s, v) => s + v, 0) / n;
  const median = rs[Math.floor(n / 2)];
  const wins = rs.filter((v) => v > 1).length;
  const pnlPerSol = mean - 1; // equal 1-SOL bets, avg profit per bet
  return { n, mean, median, winRate: wins / n, pnlPerSol };
}

const pct = (x) => (x * 100).toFixed(0) + "%";
const x = (v) => v.toFixed(2) + "×";

function report(label, subset) {
  console.log(`\n── ${label}  (${subset.length} tokens entered) ───────────────────`);
  console.log("  strategy".padEnd(16) + "avg ret".padStart(9) + "median".padStart(9) + "win%".padStart(7) + "  PnL/1SOL".padStart(10));
  for (const s of STRATEGIES) {
    const a = agg(subset, s);
    if (!a) continue;
    const pnl = (a.pnlPerSol >= 0 ? "+" : "") + a.pnlPerSol.toFixed(2);
    console.log("  " + s.padEnd(14) + x(a.mean).padStart(9) + x(a.median).padStart(9) + pct(a.winRate).padStart(7) + pnl.padStart(10));
  }
}

const breadth = sims.filter((s) => s.passesBreadth);

console.log("\n══════════════════════════════════════════════════════════════");
console.log(` STRATEGY BACKTEST  —  ${sims.length} simulatable tokens`);
console.log(`   entry: end of first ${ENTRY_WINDOW_MIN}m · maturity ${MATURITY_MIN}m · fee/slip ${SLIP_PCT}%`);
console.log(`   BREADTH filter: ≥${MIN_BUYERS} buyers, avg buy ≥${MIN_AVG_BUY} SOL, sell/buy <${MAX_SELLBUY}`);
console.log("══════════════════════════════════════════════════════════════");
console.log(` BREADTH filter selects ${breadth.length}/${sims.length} tokens (${pct(breadth.length / sims.length)})`);

report("COHORT: ALL COINS (ape everything)", sims);
report("COHORT: BREADTH ONLY (the edge)", breadth);

console.log("\nReading it: PnL/1SOL is avg profit if you bet 1 SOL on every entered");
console.log("coin with that exit rule. 'perfect_exit' = sold at the very top (ceiling).");
console.log("Returns include a " + SLIP_PCT + "% round-trip haircut. hold_to_death exits at last");
console.log("observed price (optimistic — assumes you could still sell).\n");

await client.end();
