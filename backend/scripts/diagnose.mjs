/**
 * diagnose.mjs — why didn't the bot buy a specific token?
 * Usage: node scripts/diagnose.mjs <mint>
 *
 * Checks Railway DB for: bundle_suspects, trades, tokens, bundle_live_trades
 */

import pg from "pg";
import { config } from "dotenv";
config();

const mint = process.argv[2];
if (!mint) { console.error("Usage: node scripts/diagnose.mjs <mint>"); process.exit(1); }

const dbUrl = process.env.DATABASE_URL ?? "";
const ssl = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false };
const pool = new pg.Pool({ connectionString: dbUrl, ssl });

console.log(`\nDiagnosing: ${mint}\n`);

// 1. Was it detected as a bundle suspect?
const suspects = await pool.query(
  `SELECT detected_at, symbol, detection_mc, trigger_sol, trigger_wallet, score, known_gang, has_social
   FROM bundle_suspects WHERE mint = $1`, [mint]
);
if (suspects.rows.length > 0) {
  console.log("✅ DETECTED as bundle suspect:");
  console.table(suspects.rows);
} else {
  console.log("❌ NOT in bundle_suspects — detection never fired\n");
}

// 2. Was it traded by the live bot?
const liveTrades = await pool.query(
  `SELECT ts, side, sol, entry_mc, exit_mc, pnl, reason FROM bundle_live_trades WHERE mint = $1 ORDER BY ts`, [mint]
);
if (liveTrades.rows.length > 0) {
  console.log("✅ TRADED by bundle live bot:");
  console.table(liveTrades.rows);
} else {
  console.log("❌ NOT traded by bundle live bot\n");
}

// 3. What do we know about the token?
const token = await pool.query(
  `SELECT name, symbol, created_at, current_mc, ath_mc, lifecycle, dev_wallet FROM tokens WHERE mint = $1`, [mint]
);
if (token.rows.length > 0) {
  console.log("Token info:");
  console.table(token.rows);
} else {
  console.log("❌ Token NOT in our DB — launch event was never processed\n");
  console.log("   → This means subscribeNewToken didn't deliver the create event, OR");
  console.log("   → The token launched before the server started\n");
}

// 4. Earliest trades we have for this token
const trades = await pool.query(
  `SELECT ts, wallet, side, amount_sol, market_cap
   FROM trades WHERE mint = $1
   ORDER BY ts ASC LIMIT 10`, [mint]
);
if (trades.rows.length > 0) {
  console.log("Earliest trades in DB:");
  console.table(trades.rows);
} else {
  console.log("❌ No trades for this token in DB\n");
  console.log("   → subscribeTokenTrade subscription wasn't active when early buys happened\n");
}

// 5. Check raw_events for this token
const events = await pool.query(
  `SELECT ts, event_type, wallet, amount_sol, market_cap
   FROM raw_events WHERE mint = $1
   ORDER BY ts ASC LIMIT 10`, [mint]
);
if (events.rows.length > 0) {
  console.log("Raw events:");
  console.table(events.rows);
} else {
  console.log("❌ No raw events for this token\n");
}

await pool.end();
console.log("Done.");
