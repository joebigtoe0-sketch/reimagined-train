import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
let pool: InstanceType<typeof Pool> | null = null;

export function getDbPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL
    });
  }
  return pool;
}
