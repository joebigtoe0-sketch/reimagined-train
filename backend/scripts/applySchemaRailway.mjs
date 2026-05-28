import fs from "node:fs";
import pg from "pg";

const { Client } = pg;

const connectionString =
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const sql = fs.readFileSync("src/db/schema.sql", "utf8");

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
await client.query(sql);
const verify = await client.query(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('checkpoints','raw_events','tokens','wallet_scores','developers','probability_history','alerts','token_snapshots','holders','wallet_token_positions','token_outcomes','alert_rules','signal_observations') ORDER BY tablename"
);
console.log("Schema update applied.");
console.log("Verified tables:", verify.rows.map((r) => r.tablename).join(", "));
await client.end();
