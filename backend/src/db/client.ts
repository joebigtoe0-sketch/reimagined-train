import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
let pool: InstanceType<typeof Pool> | null = null;

export function getDbPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      // More clients so the high-frequency write path doesn't starve the pool.
      max: 24,
      // Fail fast instead of hanging if the pool is momentarily saturated, so
      // fire-and-forget writes get dropped rather than piling up for 10s each.
      connectionTimeoutMillis: 4_000,
      idleTimeoutMillis: 30_000,
      // Kill any single runaway query so it can't hold a client forever. Long
      // enough not to interrupt normal queries; index builds run CONCURRENTLY
      // on their own and complete well under this.
      statement_timeout: 30_000
    });
  }
  return pool;
}
