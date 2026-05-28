import { Pool } from "pg";
import { env } from "../config/env.js";

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL
    });
  }
  return pool;
}
