import type { EventType, TradeSide } from "../../types.js";
import type { HeliusRawEvent } from "../../domain/events/normalizer.js";

type Json = Record<string, unknown>;

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function detectType(tx: Json): EventType {
  const txType = asString(tx.type).toUpperCase();
  if (txType.includes("SWAP")) return "trade";
  if (txType.includes("TRANSFER")) return "transfer";
  if (txType.includes("NFT_SALE")) return "trade";
  if (txType.includes("CREATE")) return "launch";
  if (txType.includes("ADD_LIQUIDITY") || txType.includes("REMOVE_LIQUIDITY")) return "liquidity";
  if (txType.includes("MIGRATION")) return "migration";

  const events = tx.events as Json | undefined;
  const hasSwap = !!(events && typeof events === "object" && "swap" in events);
  if (hasSwap) return "trade";

  const tokenTransfers = (tx.tokenTransfers as unknown[]) ?? [];
  if (tokenTransfers.length > 0) return "transfer";
  const nativeTransfers = (tx.nativeTransfers as unknown[]) ?? [];
  if (nativeTransfers.length > 0) return "funding";

  return "trade";
}

function detectSide(tx: Json): TradeSide | undefined {
  const description = asString(tx.description).toLowerCase();
  if (description.includes("buy")) return "buy";
  if (description.includes("sell")) return "sell";

  const tokenTransfers = (tx.tokenTransfers as Json[]) ?? [];
  if (tokenTransfers.length === 0) return undefined;
  const incoming = tokenTransfers.some((t) => !!t.toUserAccount);
  return incoming ? "buy" : "sell";
}

function getMint(tx: Json): string {
  const tokenTransfers = (tx.tokenTransfers as Json[]) ?? [];
  const firstMint = asString(tokenTransfers[0]?.mint);
  if (firstMint) return firstMint;
  const accountData = (tx.accountData as Json[]) ?? [];
  const fromToken = asString(accountData[0]?.tokenBalanceChanges as unknown);
  if (fromToken) return fromToken;
  return "UNKNOWN_MINT";
}

function getWallet(tx: Json): string {
  const feePayer = asString(tx.feePayer);
  if (feePayer) return feePayer;
  const signer = ((tx.signer as unknown[]) ?? [])[0];
  if (typeof signer === "string") return signer;
  return "UNKNOWN_WALLET";
}

function extractAmountSol(tx: Json): number {
  const nativeTransfers = (tx.nativeTransfers as Json[]) ?? [];
  if (nativeTransfers.length > 0) return asNumber(nativeTransfers[0].amount, 0) / 1_000_000_000;
  const tokenTransfers = (tx.tokenTransfers as Json[]) ?? [];
  if (tokenTransfers.length > 0) return asNumber(tokenTransfers[0].tokenAmount, 0);
  return 0;
}

export function decodeEnhancedTransactions(payload: unknown): HeliusRawEvent[] {
  const txs = Array.isArray(payload) ? payload : [];
  const events: HeliusRawEvent[] = [];

  for (const tx of txs) {
    if (!tx || typeof tx !== "object") continue;
    const row = tx as Json;
    const signature = asString(row.signature);
    if (!signature) continue;
    events.push({
      signature,
      slot: asNumber(row.slot),
      timestamp: asNumber(row.timestamp, Date.now() / 1000) * 1000,
      mint: getMint(row),
      wallet: getWallet(row),
      type: detectType(row),
      side: detectSide(row),
      amountSol: extractAmountSol(row),
      marketCap: 0
    });
  }

  return events;
}
