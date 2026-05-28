/**
 * Pump.fun launch discovery using two complementary sources:
 *
 * PRIMARY — Helius enhanced transactions on the Pump.fun global state account:
 *   TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM
 *   Every transaction on this account is a CreateToken — no filtering needed.
 *   We extract the new mint address from tokenTransfers.
 *
 * ENRICHMENT — Pump.fun per-coin REST API:
 *   https://frontend-api.pump.fun/coins/{mint}
 *   Gives us the real name, symbol, creation timestamp, creator wallet, and MC.
 *   Falls back to Helius DAS getAsset if the coin endpoint is unreachable.
 */

import { env } from "../../config/env.js";

// Pump.fun program — every token creation goes through this (filter type=CREATE).
export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Pump.fun global state account — co-signer on CreateToken txns (supplemental).
export const PUMP_FUN_GLOBAL = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

const LAUNCH_ADDRESSES = [PUMP_FUN_PROGRAM, PUMP_FUN_GLOBAL];

const HELIUS_REST = "https://api.helius.xyz/v0";
const PUMP_COIN_API = "https://frontend-api.pump.fun/coins";

export interface PumpFunToken {
  mint: string;
  name: string;
  symbol: string;
  createdAt: string;
  creatorWallet: string;
  usdMarketCap: number;
  complete: boolean;
}

interface HeliusTx {
  signature?: string;
  timestamp?: number;
  feePayer?: string;
  tokenTransfers?: Array<{ mint?: string; toUserAccount?: string; fromUserAccount?: string; tokenAmount?: number }>;
  accountData?: Array<{ account?: string }>;
}

interface PumpCoin {
  mint?: string;
  name?: string;
  symbol?: string;
  created_timestamp?: number;
  creator?: string;
  usd_market_cap?: number;
  complete?: boolean;
}

/** Extract the new SPL token mint from a Pump.fun CreateToken transaction. */
function extractMintFromTx(tx: HeliusTx): string | null {
  // The new mint appears in tokenTransfers going TO the bonding curve.
  for (const tt of tx.tokenTransfers ?? []) {
    const mint = tt.mint ?? "";
    if (mint && mint.length >= 32 && !mint.startsWith("So11")) return mint;
  }
  return null;
}

export class PumpFunAdapter {
  private seenMints = new Set<string>();
  // Per-address high-water marks and init flags.
  private highWaterMarks = new Map<string, string>();
  private initializedAddresses = new Set<string>();

  async pollNewLaunches(): Promise<PumpFunToken[]> {
    if (!env.HELIUS_API_KEY) return [];

    const newMints: Array<{ mint: string; tx: HeliusTx }> = [];

    // Poll BOTH the program address (with type=CREATE) and the global state account.
    // Using both maximises coverage — some launches only appear in one source.
    for (const address of LAUNCH_ADDRESSES) {
      const txns = await this.fetchAddressTxns(address);
      if (txns.length === 0) continue;

      if (!this.initializedAddresses.has(address)) {
        // First poll for this address: set watermark, seed seen mints, skip batch.
        this.initializedAddresses.add(address);
        this.highWaterMarks.set(address, txns[0]?.signature ?? "");
        for (const tx of txns) {
          const mint = extractMintFromTx(tx);
          if (mint) this.seenMints.add(mint);
        }
        continue;
      }

      const waterMark = this.highWaterMarks.get(address) ?? "";
      const waterMarkIdx = waterMark
        ? txns.findIndex((tx) => tx.signature === waterMark)
        : -1;

      // waterMarkIdx  0 → only those N items are new
      // waterMarkIdx -1 → entire page is new (many launches while backend was busy)
      // waterMarkIdx  0 → nothing new yet
      const freshTxns = waterMarkIdx > 0
        ? txns.slice(0, waterMarkIdx)
        : waterMarkIdx === -1 ? txns : [];

      // Advance watermark to newest signature seen.
      if (txns[0]?.signature) this.highWaterMarks.set(address, txns[0].signature);

      for (const tx of freshTxns) {
        const mint = extractMintFromTx(tx);
        if (!mint || this.seenMints.has(mint)) continue;
        this.seenMints.add(mint);
        newMints.push({ mint, tx });
      }
    }

    if (newMints.length === 0) return [];

    // Enrich each new mint with name/symbol/MC.
    const enriched = await Promise.all(
      newMints.map(({ mint, tx }) => this.enrichMint(mint, tx))
    );

    if (this.seenMints.size > 20_000) {
      this.seenMints = new Set([...this.seenMints].slice(-10_000));
    }

    return enriched.filter((t): t is PumpFunToken => t !== null);
  }

  /** Fetch per-token details for an already-tracked mint (for MC refresh). */
  async fetchToken(mint: string): Promise<PumpFunToken | null> {
    return this.enrichMint(mint, null);
  }

  private async fetchAddressTxns(address: string): Promise<HeliusTx[]> {
    try {
      const params = new URLSearchParams({
        "api-key": env.HELIUS_API_KEY!,
        limit: String(env.HELIUS_SIGNATURE_LIMIT)
      });
      // For the main program address, filter to CREATE type only to avoid
      // getting thousands of SWAP transactions.
      if (address === PUMP_FUN_PROGRAM) {
        params.set("type", "CREATE");
      }
      const url = `${HELIUS_REST}/addresses/${address}/transactions?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const data = await res.json() as unknown;
      return Array.isArray(data) ? (data as HeliusTx[]) : [];
    } catch {
      return [];
    }
  }

  private async enrichMint(mint: string, tx: HeliusTx | null): Promise<PumpFunToken | null> {
    // Try Pump.fun per-coin API first.
    try {
      const res = await fetch(`${PUMP_COIN_API}/${mint}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const coin = await res.json() as PumpCoin;
        if (coin?.mint) {
          return {
            mint: coin.mint,
            name: coin.name?.trim() || `Token ${mint.slice(0, 6)}`,
            symbol: coin.symbol?.trim() || mint.slice(0, 6).toUpperCase(),
            createdAt: coin.created_timestamp
              ? new Date(coin.created_timestamp * 1000).toISOString()
              : (tx?.timestamp ? new Date(tx.timestamp * 1000).toISOString() : new Date().toISOString()),
            creatorWallet: coin.creator ?? tx?.feePayer ?? "",
            usdMarketCap: coin.usd_market_cap ?? 0,
            complete: coin.complete ?? false
          };
        }
      }
    } catch { /* fall through to DAS */ }

    // Fallback: Helius DAS getAsset for name/symbol.
    if (env.HELIUS_API_KEY) {
      try {
        const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: mint, method: "getAsset", params: { id: mint } }),
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
          const json = await res.json() as { result?: { content?: { metadata?: { name?: string; symbol?: string } } } };
          const meta = json.result?.content?.metadata;
          return {
            mint,
            name: meta?.name?.trim() || `Token ${mint.slice(0, 6)}`,
            symbol: meta?.symbol?.trim() || mint.slice(0, 6).toUpperCase(),
            createdAt: tx?.timestamp ? new Date(tx.timestamp * 1000).toISOString() : new Date().toISOString(),
            creatorWallet: tx?.feePayer ?? "",
            usdMarketCap: 0,
            complete: false
          };
        }
      } catch { /* give up */ }
    }

    // Last resort: build from what we have in the tx.
    if (!mint) return null;
    return {
      mint,
      name: `Token ${mint.slice(0, 6)}`,
      symbol: mint.slice(0, 6).toUpperCase(),
      createdAt: tx?.timestamp ? new Date(tx.timestamp * 1000).toISOString() : new Date().toISOString(),
      creatorWallet: tx?.feePayer ?? "",
      usdMarketCap: 0,
      complete: false
    };
  }
}
