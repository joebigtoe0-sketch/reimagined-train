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
  // Full Solana RPC URL (with key) used for on-chain checks like Mayhem Mode
  // detection, e.g. https://solana-mainnet.g.alchemy.com/v2/<apikey>.
  ALCHEMY_API: z.string().optional(),
  BITQUERY_API_KEY: z.string().optional(),
  // Which feed powers launch + trade ingestion. Toggle freely between providers.
  INGEST_SOURCE: z.enum(["pumpportal", "bitquery"]).default("pumpportal"),
  // PumpPortal: new-token stream is free (no key). Trade stream is metered and
  // requires an API key + a linked wallet funded with >= 0.02 SOL.
  PUMPPORTAL_API_KEY: z.string().optional(),
  // PumpPortal reports market cap in SOL; convert to USD with this estimate.
  SOL_USD_ESTIMATE: z.coerce.number().default(150),
  // Cost control: the PumpPortal trade stream is metered (~0.01 SOL / 10k msgs),
  // so the number of mints we hold a trade subscription for drives spend. Lower
  // these to cut SOL burn; raise for wider coverage. The budget is allocated by
  // strategy relevance (held positions + young/cheap entry candidates first).
  MAX_TRADE_SUBSCRIPTIONS: z.coerce.number().default(200),
  TRADE_ACTIVE_WINDOW_MS: z.coerce.number().default(120000),
  // Drop Pump.fun "Mayhem Mode" launches (Token-2022 mints with an AI trading
  // agent). Detected on-chain via the mint's owner program.
  FILTER_MAYHEM: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // ── Live trading (real money) ─────────────────────────────────────────────
  // Base-58 private key of the dedicated bot wallet. Never commit. Set in
  // Railway env only. Absent = live trading disabled entirely.
  LIVE_WALLET_PRIVATE_KEY: z.string().optional(),
  // Solana RPC used for tx broadcast. Defaults to Helius if set, else public.
  LIVE_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  // SOL per trade. Keep small until edge is confirmed on real data.
  LIVE_BET_SIZE: z.coerce.number().default(0.1),
  // Max concurrent open positions (keeps total exposure ≤ LIVE_BET_SIZE × LIVE_MAX_OPEN).
  LIVE_MAX_OPEN: z.coerce.number().default(8),
  // Hard daily-loss limit in SOL. Bot disarms itself if realized losses exceed this.
  LIVE_MAX_DAILY_LOSS: z.coerce.number().default(0.5),
  // Priority fee in SOL per tx (added to each buy/sell to improve landing rate).
  LIVE_PRIORITY_FEE: z.coerce.number().default(0.0005),
  // Slippage tolerance % for PumpPortal trade-local.
  LIVE_SLIPPAGE: z.coerce.number().default(15),
  // Bundle Sniper live trader — separate from the playbook live bot.
  // Bet size in SOL per bundle-sniper trade (default 0.4).
  BUNDLE_BET_SIZE: z.coerce.number().default(0.4),
});

export const env = envSchema.parse(process.env);
