/**
 * Dip-bounce scalp simulator.
 *
 * Tests the bot pattern: when a token drops X% off its recent high, buy the dip,
 * then flip it within a short window for a small take-profit — accepting a small
 * stop-loss when the bounce doesn't come. Sweeps drop trigger × take-profit ×
 * stop-loss × hold window across every token's real trade timeline and reports
 * which combos actually print, with win rate, avg return, total PnL and the
 * realized hold time (so you can see if the data is granular enough for "fast
 * flips").
 *
 * Price proxy = market_cap per trade. Read-only.
 * Run: node scripts/dipscalp.mjs
 * Tunables (env): MATURITY_MIN, WINDOW_SEC (recent-high lookback), SLIP_PCT, MIN_EVENTS
 */

import pg from "pg";
const { Client } = pg;

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const MATURITY_MIN = Number(process.env.MATURITY_MIN ?? 25);
const WINDOW_SEC = Number(process.env.WINDOW_SEC ?? 120); // recent-high lookback
const SLIP_PCT = Number(process.env.SLIP_PCT ?? 4); // round-trip fee+slippage
const MIN_EVENTS = Number(process.env.MIN_EVENTS ?? 30);
const FEE = 1 - SLIP_PCT / 100;

// Sweep grid.
const DROPS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]; // buy after this fraction off recent high
const TPS = [0.03, 0.05, 0.1, 0.2]; // take-profit target
const SLS = [0.1, 0.15, 0.3]; // stop-loss
const HOLDS = [15, 30, 60]; // max hold seconds

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(
  `SELECT tr.mint, extract(epoch from tr.ts) AS ts, tr.market_cap::float8 AS mc
   FROM trades tr JOIN tokens t ON t.mint = tr.mint
   WHERE t.created_at < now() - ($1 || ' minutes')::interval AND tr.market_cap > 0
   ORDER BY tr.mint, tr.ts ASC`,
  [String(MATURITY_MIN)]
);
await client.end();

const byMint = new Map();
for (const r of rows) {
  let g = byMint.get(r.mint);
  if (!g) { g = []; byMint.set(r.mint, g); }
  g.push({ ts: Number(r.ts), mc: Number(r.mc) });
}

// Precompute trailing high (within WINDOW_SEC) for each trade via monotonic deque.
function trailingHighs(trades) {
  const hi = new Array(trades.length);
  const dq = []; // indices, decreasing mc
  let lo = 0;
  for (let i = 0; i < trades.length; i++) {
    while (lo < i && trades[i].ts - trades[lo].ts > WINDOW_SEC) {
      if (dq[0] === lo) dq.shift();
      lo++;
    }
    while (dq.length && trades[dq[dq.length - 1]].mc <= trades[i].mc) dq.pop();
    dq.push(i);
    hi[i] = trades[dq[0]].mc;
  }
  return hi;
}

const prepared = [];
for (const [, trades] of byMint) {
  if (trades.length < 3) continue;
  prepared.push({ trades, hi: trailingHighs(trades) });
}

// Simulate one (drop, tp, sl, hold) config across all tokens.
function run(drop, tp, sl, hold) {
  const returns = [];
  const holds = [];
  for (const { trades, hi } of prepared) {
    let i = 0;
    while (i < trades.length - 1) {
      const high = hi[i];
      const px = trades[i].mc;
      const dipped = high > 0 && (high - px) / high >= drop;
      if (!dipped || px <= 0) { i++; continue; }
      // Enter at px; walk forward up to `hold` seconds.
      const entryTs = trades[i].ts;
      let exitPx = px;
      let exitTs = entryTs;
      let j = i + 1;
      for (; j < trades.length; j++) {
        const dt = trades[j].ts - entryTs;
        if (dt > hold) break;
        exitPx = trades[j].mc;
        exitTs = trades[j].ts;
        if (trades[j].mc >= px * (1 + tp)) { exitPx = px * (1 + tp); break; }
        if (trades[j].mc <= px * (1 - sl)) { exitPx = px * (1 - sl); break; }
      }
      if (exitTs === entryTs) { i++; continue; } // no forward trade to exit on
      returns.push((exitPx / px) * FEE);
      holds.push(exitTs - entryTs);
      i = j + 1; // no overlapping positions
    }
  }
  return { returns, holds };
}

function stats(returns, holds) {
  const n = returns.length;
  if (n === 0) return null;
  const mean = returns.reduce((s, v) => s + v, 0) / n;
  const wins = returns.filter((v) => v > 1).length;
  const totalPnl = returns.reduce((s, v) => s + (v - 1), 0); // 1-SOL bets
  const medHold = Math.round(holds.slice().sort((a, b) => a - b)[Math.floor(n / 2)]);
  return { n, mean, winRate: wins / n, totalPnl, medHold };
}

const pct = (v) => (v * 100).toFixed(0) + "%";

const results = [];
for (const drop of DROPS)
  for (const tp of TPS)
    for (const sl of SLS)
      for (const hold of HOLDS) {
        const { returns, holds } = run(drop, tp, sl, hold);
        const s = stats(returns, holds);
        if (s && s.n >= MIN_EVENTS) results.push({ drop, tp, sl, hold, ...s });
      }

console.log("\n══════════════════════════════════════════════════════════════");
console.log(` DIP-BOUNCE SCALP  —  ${prepared.length} matured tokens, recent-high lookback ${WINDOW_SEC}s`);
console.log(`   buy after a -X% dip → exit on +TP / -SL / time. fee+slip ${SLIP_PCT}% round-trip`);
console.log("══════════════════════════════════════════════════════════════");

if (results.length === 0) {
  console.log(`\nNo config reached ${MIN_EVENTS} dip events yet. Collect more data and re-run.\n`);
  process.exit(0);
}

results.sort((a, b) => b.totalPnl - a.totalPnl);
console.log("\nTop configs by total PnL (1 SOL per flip):\n");
console.log("  dip%  TP%  SL%  hold   events  win%   avgRet   PnL(SOL)  medHold");
for (const r of results.slice(0, 15)) {
  console.log(
    "  " + pct(r.drop).padStart(4) + pct(r.tp).padStart(5) + pct(r.sl).padStart(5) +
      (r.hold + "s").padStart(6) + String(r.n).padStart(8) +
      pct(r.winRate).padStart(7) + (r.mean.toFixed(3) + "×").padStart(9) +
      ((r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2)).padStart(11) +
      (r.medHold + "s").padStart(9)
  );
}

const worst = results[results.length - 1];
console.log(`\nWorst combo: dip ${pct(worst.drop)} TP ${pct(worst.tp)} SL ${pct(worst.sl)} ${worst.hold}s ⇒ ${worst.totalPnl.toFixed(2)} SOL`);
console.log("\nReading it: win% = flips that closed green. avgRet >1 means edge after fees.");
console.log("medHold = median seconds held (shows if our trade capture is granular enough");
console.log("for true second-scale flips). Positive PnL across many events = a real edge.\n");
