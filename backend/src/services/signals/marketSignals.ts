import type { TokenState, WalletProfile } from "../../types.js";

export interface MarketSignals {
  accumulationStrength: number;
  distributionRisk: number;
  holderGrowthQuality: number;
  insiderRisk: number;
  smartWalletConviction: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function detectMarketSignals(token: TokenState, activeWallets: WalletProfile[]): MarketSignals {
  const eliteWallets = activeWallets.filter((w) => w.category === "elite_early" || w.category === "continuation").length;
  const badWallets = activeWallets.filter((w) => w.category === "bad" || w.category === "insider").length;
  const buySellRatio = token.sellCount === 0 ? token.buyCount : token.buyCount / token.sellCount;

  const accumulationStrength = clamp((buySellRatio / 2) * 0.5 + Math.max(0, token.smartWalletNetFlow) * 0.12 + eliteWallets * 0.05);
  const distributionRisk = clamp((1 / Math.max(1, buySellRatio)) * 0.4 + Math.max(0, -token.smartWalletNetFlow) * 0.2 + badWallets * 0.06);
  const holderGrowthQuality = clamp((token.holderCount / 200) * 0.6 + (eliteWallets / Math.max(1, activeWallets.length)) * 0.4);
  const insiderRisk = clamp(token.insiderConcentration * 0.8 + badWallets * 0.05);
  const smartWalletConviction = clamp(token.smartWalletCount * 0.09 + Math.max(0, token.smartWalletNetFlow) * 0.15);

  return { accumulationStrength, distributionRisk, holderGrowthQuality, insiderRisk, smartWalletConviction };
}
