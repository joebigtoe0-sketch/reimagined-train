/**
 * Pattern analysis over collected data.
 *
 * For every MATURED token (old enough to have played out), this computes
 * EARLY-WINDOW features (first 5 minutes of trades) and joins them to the
 * token's OBSERVED outcome (reached 25k / rugged / max multiple). It then
 * prints "lift" tables: for each feature bucket, how much more (or less)
 * likely a good/bad outcome is vs the overall base rate.
 *
 * Strict time separation: features come only from the first 5 minutes,
 * outcomes from the full life — so patterns are usable for live entry/exit.
 *
 * Read-only. Run:  node scripts/analyze.mjs
 */

import pg from "pg";
const { Client } = pg;

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const EARLY_WINDOW_MIN = Number(process.env.EARLY_WINDOW_MIN ?? 5);
const MATURITY_MIN = Number(process.env.MATURITY_MIN ?? 20);

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `
  WITH base AS (
    SELECT t.mint, t.created_at, t.ath_mc::float8 AS ath_mc, t.current_mc::float8 AS current_mc, t.dev_wallet
    FROM tokens t
    WHERE t.created_at < now() - ($1 || ' minutes')::interval
  ),
  fw AS (
    SELECT tr.mint,
      COUNT(*) FILTER (WHERE tr.side='buy')                        AS buys,
      COUNT(*) FILTER (WHERE tr.side='sell')                       AS sells,
      COUNT(DISTINCT tr.wallet) FILTER (WHERE tr.side='buy')       AS unique_buyers,
      COALESCE(SUM(tr.amount_sol) FILTER (WHERE tr.side='buy'),0)::float8  AS buy_sol,
      COALESCE(SUM(tr.amount_sol) FILTER (WHERE tr.side='sell'),0)::float8 AS sell_sol,
      (MIN(tr.market_cap) FILTER (WHERE tr.market_cap > 0))::float8 AS entry_mc
    FROM trades tr
    JOIN base b ON b.mint = tr.mint
    WHERE tr.ts <= b.created_at + ($2 || ' minutes')::interval
    GROUP BY tr.mint
  ),
  hp AS (
    SELECT s.mint, MAX(s.holder_count) AS early_holders
    FROM token_snapshots s
    JOIN base b ON b.mint = s.mint
    WHERE s.ts <= b.created_at + ($2 || ' minutes')::interval
    GROUP BY s.mint
  ),
  devsell AS (
    SELECT tr.mint, COUNT(*) AS dev_sells
    FROM trades tr JOIN base b ON b.mint = tr.mint
    WHERE tr.wallet = b.dev_wallet AND tr.side = 'sell'
      AND tr.ts <= b.created_at + ($2 || ' minutes')::interval
    GROUP BY tr.mint
  )
  SELECT b.mint, b.ath_mc, b.current_mc,
    COALESCE(fw.buys,0) AS buys, COALESCE(fw.sells,0) AS sells,
    COALESCE(fw.unique_buyers,0) AS unique_buyers,
    COALESCE(fw.buy_sol,0) AS buy_sol, COALESCE(fw.sell_sol,0) AS sell_sol,
    fw.entry_mc, COALESCE(hp.early_holders,0) AS early_holders,
    COALESCE(devsell.dev_sells,0) AS dev_sells
  FROM base b
  JOIN fw ON fw.mint = b.mint
  LEFT JOIN hp ON hp.mint = b.mint
  LEFT JOIN devsell ON devsell.mint = b.mint
  `,
  [String(MATURITY_MIN), String(EARLY_WINDOW_MIN)]
);

if (rows.length === 0) {
  console.log("No matured tokens with trades yet. Let it collect more data and re-run.");
  await client.end();
  process.exit(0);
}

// ── Derive outcomes + tidy features ─────────────────────────────────────────
const data = rows.map((r) => {
  const entryMc = Number(r.entry_mc) || Number(r.current_mc) || 0;
  const athMc = Number(r.ath_mc) || 0;
  const buys = Number(r.buys);
  const sells = Number(r.sells);
  const buySol = Number(r.buy_sol);
  return {
    mint: r.mint,
    athMc,
    currentMc: Number(r.current_mc),
    entryMc,
    buys,
    sells,
    uniqueBuyers: Number(r.unique_buyers),
    netSol: buySol - Number(r.sell_sol),
    avgBuySol: buys > 0 ? buySol / buys : 0,
    sellBuyRatio: buys > 0 ? sells / buys : sells > 0 ? 99 : 0,
    earlyHolders: Number(r.early_holders),
    devSells: Number(r.dev_sells),
    multiple: entryMc > 0 ? athMc / entryMc : 0,
    // OUTCOMES (observed):
    success: athMc >= 25_000,
    moonshot: entryMc > 0 && athMc / entryMc >= 5,
    rug: athMc >= 4_000 && Number(r.current_mc) <= athMc * 0.15
  };
});

const n = data.length;
const pct = (x) => (x * 100).toFixed(1) + "%";
const base = {
  success: data.filter((d) => d.success).length / n,
  moonshot: data.filter((d) => d.moonshot).length / n,
  rug: data.filter((d) => d.rug).length / n
};

console.log("\n══════════════════════════════════════════════════════════════");
console.log(` PATTERN ANALYSIS  —  ${n} matured tokens`);
console.log(`   early window: first ${EARLY_WINDOW_MIN} min · maturity: ${MATURITY_MIN} min`);
console.log("══════════════════════════════════════════════════════════════");
console.log(` BASE RATES:  success(≥25k) ${pct(base.success)}   moonshot(≥5×) ${pct(base.moonshot)}   rug ${pct(base.rug)}`);

function liftTable(title, valueFn, buckets) {
  console.log(`\n── ${title} ───────────────────────────────────────────`);
  console.log("  bucket".padEnd(20) + "n".padStart(6) + "  success   (lift)   rug      (lift)");
  for (const [label, pred] of buckets) {
    const subset = data.filter((d) => pred(valueFn(d)));
    if (subset.length === 0) {
      console.log("  " + label.padEnd(18) + "0".padStart(6) + "     —");
      continue;
    }
    const s = subset.filter((d) => d.success).length / subset.length;
    const r = subset.filter((d) => d.rug).length / subset.length;
    const sLift = base.success > 0 ? (s / base.success).toFixed(2) + "×" : "—";
    const rLift = base.rug > 0 ? (r / base.rug).toFixed(2) + "×" : "—";
    console.log(
      "  " + label.padEnd(18) + String(subset.length).padStart(6) + "   " + pct(s).padStart(6) + "  " + sLift.padStart(6) + "   " + pct(r).padStart(6) + "  " + rLift.padStart(6)
    );
  }
}

const lt = (a) => (v) => v < a;
const between = (a, b) => (v) => v >= a && v < b;
const gte = (a) => (v) => v >= a;

liftTable("Unique buyers (first 5m)", (d) => d.uniqueBuyers, [
  ["< 5", lt(5)],
  ["5–15", between(5, 15)],
  ["15–40", between(15, 40)],
  ["40–100", between(40, 100)],
  ["≥ 100", gte(100)]
]);

liftTable("Avg buy size SOL (first 5m)", (d) => d.avgBuySol, [
  ["< 0.1", lt(0.1)],
  ["0.1–0.5", between(0.1, 0.5)],
  ["0.5–1", between(0.5, 1)],
  ["1–3", between(1, 3)],
  ["≥ 3", gte(3)]
]);

liftTable("Sell/buy ratio (first 5m)", (d) => d.sellBuyRatio, [
  ["< 0.3", lt(0.3)],
  ["0.3–0.7", between(0.3, 0.7)],
  ["0.7–1.0", between(0.7, 1.0)],
  ["≥ 1.0", gte(1.0)]
]);

liftTable("Net SOL flow (first 5m)", (d) => d.netSol, [
  ["< 0", lt(0)],
  ["0–5", between(0, 5)],
  ["5–20", between(5, 20)],
  ["≥ 20", gte(20)]
]);

liftTable("Entry MC (first trade)", (d) => d.entryMc, [
  ["< 5k", lt(5_000)],
  ["5k–10k", between(5_000, 10_000)],
  ["10k–20k", between(10_000, 20_000)],
  ["≥ 20k", gte(20_000)]
]);

liftTable("Early holders (first 5m)", (d) => d.earlyHolders, [
  ["< 10", lt(10)],
  ["10–30", between(10, 30)],
  ["30–80", between(30, 80)],
  ["≥ 80", gte(80)]
]);

liftTable("Dev sold in first 5m?", (d) => d.devSells, [
  ["no", lt(1)],
  ["yes", gte(1)]
]);

console.log("\nNote: 'lift' >1 means that bucket is more likely than average to hit the outcome.");
console.log("Success = reached ≥$25k ATH · Rug = collapsed to ≤15% of ATH (ATH ≥ $4k).\n");

await client.end();
