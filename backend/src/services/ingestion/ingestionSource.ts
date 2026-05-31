/**
 * Shared contract for a launch + trade ingestion provider.
 *
 * Both BitqueryAdapter (REST polling) and PumpPortalAdapter (WebSocket buffer)
 * implement this so the RuntimeEngine can switch providers via INGEST_SOURCE
 * without any other code changes.
 */

export interface LaunchInfo {
  mint: string;
  name: string;
  symbol: string;
  createdAt: string;
  devWallet: string;
  /** Optional initial market cap in USD (PumpPortal supplies one on creation). */
  initialMarketCapUsd?: number;
  /**
   * SOL amount bought by the creator in the SAME transaction as the token creation.
   * For same-block Jito bundles the gang often buys in the create tx itself —
   * this field lets the bundle detector fire immediately without waiting for a
   * subscribeTokenTrade event that might never arrive in time.
   */
  initialBuySol?: number;
  /** Social links from token metadata — available on PumpPortal create events. */
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface TradeInfo {
  mint: string;
  traderWallet: string;
  side: "buy" | "sell";
  amountSol: number;
  tokenAmount: number;
  priceUsd: number;
  marketCap: number;
  signature: string;
  timestamp: string;
}

/** A bonding-curve graduation (token migrated to a DEX/AMM). */
export interface MigrationInfo {
  mint: string;
  signature: string;
  pool?: string;
  marketCap?: number;
  timestamp: string;
}

export interface IngestionSource {
  /** Stable identifier, e.g. "pumpportal" | "bitquery". */
  readonly name: string;
  /** Whether this source can run right now. */
  readonly available: boolean;
  /** Called once at startup to validate connectivity/credentials. */
  verify(): Promise<void>;
  /** Drain/poll any newly discovered token launches. */
  pollNewLaunches(): Promise<LaunchInfo[]>;
  /** Drain/poll recent trades for the given tracked mints. */
  pollTrades(mints: string[]): Promise<TradeInfo[]>;
  /**
   * Drain/poll bonding-curve graduations (token migrations). Optional: a
   * provider that can't emit migrations simply omits it. The stream is global
   * (all tokens), so it labels migrations even for mints we stopped tracking.
   */
  pollMigrations?(): Promise<MigrationInfo[]>;
}
