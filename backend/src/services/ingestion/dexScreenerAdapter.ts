/**
 * DexScreener free API adapter.
 * Used to get real-time market cap for tokens already on-chain.
 * No API key required. Rate limit: ~300 req/min.
 */

const DEXSCREENER_API = "https://api.dexscreener.com";

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
}

interface DexResponse {
  pairs?: DexPair[] | null;
}

export interface DexScreenerData {
  mint: string;
  marketCapUsd: number;
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
  buys24h: number;
  sells24h: number;
}

export class DexScreenerAdapter {
  private lastFetch = new Map<string, number>();
  private readonly cacheTtlMs = 15_000; // 15s per mint

  /**
   * Fetch market cap + trade data for up to 30 mints in one call.
   * Returns a map of mint → DexScreenerData.
   */
  async fetchBatch(mints: string[]): Promise<Map<string, DexScreenerData>> {
    const result = new Map<string, DexScreenerData>();
    if (mints.length === 0) return result;

    // DexScreener allows comma-separated token addresses, max 30 per request.
    const unique = [...new Set(mints)].slice(0, 30);
    try {
      const url = `${DEXSCREENER_API}/tokens/v1/solana/${unique.join(",")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return result;

      const json = (await res.json()) as DexResponse | DexPair[];
      const pairs: DexPair[] = Array.isArray(json)
        ? json
        : (json as DexResponse).pairs ?? [];

      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        // Pick the pair with the highest liquidity for this mint.
        const existing = result.get(mint);
        const liquidity = pair.liquidity?.usd ?? 0;
        if (existing && existing.liquidityUsd >= liquidity) continue;

        result.set(mint, {
          mint,
          marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
          priceUsd: parseFloat(pair.priceUsd ?? "0"),
          liquidityUsd: liquidity,
          volume24h: pair.volume?.h24 ?? 0,
          buys24h: pair.txns?.h24?.buys ?? 0,
          sells24h: pair.txns?.h24?.sells ?? 0
        });
      }
    } catch { /* silent */ }

    return result;
  }

  /**
   * Returns mints that are due for a refresh (haven't been fetched in cacheTtlMs).
   */
  filterStale(mints: string[]): string[] {
    const now = Date.now();
    return mints.filter((m) => {
      const last = this.lastFetch.get(m) ?? 0;
      return now - last > this.cacheTtlMs;
    });
  }

  markFetched(mints: string[]): void {
    const now = Date.now();
    for (const m of mints) this.lastFetch.set(m, now);
  }
}
