import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATABASE_URL: z.string().default("postgresql://pump:pump@localhost:5432/pumpfun"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().default(5000),
  INGEST_INTERVAL_MS: z.coerce.number().default(1200),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().default("https://mainnet.helius-rpc.com/?api-key="),
  HELIUS_MONITORED_WALLETS: z.string().default(""),
  HELIUS_GLOBAL_ADDRESSES: z.string().default(""),
  HELIUS_MAX_TRACKED_WALLETS: z.coerce.number().default(3000),
  HELIUS_WEBHOOK_SECRET: z.string().optional()
});

export const env = envSchema.parse(process.env);
