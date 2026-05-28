export type TokenState = {
  mint: string;
  name: string;
  symbol: string;
  marketCap: number;
  athMarketCap?: number;
  holderCount: number;
  buyCount: number;
  sellCount: number;
  volume?: number;
  smartWalletCount: number;
  smartWalletNetFlow: number;
  probabilityContinuation: number;
  probabilityMigration: number;
  probabilityRug: number;
  probabilityHit30kBefore10k: number;
  probabilityHit25kBefore10k?: number;
  probabilityHit100kBefore25k?: number;
  probabilityLocalTop: number;
  probabilityLocalTopWithinNMinutes?: number;
  devScore: number;
  insiderConcentration?: number;
  score?: number;
  lifecycle: "new" | "accumulation" | "distribution" | "failed" | "migrated";
};

export type AlertEvent = {
  id: string;
  tokenMint: string;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  createdAt: string;
};

export type ProbabilityRecord = {
  mint: string;
  timestamp: string;
  continuation: number;
  migration: number;
  rug: number;
  hit30kBefore10k: number;
  localTop: number;
  score: number;
};

export type CalibrationReport = {
  sampleSize: number;
  brierScore: number;
  precision: number;
  recall: number;
  driftDelta: number;
};

export type AlertRule = {
  id: number;
  name: string;
  enabled: boolean;
  severity: "info" | "warning" | "critical";
  config: Record<string, number | string | boolean>;
  cooldownSeconds: number;
  updatedAt: string;
};
