/**
 * Predictive wallet finder ("alpha wallets").
 *
 * Different question from the Wallets tab. That ranks wallets by their own
 * realized PnL (are THEY good traders). This asks: when a wallet buys a coin
 * EARLY, does that coin tend to PUMP afterwards? — i.e. is the wallet a good
 * *picker* we could copy on entry, regardless of how it sells.
 *
 * Method: for every matured token, take each wallet that bought inside the first
 * ENTRY_WINDOW_MIN minutes; the token's peak multiple from that wallet's actual
 * buy price is its "pick result". Aggregate per wallet: how many picks, what
 * fraction reached WIN_MULT×, median peak, vs the base rate across all picks.
 * Wallets with enough picks AND a hit rate well above base = alpha candidates.
 *
 * Read-only. Run: node scripts/smartwallets.mjs
 * Tunables (env): MATURITY_MIN, ENTRY_WINDOW_MIN, WIN_MULT, MIN_PICKS, TOP
 */

import pg from "pg";
const { Client } = pg;

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const MATURITY_MIN = Number(process.env.MATURITY_MIN ?? 25);
const ENTRY_WINDOW_MIN = Number(process.env.ENTRY_WINDOW_MIN ?? 5);
const WIN_MULT = Number(process.env.WIN_MULT ?? 2);
const MIN_PICKS = Number(process.env.MIN_PICKS ?? 4);
const TOP = Number(process.env.TOP ?? 25);
const ENTRY_MS = ENTRY_WINDOW_MIN * 60 * 1000;

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();

// Peak MC per token (from observed trades) + creation time.
const { rows: peaks } = await client.query(
  `SELECT tr.mint, MAX(tr.market_cap)::float8 AS peak_mc,
          extract(epoch from t.created_at) * 1000 AS created_ms
   FROM trades tr JOIN tokens t ON t.mint = tr.mint
   WHERE t.created_at < now() - ($1 || ' minutes')::interval AND tr.market_cap > 0
   GROUP BY tr.mint, t.created_at`,
  [String(MATURITY_MIN)]
);
const peakByMint = new Map();
for (const r of peaks) peakByMint.set(r.mint, { peakMc: Number(r.peak_mc), createdMs: Number(r.created_ms) });

// Early buys (first window) for those tokens.
const { rows: buys } = await client.query(
  `SELECT tr.mint, tr.wallet, tr.market_cap::float8 AS mc, extract(epoch from tr.ts) * 1000 AS ts_ms
   FROM trades tr JOIN tokens t ON t.mint = tr.mint
   WHERE t.created_at < now() - ($1 || ' minutes')::interval
     AND tr.side = 'buy' AND tr.market_cap > 0
     AND tr.wallet <> 'UNKNOWN_WALLET'`,
  [String(MATURITY_MIN)]
);
await client.end();

// One pick per wallet+token = their first early buy.
const firstBuy = new Map(); // key wallet|mint -> entryMc
for (const b of buys) {
  const t = peakByMint.get(b.mint);
  if (!t) continue;
  if (Number(b.ts_ms) - t.createdMs > ENTRY_MS) continue; // not early
  const key = b.wallet + "|" + b.mint;
  const cur = firstBuy.get(key);
  if (!cur || Number(b.ts_ms) < cur.ts) firstBuy.set(key, { wallet: b.wallet, mint: b.mint, mc: Number(b.mc), ts: Number(b.ts_ms) });
}

const wallets = new Map();
let totalPicks = 0;
let totalWins = 0;
for (const { wallet, mint, mc } of firstBuy.values()) {
  const peak = peakByMint.get(mint).peakMc;
  if (mc <= 0) continue;
  const mult = peak / mc;
  const win = mult >= WIN_MULT;
  totalPicks++;
  if (win) totalWins++;
  let w = wallets.get(wallet);
  if (!w) { w = { wallet, picks: 0, wins: 0, big: 0, mults: [] }; wallets.set(wallet, w); }
  w.picks++;
  if (win) w.wins++;
  if (mult >= 5) w.big++;
  w.mults.push(mult);
}

const baseRate = totalPicks ? totalWins / totalPicks : 0;

const ranked = [...wallets.values()]
  .filter((w) => w.picks >= MIN_PICKS)
  .map((w) => {
    const sorted = w.mults.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const hit = w.wins / w.picks;
    return { ...w, hit, median, lift: baseRate > 0 ? hit / baseRate : 0 };
  })
  .sort((a, b) => b.hit - a.hit || b.median - a.median);

const pct = (v) => (v * 100).toFixed(0) + "%";

console.log("\n══════════════════════════════════════════════════════════════");
console.log(` PREDICTIVE WALLETS  —  ${firstBuy.size} early picks across ${peakByMint.size} matured tokens`);
console.log(`   "win" = coin reached ${WIN_MULT}× the wallet's entry MC · early = first ${ENTRY_WINDOW_MIN}m`);
console.log(`   base rate (any early buyer hits ${WIN_MULT}×): ${pct(baseRate)}`);
console.log("══════════════════════════════════════════════════════════════");

if (ranked.length === 0) {
  console.log(`\nNo wallet has ≥${MIN_PICKS} early picks yet. Let it collect more matured tokens and re-run.\n`);
  process.exit(0);
}

console.log("\n  wallet                                          picks  hit%   lift  ≥5×  medianX");
for (const w of ranked.slice(0, TOP)) {
  console.log(
    "  " + w.wallet.padEnd(46) +
      String(w.picks).padStart(5) +
      pct(w.hit).padStart(7) +
      (w.lift.toFixed(1) + "×").padStart(7) +
      String(w.big).padStart(5) +
      (w.median.toFixed(2) + "×").padStart(9)
  );
}

console.log(`\nReading it: 'lift' >1 means the wallet picks ${WIN_MULT}× coins MORE often than`);
console.log("a random early buyer. High picks + high lift = a wallet worth copying on entry.");
console.log("Small 'picks' = treat as a lead, not proof — re-run as the sample grows.\n");
