import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATABASE_URL: z.string().default("postgresql://pump:pump@localhost:5432/pumpfun"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().default(5000),
  INGEST_INTERVAL_MS: z.coerce.number().default(10000),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().default("https://mainnet.helius-rpc.com/?api-key="),
  HELIUS_MONITORED_WALLETS: z.string().default(""),
  HELIUS_GLOBAL_ADDRESSES: z.string().default(""),
  HELIUS_MAX_TRACKED_WALLETS: z.coerce.number().default(3000),
  HELIUS_MAX_TRACKED_MINTS: z.coerce.number().default(5000),
  HELIUS_SIGNATURE_LIMIT: z.coerce.number().default(50),
  HELIUS_WEBHOOK_SECRET: z.string().optional(),
  BITQUERY_API_KEY: z.string().optional(),
  // Which feed powers launch + trade ingestion. Toggle freely between providers.
  INGEST_SOURCE: z.enum(["pumpportal", "bitquery"]).default("pumpportal"),
  // PumpPortal: new-token stream is free (no key). Trade stream is metered and
  // requires an API key + a linked wallet funded with >= 0.02 SOL.
  PUMPPORTAL_API_KEY: z.string().optional(),
  // PumpPortal reports market cap in SOL; convert to USD with this estimate.
  SOL_USD_ESTIMATE: z.coerce.number().default(150),
  // Drop Pump.fun "Mayhem Mode" launches (Token-2022 mints with an AI trading
  // agent). Detected on-chain via the mint's owner program.
  FILTER_MAYHEM: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true")
});

export const env = envSchema.parse(process.env);
