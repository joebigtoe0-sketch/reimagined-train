import type { Redis } from "ioredis";
import { listTokens } from "../state/store.js";

export interface Snapshotter {
  start: () => void;
  stop: () => void;
}

export function createSnapshotter(redis: Redis | null, intervalMs: number): Snapshotter {
  let timer: NodeJS.Timeout | null = null;
  let lastSnapshotMs = 0;

  const tick = async (): Promise<void> => {
    const nowMs = Date.now();
    if (lastSnapshotMs > 0 && nowMs - lastSnapshotMs < intervalMs * 0.95) {
      return;
    }
    lastSnapshotMs = nowMs;

    const payload = {
      timestamp: new Date().toISOString(),
      tokens: listTokens().map((t) => ({
        mint: t.mint,
        marketCap: t.marketCap,
        holders: t.holderCount,
        buySellRatio: t.sellCount === 0 ? t.buyCount : Number((t.buyCount / t.sellCount).toFixed(2)),
        smartWalletExposure: t.smartWalletCount,
        insiderConcentration: t.insiderConcentration,
        probabilityContinuation: t.probabilityContinuation
      }))
    };

    if (redis) {
      await redis.xadd("token:snapshots", "*", "data", JSON.stringify(payload));
      await redis.xtrim("token:snapshots", "MAXLEN", "~", "10000");
    }
  };

  return {
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }
  };
}
