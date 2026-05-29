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
}

export interface TradeInfo {
  mint: string;
  traderWallet: string;
  side: "buy" | "sell";
  amountSol: number;
  priceUsd: number;
  marketCap: number;
  signature: string;
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
}
