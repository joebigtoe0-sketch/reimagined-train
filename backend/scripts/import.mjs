/**
 * Restore a previous export (JSONL files) into a target Postgres.
 *
 * Loads every <table>.jsonl from an export directory back into the matching
 * table. Uses ON CONFLICT DO NOTHING so it's safe to re-run and won't clobber
 * existing rows. Insert into a LOCAL/fresh DB for offline study — never auto
 * targets production: you MUST set DATABASE_URL explicitly.
 *
 * The target DB must already have the schema (run the backend once, or apply
 * src/db/schema.sql).
 *
 * Run:  DATABASE_URL=postgresql://pump:pump@localhost:5432/pumpfun \
 *         node scripts/import.mjs exports/<timestamp>
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";

const { Client } = pg;

const dirArg = process.argv[2];
if (!dirArg) {
  console.error("Usage: DATABASE_URL=<target> node scripts/import.mjs <exportDir>");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Refusing to run without an explicit DATABASE_URL (safety: never import into prod by accident).");
  process.exit(1);
}

const dir = path.resolve(process.cwd(), dirArg);
if (!fs.existsSync(dir)) {
  console.error(`Export directory not found: ${dir}`);
  process.exit(1);
}

const BATCH = Number(process.env.IMPORT_BATCH ?? 1000);

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});
await client.connect();

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
console.log(`\nImporting ${files.length} tables into ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ":****@")}\n`);

async function flush(table, rows) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(",");
  const params = [];
  const tuples = rows.map((row) => {
    const ph = cols.map((c) => {
      params.push(row[c] === undefined ? null : row[c]);
      return `$${params.length}`;
    });
    return `(${ph.join(",")})`;
  });
  await client.query(
    `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING`,
    params
  );
}

for (const file of files) {
  const table = file.replace(/\.jsonl$/, "");
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  let batch = [];
  let count = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length >= BATCH) {
        await flush(table, batch);
        count += batch.length;
        batch = [];
        process.stdout.write(`\r  ${table.padEnd(26)} ${count.toLocaleString()} rows`);
      }
    }
    if (batch.length) {
      await flush(table, batch);
      count += batch.length;
    }
    console.log(`\r  ${table.padEnd(26)} ${count.toLocaleString().padStart(10)} rows`);
  } catch (err) {
    console.log(`\r  ${table.padEnd(26)} FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

await client.end();
console.log("\n✓ Import complete.\n");
