/**
 * Bitquery GraphQL adapter for Pump.fun.
 *
 * Uses Bitquery's streaming GraphQL API (REST polling mode) to:
 *  1. Detect brand-new token launches via create / create_v2 instructions
 *  2. Stream live buy/sell trades for all tracked tokens
 *
 * Endpoint: https://streaming.bitquery.io/graphql
 * Auth:     Authorization: Bearer <BITQUERY_API_KEY>
 */

import { env } from "../../config/env.js";

const ENDPOINT = "https://streaming.bitquery.io/graphql";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export interface BitqueryToken {
  mint: string;
  name: string;
  symbol: string;
  createdAt: string;
  devWallet: string;
}

export interface BitqueryTrade {
  mint: string;
  traderWallet: string;
  side: "buy" | "sell";
  amountSol: number;
  priceUsd: number;
  signature: string;
  timestamp: string;
}

// ─── GraphQL queries ────────────────────────────────────────────────────────

const NEW_TOKENS_QUERY = `
query NewPumpTokens($since: ISO8601DateTime) {
  Solana {
    TokenSupplyUpdates(
      where: {
        Instruction: {
          Program: {
            Address: { is: "${PUMP_PROGRAM}" }
            Method: { in: ["create", "create_v2"] }
          }
        }
        Block: { Time: { since: $since } }
        Transaction: { Result: { Success: true } }
      }
      orderBy: { descending: Block_Time }
      limit: { count: 100 }
    ) {
      Block { Time }
      Transaction { Signer Signature }
      TokenSupplyUpdate {
        Currency {
          Name
          Symbol
          MintAddress
        }
      }
    }
  }
}
`;

const RECENT_TRADES_QUERY = `
query PumpTrades($since: ISO8601DateTime, $mints: [String!]) {
  Solana {
    DEXTrades(
      where: {
        Trade: {
          Dex: { ProtocolName: { is: "pump" } }
          Buy: { Currency: { MintAddress: { in: $mints } } }
        }
        Transaction: { Result: { Success: true } }
        Block: { Time: { since: $since } }
      }
      orderBy: { descending: Block_Time }
      limit: { count: 200 }
    ) {
      Block { Time }
      Transaction { Signature }
      Trade {
        Buy {
          Amount
          Account { Address }
          Currency { MintAddress Symbol Name }
          Price
        }
        Sell {
          Amount
          Account { Address }
          Currency { MintAddress }
          PriceInUSD
        }
      }
    }
  }
}
`;

// ─── Adapter ────────────────────────────────────────────────────────────────

export class BitqueryAdapter {
  private seenMints = new Set<string>();
  private seenTradeSigs = new Set<string>();
  // Track the timestamp of the last successful launch/trade poll.
  private lastLaunchPollAt: Date = new Date(Date.now() - 60_000);
  private lastTradePollAt: Date = new Date(Date.now() - 60_000);
  private initialized = false;

  get available(): boolean {
    return !!env.BITQUERY_API_KEY;
  }

  /** Poll for newly launched tokens. Returns only genuinely new mints. */
  async pollNewLaunches(): Promise<BitqueryToken[]> {
    if (!this.available) return [];

    const since = this.lastLaunchPollAt.toISOString();

    try {
      const data = await this.query<{
        Solana: {
          TokenSupplyUpdates: Array<{
            Block: { Time: string };
            Transaction: { Signer: string; Signature: string };
            TokenSupplyUpdate: { Currency: { Name: string; Symbol: string; MintAddress: string } };
          }>;
        };
      }>(NEW_TOKENS_QUERY, { since });

      this.lastLaunchPollAt = new Date();

      const updates = data?.Solana?.TokenSupplyUpdates ?? [];

      if (!this.initialized) {
        // First poll: seed seen mints, skip backlog.
        this.initialized = true;
        const seedCount = updates.filter(u => u.TokenSupplyUpdate?.Currency?.MintAddress).length;
        console.log(`[Bitquery] initialized. seeded ${seedCount} existing mints from last ~60s (skipping backlog).`);
        for (const u of updates) {
          const mint = u.TokenSupplyUpdate?.Currency?.MintAddress;
          if (mint) this.seenMints.add(mint);
        }
        return [];
      }

      const results: BitqueryToken[] = [];
      for (const u of updates) {
        const currency = u.TokenSupplyUpdate?.Currency;
        const mint = currency?.MintAddress;
        if (!mint || this.seenMints.has(mint)) continue;
        this.seenMints.add(mint);
        results.push({
          mint,
          name: currency.Name?.trim() || `Token ${mint.slice(0, 6)}`,
          symbol: currency.Symbol?.trim() || mint.slice(0, 6).toUpperCase(),
          createdAt: u.Block?.Time ?? new Date().toISOString(),
          devWallet: u.Transaction?.Signer ?? ""
        });
      }

      if (results.length > 0) {
        console.log(`[Bitquery] ${results.length} new token(s): ${results.map(r => r.symbol).join(", ")}`);
      }

      if (this.seenMints.size > 30_000) {
        this.seenMints = new Set([...this.seenMints].slice(-15_000));
      }

      return results;
    } catch (err) {
      console.error("[Bitquery] pollNewLaunches error:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  /** Poll recent trades for a set of tracked mints. */
  async pollTrades(trackedMints: string[]): Promise<BitqueryTrade[]> {
    if (!this.available || trackedMints.length === 0) return [];

    const since = this.lastTradePollAt.toISOString();
    const mints = trackedMints.slice(0, 50); // keep query size reasonable

    try {
      const data = await this.query<{
        Solana: {
          DEXTrades: Array<{
            Block: { Time: string };
            Transaction: { Signature: string };
            Trade: {
              Buy: { Amount: number; Account: { Address: string }; Currency: { MintAddress: string }; Price: number };
              Sell: { Amount: number; Account: { Address: string }; Currency: { MintAddress: string }; PriceInUSD: number };
            };
          }>;
        };
      }>(RECENT_TRADES_QUERY, { since, mints });

      this.lastTradePollAt = new Date();

      const trades = data?.Solana?.DEXTrades ?? [];
      const results: BitqueryTrade[] = [];

      for (const t of trades) {
        const sig = t.Transaction?.Signature;
        if (!sig || this.seenTradeSigs.has(sig)) continue;
        this.seenTradeSigs.add(sig);

        const buy = t.Trade?.Buy;
        const sell = t.Trade?.Sell;
        const mint = buy?.Currency?.MintAddress ?? sell?.Currency?.MintAddress;
        if (!mint) continue;

        // Determine side: if buyer's currency is the token → it's a buy
        const isBuy = buy?.Currency?.MintAddress === mint;
        const trader = isBuy ? buy?.Account?.Address : sell?.Account?.Address;

        results.push({
          mint,
          traderWallet: trader ?? "",
          side: isBuy ? "buy" : "sell",
          amountSol: isBuy ? (sell?.Amount ?? 0) : (buy?.Amount ?? 0),
          priceUsd: sell?.PriceInUSD ?? 0,
          signature: sig,
          timestamp: t.Block?.Time ?? new Date().toISOString()
        });
      }

      if (this.seenTradeSigs.size > 50_000) {
        this.seenTradeSigs = new Set([...this.seenTradeSigs].slice(-25_000));
      }

      return results;
    } catch {
      return [];
    }
  }

  private async query<T>(queryStr: string, variables: Record<string, unknown>): Promise<T | null> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.BITQUERY_API_KEY}`
      },
      body: JSON.stringify({ query: queryStr, variables }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      console.error(`[Bitquery] HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const json = await res.json() as { data?: T; errors?: unknown[] };
    if (json.errors) {
      console.error("[Bitquery] GraphQL errors:", JSON.stringify(json.errors).slice(0, 200));
      return null;
    }
    return json.data ?? null;
  }
}
