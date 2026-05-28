import type { TokenState } from "../types.js";
import type { MarketSignals } from "../services/signals/marketSignals.js";

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

export function scoreToken(token: TokenState, signals?: MarketSignals): TokenState {
  let score = 0;

  score += token.devScore > 60 ? 20 : 0;
  score += token.smartWalletCount >= 2 ? 15 : 0;
  score += token.holderCount > 100 ? 10 : 0;
  score += token.smartWalletNetFlow > 0 ? 8 : -8;
  score += token.buyCount >= token.sellCount * 1.5 ? 5 : -5;
  score -= token.insiderConcentration > 0.35 ? 25 : 0;
  score -= token.smartWalletNetFlow < -2 ? 15 : 0;

  if (signals) {
    score += Math.round(signals.accumulationStrength * 22);
    score += Math.round(signals.holderGrowthQuality * 12);
    score -= Math.round(signals.distributionRisk * 23);
    score -= Math.round(signals.insiderRisk * 30);
    score += Math.round(signals.smartWalletConviction * 14);
  }

  const normalized = clamp((score + 40) / 100, 0, 1);
  const continuation = clamp(Math.round(normalized * 100), 1, 99);
  const migration = clamp(Math.round((normalized * 0.8 + token.devScore / 500) * 100), 1, 99);
  const rug = clamp(Math.round((1 - normalized + token.insiderConcentration * 0.5) * 100), 1, 99);
  const hit30kBefore10k = clamp(Math.round((normalized * 0.75 + Math.min(1, token.marketCap / 30_000) * 0.25) * 100), 1, 99);
  const localTop = clamp(Math.round((1 - normalized * 0.7 + (token.marketCap / Math.max(1, token.athMarketCap)) * 0.3) * 100), 1, 99);
  const lifecycle: TokenState["lifecycle"] =
    continuation > 62 && rug < 40 ? "accumulation" : localTop > 68 ? "distribution" : migration > 72 ? "migrated" : rug > 70 ? "failed" : "new";

  return {
    ...token,
    score,
    probabilityContinuation: continuation,
    probabilityMigration: migration,
    probabilityRug: rug,
    probabilityHit30kBefore10k: hit30kBefore10k,
    probabilityLocalTop: localTop,
    lifecycle
  };
}
