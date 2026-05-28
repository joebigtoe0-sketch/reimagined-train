/**
 * Pump.fun Frontend API adapter.
 *
 * Polls https://frontend-api.pump.fun/coins?sort=created_timestamp&order=DESC
 * to discover brand-new token launches with correct on-chain creation timestamps,
 * real names, symbols, creator wallet, and initial market cap.
 *
 * This replaces the Helius-based launch discovery which was unreliable because:
 *  - Helius "CREATE" events don't always include the right mint
 *  - The event timestamp is the ingestion time, not the creation block time
 *  - Rate limits meant we'd miss launches during busy periods
 */

const PUMP_API = "https://frontend-api.pump.fun";
const POLL_LIMIT = 50;

export interface PumpFunToken {
  mint: string;
  name: string;
  symbol: string;
  createdAt: string;    // ISO string from on-chain creation timestamp
  creatorWallet: string;
  usdMarketCap: number;
  complete: boolean;    // true = migrated to Raydium
  imageUri?: string;
  description?: string;
}

interface PumpApiCoin {
  mint?: string;
  name?: string;
  symbol?: string;
  created_timestamp?: number; // Unix seconds
  creator?: string;
  usd_market_cap?: number;
  market_cap?: number;
  complete?: boolean;
  king_of_the_hill_timestamp?: number;
  image_uri?: string;
  description?: string;
}

export class PumpFunAdapter {
  // Track which mints we've already ingested so we don't re-process them.
  private seenMints = new Set<string>();
  // High-water mark: newest creation timestamp we've processed (Unix ms).
  private newestSeenTs = 0;
  private initialized = false;

  /**
   * Poll for new launches. Returns only tokens launched after the last poll.
   * First call sets the high-water mark and returns nothing (skips backlog).
   */
  async pollNewLaunches(): Promise<PumpFunToken[]> {
    try {
      const url = `${PUMP_API}/coins?offset=0&limit=${POLL_LIMIT}&sort=created_timestamp&order=DESC&includeNsfw=false`;
      const res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) return [];

      const coins = (await res.json()) as PumpApiCoin[];
      if (!Array.isArray(coins) || coins.length === 0) return [];

      if (!this.initialized) {
        // First poll: record the newest timestamp as the watermark, return nothing.
        this.initialized = true;
        const newest = coins[0];
        if (newest?.created_timestamp) {
          this.newestSeenTs = newest.created_timestamp * 1000;
        }
        // Seed seen mints so we don't reprocess them later.
        for (const c of coins) { if (c.mint) this.seenMints.add(c.mint); }
        return [];
      }

      // Only take tokens created after our watermark and not already seen.
      const fresh: PumpFunToken[] = [];
      for (const coin of coins) {
        if (!coin.mint || this.seenMints.has(coin.mint)) continue;
        const ts = (coin.created_timestamp ?? 0) * 1000;
        if (ts <= this.newestSeenTs) continue;

        this.seenMints.add(coin.mint);
        fresh.push(this.normalize(coin));
      }

      // Advance watermark to the newest token we saw this poll.
      if (coins[0]?.created_timestamp) {
        this.newestSeenTs = Math.max(this.newestSeenTs, coins[0].created_timestamp * 1000);
      }

      // Keep seen set bounded.
      if (this.seenMints.size > 20_000) {
        this.seenMints = new Set([...this.seenMints].slice(-10_000));
      }

      return fresh;
    } catch {
      return [];
    }
  }

  /**
   * Fetch current data for a specific token (MC, lifecycle).
   */
  async fetchToken(mint: string): Promise<PumpFunToken | null> {
    try {
      const res = await fetch(`${PUMP_API}/coins/${mint}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const coin = (await res.json()) as PumpApiCoin;
      if (!coin?.mint) return null;
      return this.normalize(coin);
    } catch {
      return null;
    }
  }

  private normalize(coin: PumpApiCoin): PumpFunToken {
    return {
      mint: coin.mint ?? "",
      name: (coin.name ?? "").trim() || `Token ${(coin.mint ?? "").slice(0, 6)}`,
      symbol: (coin.symbol ?? "").trim() || (coin.mint ?? "").slice(0, 6).toUpperCase(),
      createdAt: coin.created_timestamp
        ? new Date(coin.created_timestamp * 1000).toISOString()
        : new Date().toISOString(),
      creatorWallet: coin.creator ?? "",
      usdMarketCap: coin.usd_market_cap ?? 0,
      complete: coin.complete ?? false,
      imageUri: coin.image_uri,
      description: coin.description
    };
  }
}
