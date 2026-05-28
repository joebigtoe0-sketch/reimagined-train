import type { FeatureRow } from "./featurePipeline.js";

export interface MlInference {
  mint: string;
  continuation: number;
  migration: number;
  rug: number;
}

export function runShadowInference(features: FeatureRow[]): MlInference[] {
  return features.map((row) => {
    const continuation = Math.max(
      1,
      Math.min(
        99,
        Math.round(
          0.45 * row.continuation +
            row.smartWalletCount * 2.4 +
            row.smartWalletNetFlow * 2.2 -
            row.insiderConcentration * 30 +
            row.avgWalletWinRate * 0.08
        )
      )
    );
    const migration = Math.max(1, Math.min(99, Math.round(0.6 * row.migration + row.devScore * 0.25 - row.rug * 0.15)));
    const rug = Math.max(1, Math.min(99, Math.round(0.65 * row.rug + row.insiderConcentration * 35 - row.avgWalletConfidence * 0.1)));
    return { mint: row.mint, continuation, migration, rug };
  });
}
