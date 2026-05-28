import { env } from "../../config/env.js";

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
}

interface DasAsset {
  id: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
}

interface DasResponse {
  result?: DasAsset;
  error?: unknown;
}

const cache = new Map<string, TokenMeta>();
const pending = new Set<string>();

const FALLBACK_KNOWN: Record<string, { name: string; symbol: string }> = {
  "So11111111111111111111111111111111111111112": { name: "Wrapped SOL", symbol: "SOL" },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { name: "USD Coin", symbol: "USDC" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { name: "Tether", symbol: "USDT" }
};

function fallback(mint: string): TokenMeta {
  const known = FALLBACK_KNOWN[mint];
  return {
    mint,
    name: known?.name ?? `Token ${mint.slice(0, 6)}`,
    symbol: known?.symbol ?? mint.slice(0, 6).toUpperCase()
  };
}

/** Fetch a single token's on-chain metadata via Helius DAS API (getAsset). */
export async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  if (cache.has(mint)) return cache.get(mint)!;
  if (!env.HELIUS_API_KEY) return fallback(mint);

  const rpcUrl = `${env.HELIUS_RPC_URL}${env.HELIUS_API_KEY}`;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `meta-${mint}`,
        method: "getAsset",
        params: { id: mint }
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) return fallback(mint);
    const json = (await res.json()) as DasResponse;
    const asset = json.result;
    const name = asset?.content?.metadata?.name?.trim() || fallback(mint).name;
    const symbol = asset?.content?.metadata?.symbol?.trim() || fallback(mint).symbol;
    const meta: TokenMeta = { mint, name, symbol };
    cache.set(mint, meta);
    return meta;
  } catch {
    return fallback(mint);
  }
}

/**
 * Enqueue a background metadata fetch.
 * Calls `onResult` when done so the caller can update state.
 * Dedupes concurrent requests for the same mint.
 */
export function enqueueMeta(mint: string, onResult: (meta: TokenMeta) => void): void {
  if (cache.has(mint)) { onResult(cache.get(mint)!); return; }
  if (pending.has(mint)) return;
  pending.add(mint);
  void fetchTokenMeta(mint).then((meta) => {
    pending.delete(mint);
    onResult(meta);
  });
}
