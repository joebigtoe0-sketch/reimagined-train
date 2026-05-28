import type { CanonicalEvent, TokenState } from "../../types.js";

export interface ReplayPoint {
  ts: string;
  mint: string;
  marketCap: number;
  holderCount: number;
  continuation: number;
}

export function replayTokenTimeline(events: CanonicalEvent[], token: TokenState): ReplayPoint[] {
  const sorted = [...events].filter((e) => e.mint === token.mint).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let mc = token.marketCap * 0.4;
  let holders = Math.max(1, Math.floor(token.holderCount * 0.3));
  const timeline: ReplayPoint[] = [];

  for (const event of sorted) {
    if (event.type === "trade") mc += event.side === "buy" ? event.amountSol * 900 : -event.amountSol * 650;
    if (event.type === "launch") mc = Math.max(mc, event.marketCap || mc);
    holders = Math.max(1, holders + (event.type === "trade" && event.side === "buy" ? 1 : 0));
    timeline.push({
      ts: event.timestamp,
      mint: event.mint,
      marketCap: Math.max(800, Math.round(mc)),
      holderCount: holders,
      continuation: token.probabilityContinuation
    });
  }

  if (timeline.length === 0) {
    return [
      {
        ts: token.createdAt,
        mint: token.mint,
        marketCap: token.marketCap,
        holderCount: token.holderCount,
        continuation: token.probabilityContinuation
      }
    ];
  }

  return timeline.sort((a, b) => a.ts.localeCompare(b.ts));
}
