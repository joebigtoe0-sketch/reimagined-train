export type TokenState = {
  mint: string;
  name: string;
  symbol: string;
  devWallet?: string;
  createdAt: string;
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
  lifecycle: "new" | "accumulation" | "distribution" | "failed" | "migrated" | "dead";
  entryScore?: number;
  entrySignal?: "strong" | "moderate" | "weak" | "avoid";
  exitSignal?: "accumulate" | "hold" | "take_profit" | "exit" | "dead";
  action?: "BUY" | "WATCH" | "HOLD" | "TRIM" | "EXIT" | "DEAD" | "AVOID";
  earlyUniqueBuyers?: number;
  earlyNetSol?: number;
  peakAt?: string;
  lastTradeAt?: string;
  smartMoneyBuys?: number;
  playbookScore?: number;
  playbookBuy?: boolean;
  playbookEntryMc?: number;
};

export type PaperPosition = {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  riding: boolean;
  solIn: number;
  value: number;
  pnlPct: number;
  entryAt: string;
};

export type PaperTrade = {
  mint: string;
  symbol: string;
  solIn: number;
  solOut: number;
  pnl: number;
  pnlPct: number;
  entryMc: number;
  exitMc: number;
  reason: string;
  entryAt?: string;
  exitAt: string;
};

export type PaperLifetime = {
  trades: number;
  wins: number;
  realizedPnl: number;
  bestPnl: number;
  worstPnl: number;
};

export type PaperState = {
  enabled: boolean;
  startingBalance: number;
  betSize: number;
  cash: number;
  openValue: number;
  equity: number;
  realizedPnl: number;
  totalReturnPct: number;
  openCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  positions: PaperPosition[];
  trades: PaperTrade[];
};

export type LivePosition = {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  riding: boolean;
  solIn: number;
  value: number;
  pnlPct: number;
  entryAt: string;
  txBuy?: string;
};

export type LiveTrade = {
  mint: string;
  symbol: string;
  solIn: number;
  solOut: number;
  pnl: number;
  pnlPct: number;
  entryMc: number;
  exitMc: number;
  reason: string;
  entryAt: string;
  exitAt: string;
  txBuy?: string;
  txSell?: string;
};

export type LiveState = {
  available: boolean;
  armed: boolean;
  walletPublicKey: string;
  betSize: number;
  maxOpen: number;
  dailyPnl: number;
  dailyLossLimit: number;
  openCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  positions: LivePosition[];
  trades: LiveTrade[];
};

export type BundleSuspect = {
  mint: string;
  symbol: string;
  detectedAt: string;
  detectionMc: number;
  currentMc: number;
  /** All wallets that made ≥7 SOL buy (behavioral gate — any wallet) */
  gangWallets: string[];
  gangWalletCount: number;
  /** How many of those whale buyers are also in the known gang list */
  knownGangCount: number;
  totalBuys: number;
  totalSells: number;
  buyToSellRatio: number;
  largestBuySol: number;
  hasSocial: boolean;
  score: number;
};

export type BundleState = {
  suspects: BundleSuspect[];
  gangWalletCount: number;
  totalDetected: number;
};

export type BundleLivePosition = {
  mint: string;
  symbol: string;
  entryMc: number;
  currentMc: number;
  peakMc: number;
  solIn: number;
  value: number;
  pnlPct: number;
  entryAt: string;
  txBuy?: string;
};

export type BundleLiveTrade = {
  mint: string;
  symbol: string;
  solIn: number;
  solOut: number;
  pnl: number;
  pnlPct: number;
  entryMc: number;
  exitMc: number;
  reason: string;
  entryAt: string;
  exitAt: string;
  txBuy?: string;
  txSell?: string;
};

export type BundleLiveState = {
  available: boolean;
  armed: boolean;
  betSize: number;
  openCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  dailyPnl: number;
  positions: BundleLivePosition[];
  trades: BundleLiveTrade[];
};

export type DeveloperStat = {
  devWallet: string;
  tokens: number;
  migrated: number;
  hits25k: number;
  rugged: number;
  avgAth: number;
  bestAth: number;
  lastLaunch: string;
  reputation: number;
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

export type WalletProfile = {
  wallet: string;
  winRate: number;
  avgReturnMultiple: number;
  confidence: number;
  category: "elite_early" | "continuation" | "scalper" | "sniper" | "distribution" | "insider" | "bad" | "unknown";
  avgEntryMc: number;
  avgExitMc: number;
  avgHoldMinutes: number;
  migrationSuccessRate: number;
  rugExposureRate: number;
  totalTrades: number;
  realizedPnl: number;
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
