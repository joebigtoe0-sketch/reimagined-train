import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
let pool: InstanceType<typeof Pool> | null = null;

export function getDbPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      // Fail fast instead of hanging forever if Postgres is briefly unreachable
      // (e.g. connection saturation during a deploy overlap). A hung connect here
      // would block startup and fail the Railway healthcheck.
      connectionTimeoutMillis: 10_000
    });
  }
  return pool;
}
