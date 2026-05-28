import type { ProbabilityRecord, TokenState, WalletProfile } from "../../types.js";

export interface FeatureRow {
  mint: string;
  continuation: number;
  migration: number;
  rug: number;
  smartWalletCount: number;
  smartWalletNetFlow: number;
  insiderConcentration: number;
  devScore: number;
  avgWalletWinRate: number;
  avgWalletConfidence: number;
}

export function buildFeatureRows(tokens: TokenState[], wallets: WalletProfile[], probabilities: ProbabilityRecord[]): FeatureRow[] {
  const avgWalletWinRate =
    wallets.length === 0 ? 0 : Number((wallets.reduce((sum, w) => sum + w.winRate, 0) / wallets.length).toFixed(2));
  const avgWalletConfidence =
    wallets.length === 0 ? 0 : Number((wallets.reduce((sum, w) => sum + w.confidence, 0) / wallets.length).toFixed(2));

  const byMint = new Map(probabilities.map((p) => [p.mint, p]));
  return tokens.map((token) => {
    const p = byMint.get(token.mint);
    return {
      mint: token.mint,
      continuation: p?.continuation ?? token.probabilityContinuation,
      migration: p?.migration ?? token.probabilityMigration,
      rug: p?.rug ?? token.probabilityRug,
      smartWalletCount: token.smartWalletCount,
      smartWalletNetFlow: token.smartWalletNetFlow,
      insiderConcentration: token.insiderConcentration,
      devScore: token.devScore,
      avgWalletWinRate,
      avgWalletConfidence
    };
  });
}
