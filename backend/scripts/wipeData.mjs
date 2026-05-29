import pg from "pg";
const { Client } = pg;

const client = new Client({
  connectionString: "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway",
  ssl: { rejectUnauthorized: false }
});

await client.connect();

await client.query(`
  TRUNCATE TABLE
    raw_events,
    trades,
    tokens,
    wallet_scores,
    wallet_token_positions,
    developers,
    probability_history,
    alerts,
    token_outcomes,
    signal_observations,
    token_snapshots,
    checkpoints
  RESTART IDENTITY CASCADE
`);

const verify = await client.query(`
  SELECT tablename,
    (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name=t.tablename) AS exists
  FROM (VALUES
    ('raw_events'),('trades'),('tokens'),('wallet_scores'),('wallet_token_positions'),('developers'),
    ('probability_history'),('alerts'),('token_outcomes'),('signal_observations'),('token_snapshots'),('checkpoints')
  ) t(tablename)
`);

console.log("All data wiped. Tables verified:");
for (const row of verify.rows) {
  console.log(` ✓ ${row.tablename}`);
}

await client.end();
