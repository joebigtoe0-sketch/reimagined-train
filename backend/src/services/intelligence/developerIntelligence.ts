import type { CanonicalEvent, DeveloperProfile, TokenState } from "../../types.js";

export function updateDeveloperProfile(
  existing: DeveloperProfile | undefined,
  event: CanonicalEvent,
  token: TokenState
): DeveloperProfile {
  const base: DeveloperProfile =
    existing ??
    {
      devWallet: token.devWallet,
      totalLaunches: 0,
      migrationCount: 0,
      rugCount: 0,
      averageAth: 0,
      averageLifespanMinutes: 0,
      averageHolderGrowth: 0,
      repeatBuyerOverlap: 0,
      devSellRate: 0,
      insiderFlags: 0,
      score: 35
    };

  if (event.type === "launch") base.totalLaunches += 1;
  if (event.type === "migration") base.migrationCount += 1;
  if (event.type === "trade" && event.side === "sell" && event.wallet === token.devWallet) base.devSellRate += 0.03;
  if (token.insiderConcentration > 0.35) base.insiderFlags += 1;
  if (token.lifecycle === "failed") base.rugCount += 1;

  base.averageAth = Number(((base.averageAth * 0.85) + token.athMarketCap * 0.15).toFixed(2));
  base.averageHolderGrowth = Number(((base.averageHolderGrowth * 0.9) + token.holderCount * 0.1).toFixed(2));
  base.repeatBuyerOverlap = Number(Math.min(1, base.repeatBuyerOverlap + 0.01).toFixed(3));
  base.averageLifespanMinutes = Number((base.averageLifespanMinutes * 0.95 + 1).toFixed(2));
  const migrationRate = base.totalLaunches === 0 ? 0 : base.migrationCount / base.totalLaunches;
  const rugRate = base.totalLaunches === 0 ? 0 : base.rugCount / base.totalLaunches;
  base.score = Math.max(1, Math.min(99, Math.round(55 + migrationRate * 28 - rugRate * 35 - base.devSellRate * 10)));
  return base;
}
