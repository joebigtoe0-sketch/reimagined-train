import type { CanonicalEvent, EventType, TradeSide } from "../../types.js";

export interface HeliusRawEvent {
  signature: string;
  slot: number;
  timestamp: number;
  mint: string;
  wallet: string;
  type: EventType;
  side?: TradeSide;
  amountSol?: number;
  marketCap?: number;
}

export function normalizeHeliusEvent(raw: HeliusRawEvent): CanonicalEvent {
  return {
    id: `${raw.signature}:${raw.type}:${raw.wallet}`,
    source: "helius",
    type: raw.type,
    mint: raw.mint,
    wallet: raw.wallet,
    timestamp: new Date(raw.timestamp).toISOString(),
    signature: raw.signature,
    amountSol: raw.amountSol ?? 0,
    marketCap: raw.marketCap ?? 0,
    side: raw.side,
    metadata: {
      slot: raw.slot
    }
  };
}
