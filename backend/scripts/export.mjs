/**
 * Full database export → local JSONL files.
 *
 * Downloads every table from the (Railway) Postgres to your machine so the data
 * is kept for offline learning/backtesting even after a wipe. Each table is
 * streamed in batches via ctid keyset pagination (no PK assumptions, low memory)
 * and written as newline-delimited JSON. A manifest.json records row counts.
 *
 * Output: backend/exports/<timestamp>/<table>.jsonl  (+ manifest.json)
 *
 * Read-only. Run:  node scripts/export.mjs
 * Optional:        DATABASE_URL=... node scripts/export.mjs
 *
 * Re-import later with:  node scripts/import.mjs exports/<timestamp>
 */

import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import pg from "pg";

const { Client } = pg;

const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://postgres:dKuAVIRoFpGsIfrbUzOSqNuyEaiXbxwr@zephyr.proxy.rlwy.net:54148/railway";

const BATCH = Number(process.env.EXPORT_BATCH ?? 5000);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(process.cwd(), "exports", stamp);
fs.mkdirSync(outDir, { recursive: true });

const client = new Client({ connectionString: CONNECTION, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log(`\nExporting database → ${outDir}\n`);

const { rows: tableRows } = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
);
const tables = tableRows.map((r) => r.tablename);

const manifest = { exportedAt: new Date().toISOString(), source: CONNECTION.replace(/:[^:@/]+@/, ":****@"), tables: {} };
let grandTotal = 0;

for (const table of tables) {
  const filePath = path.join(outDir, `${table}.jsonl`);
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  let cursor = "(0,0)";
  let count = 0;

  for (;;) {
    const { rows } = await client.query(
      `SELECT *, ctid::text AS __ctid FROM "${table}" WHERE ctid > $1::tid ORDER BY ctid LIMIT $2`,
      [cursor, BATCH]
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].__ctid;

    let chunk = "";
    for (const row of rows) {
      delete row.__ctid;
      chunk += JSON.stringify(row) + "\n";
    }
    if (!stream.write(chunk)) await once(stream, "drain");
    count += rows.length;
    process.stdout.write(`\r  ${table.padEnd(26)} ${count.toLocaleString()} rows`);
    if (rows.length < BATCH) break;
  }

  stream.end();
  await once(stream, "finish");
  const bytes = fs.statSync(filePath).size;
  manifest.tables[table] = { rows: count, bytes };
  grandTotal += count;
  console.log(`\r  ${table.padEnd(26)} ${count.toLocaleString().padStart(10)} rows  (${(bytes / 1e6).toFixed(1)} MB)`);
}

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await client.end();

console.log(`\n✓ Done. ${grandTotal.toLocaleString()} total rows across ${tables.length} tables.`);
console.log(`  Saved to: ${outDir}`);
console.log(`  Re-import with: node scripts/import.mjs exports/${stamp}\n`);
