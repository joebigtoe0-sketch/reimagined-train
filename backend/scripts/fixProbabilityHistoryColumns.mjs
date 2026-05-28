import pg from "pg";

const { Client } = pg;

const client = new Client({
  connectionString: "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway",
  ssl: { rejectUnauthorized: false }
});

await client.connect();
await client.query("ALTER TABLE probability_history ADD COLUMN IF NOT EXISTS hit25k_before10k NUMERIC NOT NULL DEFAULT 0;");
await client.query("ALTER TABLE probability_history ADD COLUMN IF NOT EXISTS hit100k_before25k NUMERIC NOT NULL DEFAULT 0;");
await client.query("ALTER TABLE probability_history ADD COLUMN IF NOT EXISTS local_top_within_n_minutes NUMERIC NOT NULL DEFAULT 0;");
const res = await client.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name='probability_history' AND column_name IN ('hit25k_before10k','hit100k_before25k','local_top_within_n_minutes') ORDER BY column_name"
);
console.log("Added/verified columns:", res.rows.map((r) => r.column_name).join(", "));
await client.end();
