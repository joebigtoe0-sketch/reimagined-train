/**
 * Wipes ALL data from the (Railway) Postgres — keeps the schema, drops every row.
 *
 * Requires an explicit --yes flag so it can't run by accident.
 * Make a backup first with: node scripts/export.mjs
 *
 * Run:  node scripts/wipe.mjs --yes
 */

import pg from "pg";
const { Client } = pg;

if (!process.argv.includes("--yes")) {
  console.error("Refusing to wipe without --yes. Run: node scripts/wipe.mjs --yes");
  process.exit(1);
}

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
);
const tables = rows.map((r) => `"${r.tablename}"`);
if (tables.length === 0) {
  console.log("No tables found.");
  await client.end();
  process.exit(0);
}

console.log(`Wiping ${tables.length} tables: ${rows.map((r) => r.tablename).join(", ")}`);
await client.query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
await client.end();
console.log("✓ All tables truncated. Schema intact.");
