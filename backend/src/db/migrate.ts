import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeRepo } from "./repositories/runtimeRepo.js";
import { getDbPool } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runStartupMigrations(): Promise<void> {
  const pool = getDbPool();
  const distSchemaPath = path.join(__dirname, "schema.sql");
  const sourceSchemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  const schemaPath = fs.existsSync(distSchemaPath) ? distSchemaPath : sourceSchemaPath;
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${distSchemaPath} or ${sourceSchemaPath}`);
  }
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);

  // Incremental column additions that are safe to re-run. These are metadata-only
  // (or fast) on Postgres 11+, so they're cheap to run on every boot.
  const incremental: string[] = [
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_amount NUMERIC NOT NULL DEFAULT 0`,
    `ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS side TEXT`,
    `ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS token_amount NUMERIC`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_trade_at TIMESTAMPTZ`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS smart_money_buys INTEGER NOT NULL DEFAULT 0`
  ];
  for (const stmt of incremental) {
    await pool.query(stmt);
  }
}

// Indexes are created CONCURRENTLY so they never lock writes, and OFF the boot
// path so a slow build on a large table can't block app.listen / the healthcheck.
// CONCURRENTLY cannot run in a transaction, so each runs as its own statement.
const INDEX_STATEMENTS: string[] = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_mint_ts ON token_snapshots (mint, ts DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tokens_dev ON tokens (dev_wallet)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_events_mint_ts ON raw_events (mint, ts DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_mint_ts ON trades (mint, ts ASC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_wallet_ts ON trades (wallet, ts DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_signal_obs_mint_ts ON signal_observations (mint, ts DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_positions_wallet ON wallet_token_positions (wallet)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tokens_last_trade ON tokens (last_trade_at DESC NULLS LAST)`
];

/**
 * Builds indexes in the background after the server is already listening.
 * Fire-and-forget: errors are logged per-statement and never crash the app.
 */
export async function runIndexMigrations(): Promise<void> {
  const pool = getDbPool();
  // Use one dedicated client and disable statement_timeout for it — a large
  // CONCURRENTLY build can exceed the global query timeout, and we don't want
  // it killed. CONCURRENTLY also must not run inside a transaction block.
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    for (const stmt of INDEX_STATEMENTS) {
      try {
        await client.query(stmt);
      } catch (err) {
        console.warn("[migrate] index build skipped:", err instanceof Error ? err.message : err);
      }
    }
  } finally {
    client.release();
  }
}

export async function assertRequiredTables(repo: RuntimeRepo): Promise<void> {
  const required = ["checkpoints", "raw_events", "tokens", "wallet_scores", "developers", "probability_history", "alerts", "token_snapshots"];
  const rows = (await repo.rawQuery<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
    [required]
  )) as { tablename: string }[];
  const found = new Set(rows.map((r) => r.tablename));
  const missing = required.filter((table) => !found.has(table));
  if (missing.length > 0) {
    throw new Error(`Missing required tables: ${missing.join(", ")}`);
  }
}
