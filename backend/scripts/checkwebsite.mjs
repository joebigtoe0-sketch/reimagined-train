import "dotenv/config";
import pg from "pg";
const { Client } = pg;
const db = new Client("postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway");
await db.connect();

// Check tokens table columns
const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='tokens' ORDER BY ordinal_position`);
console.log("tokens columns:", cols.rows.map(r => r.column_name).join(", "));

// Sample a row
const s = await db.query("SELECT * FROM tokens LIMIT 1");
if (s.rows[0]) console.log("\nSample token row:", JSON.stringify(s.rows[0], null, 2));

// Check raw_events for token creation events (type=create or similar)
const ev = await db.query(`SELECT * FROM raw_events WHERE (type='create' OR type='token_create' OR side='create') LIMIT 2`);
console.log("\nraw_events create samples:", ev.rows.length);
if (ev.rows[0]) console.log(JSON.stringify(ev.rows[0], null, 2));

await db.end();
