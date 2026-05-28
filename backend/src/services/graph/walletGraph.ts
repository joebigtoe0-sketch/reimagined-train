import type { CanonicalEvent } from "../../types.js";

export interface WalletEdge {
  walletA: string;
  walletB: string;
  coOccurrenceCount: number;
  synchronizedTradeCount: number;
  fundingOverlapCount: number;
  relationScore: number;
}

export function buildWalletGraph(events: CanonicalEvent[]): WalletEdge[] {
  const byMint = new Map<string, CanonicalEvent[]>();
  for (const event of events) {
    const list = byMint.get(event.mint) ?? [];
    list.push(event);
    byMint.set(event.mint, list);
  }

  const pairs = new Map<string, WalletEdge>();
  for (const list of byMint.values()) {
    const wallets = [...new Set(list.map((e) => e.wallet))];
    for (let i = 0; i < wallets.length; i += 1) {
      for (let j = i + 1; j < wallets.length; j += 1) {
        const walletA = wallets[i];
        const walletB = wallets[j];
        const key = `${walletA}:${walletB}`;
        const edge = pairs.get(key) ?? {
          walletA,
          walletB,
          coOccurrenceCount: 0,
          synchronizedTradeCount: 0,
          fundingOverlapCount: 0,
          relationScore: 0
        };
        edge.coOccurrenceCount += 1;
        const syncTrade = list.some((e) => e.wallet === walletA && e.type === "trade") && list.some((e) => e.wallet === walletB && e.type === "trade");
        if (syncTrade) edge.synchronizedTradeCount += 1;
        if (list.some((e) => e.type === "funding")) edge.fundingOverlapCount += 1;
        edge.relationScore = Number((edge.coOccurrenceCount * 0.6 + edge.synchronizedTradeCount * 0.8 + edge.fundingOverlapCount * 0.5).toFixed(3));
        pairs.set(key, edge);
      }
    }
  }
  return [...pairs.values()];
}
