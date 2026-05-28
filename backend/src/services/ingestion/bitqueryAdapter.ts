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

// Pump.fun create instruction accounts: [mint, mintAuthority/global, bondingCurve, ...]
// The mint is always AccountNames[0] === "mint", or the first writable account.
function extractMint(ix: {
  Accounts: Array<{ Address: string; IsWritable: boolean }>;
  Program: { AccountNames: string[] };
}): string | null {
  const names = ix.Program.AccountNames ?? [];
  const accounts = ix.Accounts ?? [];
  // Prefer explicit name match
  const mintIdx = names.indexOf("mint");
  if (mintIdx >= 0 && accounts[mintIdx]?.Address) return accounts[mintIdx].Address;
  // Fallback: first writable account (index 0 in create instruction)
  const first = accounts.find(a => a.IsWritable);
  return first?.Address ?? null;
}

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

// Use Instructions query — reads name/symbol directly from on-chain tx args.
// TokenSupplyUpdates.Currency.Name/Symbol are often empty for brand-new tokens
// because metadata indexing has a delay. Instructions args are always immediate.
const NEW_TOKENS_QUERY = `
query NewPumpTokens($since: ISO8601DateTime) {
  Solana {
    Instructions(
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
      Instruction {
        Accounts {
          Address
          IsWritable
        }
        Program {
          AccountNames
          Arguments {
            Name
            Type
            Value {
              ... on Solana_ABI_String_Value_Arg { string }
            }
          }
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
  private lastLaunchPollAt: Date = new Date(Date.now() - 60_000);
  private lastTradePollAt: Date = new Date(Date.now() - 60_000);
  private initialized = false;
  private _verified = false;

  get available(): boolean {
    return !!env.BITQUERY_API_KEY;
  }

  /** Call once at startup to verify the key actually works. */
  async verify(): Promise<void> {
    if (!this.available) {
      console.error("[Bitquery] BITQUERY_API_KEY is not set — launches will NOT be tracked.");
      return;
    }
    // Simple ping: ask for the most recent Pump.fun create instruction
    const PING_QUERY = `
      query Ping {
        Solana {
          Instructions(
            where: {
              Instruction: {
                Program: {
                  Address: { is: "${PUMP_PROGRAM}" }
                  Method: { in: ["create", "create_v2"] }
                }
              }
              Transaction: { Result: { Success: true } }
            }
            limit: { count: 1 }
            orderBy: { descending: Block_Time }
          ) {
            Block { Time }
            Instruction {
              Program {
                Arguments { Name Value { ... on Solana_ABI_String_Value_Arg { string } } }
              }
            }
          }
        }
      }
    `;
    const data = await this.query<{ Solana: { Instructions: Array<{ Instruction: { Program: { Arguments: Array<{ Name: string; Value: { string?: string } }> } } }> } }>(PING_QUERY, {});
    if (data?.Solana?.Instructions != null) {
      this._verified = true;
      const args = data.Solana.Instructions[0]?.Instruction?.Program?.Arguments ?? [];
      const symbol = args.find(a => a.Name === "symbol")?.Value.string ?? "?";
      console.log(`[Bitquery] ✓ connection verified. Most recent pump token: $${symbol}`);
    } else {
      console.error("[Bitquery] ✗ verification failed — key may be wrong or expired. Check Railway env var BITQUERY_API_KEY.");
      console.error("[Bitquery] Make sure you use an OAuth2 Bearer Token (NOT the V1 API key). Generate at: https://account.bitquery.io/user/api_v2/access_tokens");
    }
  }

  /** Poll for newly launched tokens. Returns only genuinely new mints. */
  async pollNewLaunches(): Promise<BitqueryToken[]> {
    if (!this.available) return [];

    const since = this.lastLaunchPollAt.toISOString();

    try {
      const data = await this.query<{
        Solana: {
          Instructions: Array<{
            Block: { Time: string };
            Transaction: { Signer: string; Signature: string };
            Instruction: {
              Accounts: Array<{ Address: string; IsWritable: boolean }>;
              Program: {
                AccountNames: string[];
                Arguments: Array<{
                  Name: string;
                  Type: string;
                  Value: { string?: string };
                }>;
              };
            };
          }>;
        };
      }>(NEW_TOKENS_QUERY, { since });

      this.lastLaunchPollAt = new Date();

      const instructions = data?.Solana?.Instructions ?? [];

      if (!this.initialized) {
        this.initialized = true;
        // Seed seen mints from first-poll backlog so we don't replay them.
        let seeded = 0;
        for (const ix of instructions) {
          const mint = extractMint(ix.Instruction);
          if (mint) { this.seenMints.add(mint); seeded++; }
        }
        console.log(`[Bitquery] initialized. seeded ${seeded} existing mints (skipping backlog).`);
        return [];
      }

      const results: BitqueryToken[] = [];
      for (const ix of instructions) {
        const mint = extractMint(ix.Instruction);
        if (!mint || this.seenMints.has(mint)) continue;
        this.seenMints.add(mint);

        const args = ix.Instruction.Program.Arguments ?? [];
        const name = args.find(a => a.Name === "name")?.Value.string?.trim() ?? "";
        const symbol = args.find(a => a.Name === "symbol")?.Value.string?.trim() ?? "";

        results.push({
          mint,
          name: name || `Token ${mint.slice(0, 6)}`,
          symbol: symbol || mint.slice(0, 6).toUpperCase(),
          createdAt: ix.Block?.Time ?? new Date().toISOString(),
          devWallet: ix.Transaction?.Signer ?? ""
        });
      }

      if (results.length > 0) {
        console.log(`[Bitquery] ${results.length} new token(s): ${results.map(r => `$${r.symbol} (${r.name})`).join(", ")}`);
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
