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
