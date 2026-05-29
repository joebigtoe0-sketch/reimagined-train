/**
 * Exit-timing simulator.
 *
 * Entry selection is solved (early breadth). The unsolved problem is WHEN to
 * sell: mechanical %-exits give all the gains back. This tests BEHAVIORAL exits
 * that react to order-flow — momentum stalling, sell-pressure flipping, a whale
 * dumping — against the mechanical baselines and the perfect-exit ceiling.
 *
 * Cohort = breadth coins only (the ones worth holding). Entry = end of the
 * entry window. Each exit rule walks the forward trade stream and decides where
 * to sell. Reported with a time-based TRAIN/VALIDATION split so we only believe
 * an exit that also works out-of-sample.
 *
 * Read-only. Run: node scripts/exitsim.mjs
 * Tunables (env): MATURITY_MIN, ENTRY_WINDOW_MIN, MIN_BUYERS, MIN_AVG_BUY,
 *                 MAX_SELLBUY, SLIP_PCT, VAL_FRACTION
 */

import pg from "pg";
const { Client } = pg;

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const MATURITY_MIN = Number(process.env.MATURITY_MIN ?? 25);
const ENTRY_WINDOW_MIN = Number(process.env.ENTRY_WINDOW_MIN ?? 2);
const MIN_BUYERS = Number(process.env.MIN_BUYERS ?? 12);
const MIN_AVG_BUY = Number(process.env.MIN_AVG_BUY ?? 0.1);
const MAX_SELLBUY = Number(process.env.MAX_SELLBUY ?? 1.0);
const SLIP_PCT = Number(process.env.SLIP_PCT ?? 4);
const VAL_FRACTION = Number(process.env.VAL_FRACTION ?? 0.3);
const FEE = 1 - SLIP_PCT / 100;
const ENTRY_MS = ENTRY_WINDOW_MIN * 60 * 1000;

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(
  `SELECT tr.mint, extract(epoch from tr.ts) * 1000 AS ts_ms, tr.side,
          tr.amount_sol::float8 AS sol, tr.market_cap::float8 AS mc, tr.wallet,
          extract(epoch from t.created_at) * 1000 AS created_ms
   FROM trades tr JOIN tokens t ON t.mint = tr.mint
   WHERE t.created_at < now() - ($1 || ' minutes')::interval AND tr.market_cap > 0
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

// ── Exit rules: each returns the exit market cap given (entryTs, entryMc, post)
function exitPerfect(_e, entryMc, post) { let m = entryMc; for (const t of post) if (t.mc > m) m = t.mc; return m; }
function exitHold(_e, entryMc, post) { return post.length ? post[post.length - 1].mc : entryMc; }
function exitTrail(pct) {
  return (_e, entryMc, post) => {
    let peak = entryMc, prev = entryMc;
    for (const t of post) {
      if (t.mc > peak) peak = t.mc;
      if (peak > entryMc && t.mc <= peak * (1 - pct)) return t.mc;
      prev = t.mc;
    }
    return prev;
  };
}
// Momentum stall: sell at the last price before a gap of >sec with no BUY.
function exitStall(sec) {
  const ms = sec * 1000;
  return (entryTs, entryMc, post) => {
    let lastBuyTs = entryTs, prev = entryMc;
    for (const t of post) {
      if (t.ts - lastBuyTs > ms) return prev; // momentum died
      if (t.side === "buy") lastBuyTs = t.ts;
      prev = t.mc;
    }
    return prev;
  };
}
// Sell-pressure flip: rolling window where sells outnumber buys ⇒ distribution.
function exitSellFlip(winSec) {
  const ms = winSec * 1000;
  return (_e, entryMc, post) => {
    const dq = [];
    let buys = 0, sells = 0, prev = entryMc;
    for (const t of post) {
      dq.push(t);
      if (t.side === "buy") buys++; else sells++;
      while (dq.length && t.ts - dq[0].ts > ms) {
        const o = dq.shift();
        if (o.side === "buy") buys--; else sells--;
      }
      if (buys + sells >= 4 && sells > buys) return t.mc;
      prev = t.mc;
    }
    return prev;
  };
}
// Whale dump: first sell >= sol SOL ⇒ exit at the post-dump price.
function exitBigSell(sol) {
  return (_e, entryMc, post) => {
    let prev = entryMc;
    for (const t of post) {
      if (t.side === "sell" && t.sol >= sol) return t.mc;
      prev = t.mc;
    }
    return prev;
  };
}
// Combo: whichever of stall / sell-flip / big-sell triggers first.
function exitSmart(stallSec, flipSec, bigSol) {
  return exitTpSmart(Infinity, stallSec, flipSec, bigSol);
}
// Quick take-profit + behavioral safety net: bank a fast pop to tpMult, else
// bail on momentum stall / sell-flip / whale dump.
function exitTpSmart(tpMult, stallSec, flipSec, bigSol) {
  const ms = stallSec * 1000, fms = flipSec * 1000;
  return (entryTs, entryMc, post) => {
    let lastBuyTs = entryTs, prev = entryMc, buys = 0, sells = 0;
    const dq = [];
    for (const t of post) {
      if (t.mc >= entryMc * tpMult) return entryMc * tpMult; // hit profit target
      if (t.ts - lastBuyTs > ms) return prev;
      if (t.side === "sell" && t.sol >= bigSol) return t.mc;
      dq.push(t);
      if (t.side === "buy") { buys++; lastBuyTs = t.ts; } else sells++;
      while (dq.length && t.ts - dq[0].ts > fms) { const o = dq.shift(); if (o.side === "buy") buys--; else sells--; }
      if (buys + sells >= 4 && sells > buys) return t.mc;
      prev = t.mc;
    }
    return prev;
  };
}

// Follow-the-early-money out: exit when the k-th distinct EARLY-window buyer
// starts selling (the people who got in first are distributing → leave).
function exitEarlyDump(k) {
  return (_entryTs, entryMc, post, earlyBuyers) => {
    let prev = entryMc;
    const sold = new Set();
    for (const t of post) {
      if (t.side === "sell" && earlyBuyers.has(t.wallet) && !sold.has(t.wallet)) {
        sold.add(t.wallet);
        if (sold.size >= k) return t.mc;
      }
      prev = t.mc;
    }
    return prev;
  };
}
// TP + early-dump + behavioral net combined.
function exitTpEarlySmart(tpMult, k, stallSec, flipSec, bigSol) {
  const ms = stallSec * 1000, fms = flipSec * 1000;
  return (entryTs, entryMc, post, earlyBuyers) => {
    let lastBuyTs = entryTs, prev = entryMc, buys = 0, sells = 0;
    const dq = [], sold = new Set();
    for (const t of post) {
      if (t.mc >= entryMc * tpMult) return entryMc * tpMult;
      if (t.ts - lastBuyTs > ms) return prev;
      if (t.side === "sell" && t.sol >= bigSol) return t.mc;
      if (t.side === "sell" && earlyBuyers.has(t.wallet) && !sold.has(t.wallet)) {
        sold.add(t.wallet);
        if (sold.size >= k) return t.mc;
      }
      dq.push(t);
      if (t.side === "buy") { buys++; lastBuyTs = t.ts; } else sells++;
      while (dq.length && t.ts - dq[0].ts > fms) { const o = dq.shift(); if (o.side === "buy") buys--; else sells--; }
      if (buys + sells >= 4 && sells > buys) return t.mc;
      prev = t.mc;
    }
    return prev;
  };
}

const RULES = {
  perfect_exit: exitPerfect,
  hold_to_death: exitHold,
  trail_30: exitTrail(0.3),
  stall_30s: exitStall(30),
  stall_60s: exitStall(60),
  sellflip_30s: exitSellFlip(30),
  "bigsell_1.5sol": exitBigSell(1.5),
  smart_combo: exitSmart(45, 30, 1.5),
  "tp1.4_smart": exitTpSmart(1.4, 45, 30, 1.5),
  "tp1.7_smart": exitTpSmart(1.7, 45, 30, 1.5),
  "tp2_smart": exitTpSmart(2.0, 45, 30, 1.5),
  "tp3_smart": exitTpSmart(3.0, 45, 30, 1.5),
  earlydump_1: exitEarlyDump(1),
  earlydump_2: exitEarlyDump(2),
  earlydump_3: exitEarlyDump(3),
  "tp3_early2_smart": exitTpEarlySmart(3.0, 2, 45, 30, 1.5),
};

// ── Build breadth cohort with entry + forward path ───────────────────────────
const cohort = [];
for (const [, g] of byMint) {
  const early = g.trades.filter((t) => t.ts - g.createdMs <= ENTRY_MS);
  if (early.length === 0) continue;
  const buys = early.filter((t) => t.side === "buy");
  const sells = early.filter((t) => t.side === "sell");
  const uniqueBuyers = new Set(buys.map((t) => t.wallet)).size;
  const avgBuySol = buys.length ? buys.reduce((s, t) => s + t.sol, 0) / buys.length : 0;
  const sellBuyRatio = buys.length ? sells.length / buys.length : sells.length ? 99 : 0;
  if (!(uniqueBuyers >= MIN_BUYERS && avgBuySol >= MIN_AVG_BUY && sellBuyRatio < MAX_SELLBUY)) continue;
  const entryTs = early[early.length - 1].ts;
  const entryMc = early[early.length - 1].mc;
  const post = g.trades.filter((t) => t.ts > entryTs);
  if (post.length === 0 || entryMc <= 0) continue;
  const earlyBuyers = new Set(buys.map((t) => t.wallet));
  cohort.push({ createdMs: g.createdMs, entryTs, entryMc, post, earlyBuyers });
}

if (cohort.length < 20) {
  console.log(`Only ${cohort.length} breadth-cohort tokens — need more. Re-run later.`);
  process.exit(0);
}

cohort.sort((a, b) => a.createdMs - b.createdMs);
const cut = Math.floor(cohort.length * (1 - VAL_FRACTION));
const train = cohort.slice(0, cut);
const val = cohort.slice(cut);

function score(set, rule) {
  const rets = [];
  const holds = [];
  for (const c of set) {
    const exitMc = rule(c.entryTs, c.entryMc, c.post, c.earlyBuyers);
    rets.push((exitMc / c.entryMc) * FEE);
    // approximate realized hold: time to the exit price's first occurrence
    holds.push((c.post[c.post.length - 1].ts - c.entryTs) / 1000);
  }
  rets.sort((a, b) => a - b);
  const n = rets.length;
  const mean = rets.reduce((s, v) => s + v, 0) / n;
  const wins = rets.filter((v) => v > 1).length;
  return { n, mean, pnl: mean - 1, win: wins / n, median: rets[Math.floor(n / 2)] };
}

const pct = (v) => (v * 100).toFixed(0) + "%";
const sol = (v) => (v >= 0 ? "+" : "") + v.toFixed(3);

console.log("\n══════════════════════════════════════════════════════════════");
console.log(` EXIT-TIMING SIM  —  breadth cohort: ${cohort.length} tokens (train ${train.length} / val ${val.length})`);
console.log(`   entry: end of first ${ENTRY_WINDOW_MIN}m · maturity ${MATURITY_MIN}m · fee/slip ${SLIP_PCT}%`);
console.log("══════════════════════════════════════════════════════════════");
console.log("\n  exit rule         trainPnL  trWin   valPnL   valWin  valAvg   valMed");
for (const [name, rule] of Object.entries(RULES)) {
  const tr = score(train, rule);
  const v = score(val, rule);
  console.log(
    "  " + name.padEnd(16) +
      sol(tr.pnl).padStart(8) + pct(tr.win).padStart(7) +
      sol(v.pnl).padStart(9) + pct(v.win).padStart(8) +
      (v.mean.toFixed(2) + "×").padStart(8) + (v.median.toFixed(2) + "×").padStart(8)
  );
}
console.log("\nPnL = avg profit per 1 SOL bet. A behavioral exit WINS if its valPnL is");
console.log("positive AND beats trail_30 — that's an exit that banks gains out-of-sample.");
console.log("perfect_exit is the (unreachable) ceiling; hold_to_death the floor.\n");
