import type { CanonicalEvent, WalletProfile } from "../../types.js";
import { classifyWallet } from "./walletClassifier.js";

function decayConfidence(confidence: number, minutesSinceSeen: number): number {
  const decay = Math.min(25, minutesSinceSeen * 0.05);
  return Math.max(5, confidence - decay);
}

export function updateWalletProfile(existing: WalletProfile | undefined, event: CanonicalEvent): WalletProfile {
  const base: WalletProfile =
    existing ??
    {
      wallet: event.wallet,
      winRate: 50,
      avgReturnMultiple: 1,
      confidence: 40,
      category: "unknown",
      avgEntryMc: event.marketCap || 0,
      avgExitMc: event.marketCap || 0,
      avgHoldMinutes: 10,
      migrationSuccessRate: 0.2,
      rugExposureRate: 0.1,
      totalTrades: 0,
      realizedPnl: 0
    };

  const isTrade = event.type === "trade" && event.side;
  if (isTrade) {
    base.totalTrades += 1;
    if (event.side === "buy") {
      base.avgEntryMc = Number(((base.avgEntryMc * 0.8) + event.marketCap * 0.2).toFixed(2));
      base.confidence = Math.min(95, base.confidence + 1.1);
    } else {
      base.avgExitMc = Number(((base.avgExitMc * 0.8) + event.marketCap * 0.2).toFixed(2));
      const tradeReturn = base.avgEntryMc === 0 ? 1 : event.marketCap / Math.max(1, base.avgEntryMc);
      base.avgReturnMultiple = Number(((base.avgReturnMultiple * 0.9) + tradeReturn * 0.1).toFixed(3));
      if (tradeReturn > 1.2) base.winRate = Math.min(99, base.winRate + 1.3);
      else base.winRate = Math.max(1, base.winRate - 1.2);
      base.realizedPnl += (tradeReturn - 1) * 100;
    }
  }

  if (event.type === "migration") {
    base.migrationSuccessRate = Number(Math.min(1, base.migrationSuccessRate + 0.03).toFixed(3));
  }

  if (event.type === "funding" || event.type === "transfer") {
    base.rugExposureRate = Number(Math.min(1, base.rugExposureRate + 0.005).toFixed(3));
  }

  base.avgHoldMinutes = Number((base.avgHoldMinutes * 0.98 + 0.2).toFixed(2));
  base.confidence = Number(decayConfidence(base.confidence, 1).toFixed(2));
  base.category = classifyWallet(base);
  return base;
}
