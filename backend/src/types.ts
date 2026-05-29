export type TradeSide = "buy" | "sell";
export type EventType = "launch" | "trade" | "transfer" | "migration" | "liquidity" | "funding";
export type WalletCategory =
  | "elite_early"
  | "continuation"
  | "scalper"
  | "sniper"
  | "distribution"
  | "insider"
  | "bad"
  | "unknown";

export interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  devWallet: string;
  createdAt: string;
  marketCap: number;
  athMarketCap: number;
  holderCount: number;
  buyCount: number;
  sellCount: number;
  volume: number;
  smartWalletCount: number;
  smartWalletNetFlow: number;
  devScore: number;
  insiderConcentration: number;
  probabilityContinuation: number;
  probabilityMigration: number;
  probabilityRug: number;
  probabilityHit25kBefore10k: number;
  probabilityHit100kBefore25k: number;
  probabilityHit30kBefore10k: number;
  probabilityLocalTop: number;
  probabilityLocalTopWithinNMinutes: number;
  score: number;
  lifecycle: "new" | "accumulation" | "distribution" | "failed" | "migrated" | "dead";
  // Entry/exit intelligence (provisional, learned from early-window patterns).
  entryScore: number; // 0-100: likelihood this is an early runner
  entrySignal: "strong" | "moderate" | "weak" | "avoid";
  exitSignal: "accumulate" | "hold" | "take_profit" | "exit" | "dead";
  action: "BUY" | "WATCH" | "HOLD" | "TRIM" | "EXIT" | "DEAD" | "AVOID"; // headline call
  earlyUniqueBuyers: number; // unique buyers in first 5 min
  earlyNetSol: number; // net SOL inflow in first 5 min
  peakAt: string; // timestamp of the all-time-high market cap
  lastTradeAt: string; // timestamp of the most recent observed trade
  smartMoneyBuys: number; // distinct proven-predictive ("alpha") wallets that bought
}

export interface WalletProfile {
  wallet: string;
  winRate: number;
  avgReturnMultiple: number;
  confidence: number;
  category: WalletCategory;
  avgEntryMc: number;
  avgExitMc: number;
  avgHoldMinutes: number;
  migrationSuccessRate: number;
  rugExposureRate: number;
  totalTrades: number;
  realizedPnl: number;
}

export interface AlertEvent {
  id: string;
  tokenMint: string;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  createdAt: string;
}

export interface CanonicalEvent {
  id: string;
  source: "helius";
  type: EventType;
  mint: string;
  wallet: string;
  timestamp: string;
  signature: string;
  marketCap: number;
  amountSol: number;
  tokenAmount?: number;
  side?: TradeSide;
  participants?: string[];
  mints?: string[];
  devWallet?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface DeveloperProfile {
  devWallet: string;
  totalLaunches: number;
  migrationCount: number;
  rugCount: number;
  averageAth: number;
  averageLifespanMinutes: number;
  averageHolderGrowth: number;
  repeatBuyerOverlap: number;
  devSellRate: number;
  insiderFlags: number;
  score: number;
}

export interface ProbabilityRecord {
  mint: string;
  timestamp: string;
  continuation: number;
  migration: number;
  rug: number;
  hit25kBefore10k: number;
  hit100kBefore25k: number;
  hit30kBefore10k: number;
  localTop: number;
  localTopWithinNMinutes: number;
  score: number;
}

export interface AlertRule {
  id: number;
  name: string;
  enabled: boolean;
  severity: "info" | "warning" | "critical";
  config: Record<string, number | string | boolean>;
  cooldownSeconds: number;
  updatedAt: string;
}
