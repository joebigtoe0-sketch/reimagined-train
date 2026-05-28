import type { WalletCategory, WalletProfile } from "../../types.js";

export function classifyWallet(profile: WalletProfile): WalletCategory {
  if (profile.totalTrades < 8) return "unknown";
  if (profile.winRate >= 62 && profile.avgEntryMc < 12_000 && profile.avgReturnMultiple > 2) return "elite_early";
  if (profile.winRate >= 58 && profile.avgHoldMinutes > 20) return "continuation";
  if (profile.avgHoldMinutes < 4 && profile.totalTrades > 20) return "scalper";
  if (profile.avgEntryMc < 5_000 && profile.avgHoldMinutes < 6) return "sniper";
  if (profile.avgExitMc > profile.avgEntryMc * 2.4 && profile.winRate > 50) return "distribution";
  if (profile.rugExposureRate > 0.35) return "insider";
  if (profile.winRate < 35 || profile.realizedPnl < 0) return "bad";
  return "unknown";
}
