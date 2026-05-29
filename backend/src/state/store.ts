import type { AlertEvent, TokenState, WalletProfile } from "../types.js";
import { scoreToken } from "../scoring/rules.js";

const tokens = new Map<string, TokenState>();
const wallets = new Map<string, WalletProfile>();
const alerts: AlertEvent[] = [];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomMint(): string {
  return `PUMP${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function randomWallet(): string {
  return `WALLET_${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
}

export function seedWalletProfiles(count = 25): void {
  const categories: WalletProfile["category"][] = ["elite_early", "continuation", "scalper", "insider", "unknown"];
  for (let i = 0; i < count; i += 1) {
    const wallet = randomWallet();
    wallets.set(wallet, {
      wallet,
      winRate: randomInt(20, 85),
      avgReturnMultiple: Number((Math.random() * 6).toFixed(2)),
      confidence: randomInt(20, 90),
      category: categories[randomInt(0, categories.length - 1)],
      avgEntryMc: randomInt(2_000, 12_000),
      avgExitMc: randomInt(4_000, 30_000),
      avgHoldMinutes: randomInt(2, 45),
      migrationSuccessRate: Number((Math.random() * 0.8).toFixed(3)),
      rugExposureRate: Number((Math.random() * 0.5).toFixed(3)),
      totalTrades: randomInt(3, 100),
      realizedPnl: Number((Math.random() * 400 - 100).toFixed(2))
    });
  }
}

export function launchToken(): TokenState {
  const mint = randomMint();
  const token: TokenState = {
    mint,
    name: `Token ${mint.slice(0, 6)}`,
    symbol: mint.slice(0, 6),
    devWallet: randomWallet(),
    createdAt: new Date().toISOString(),
    marketCap: randomInt(2000, 12000),
    athMarketCap: 0,
    holderCount: randomInt(5, 20),
    buyCount: 0,
    sellCount: 0,
    volume: 0,
    smartWalletCount: randomInt(0, 2),
    smartWalletNetFlow: 0,
    devScore: randomInt(10, 85),
    insiderConcentration: Number((Math.random() * 0.45).toFixed(3)),
    probabilityContinuation: 50,
    probabilityMigration: 30,
    probabilityRug: 25,
    probabilityHit25kBefore10k: 40,
    probabilityHit100kBefore25k: 25,
    probabilityHit30kBefore10k: 45,
    probabilityLocalTop: 35,
    probabilityLocalTopWithinNMinutes: 30,
    score: 0,
    lifecycle: "new",
    entryScore: 0,
    entrySignal: "avoid",
    exitSignal: "accumulate",
    earlyUniqueBuyers: 0,
    earlyNetSol: 0,
    peakAt: new Date().toISOString(),
    lastTradeAt: new Date().toISOString()
  };

  const scored = scoreToken(token);
  scored.athMarketCap = scored.marketCap;
  tokens.set(scored.mint, scored);
  maybeGenerateAlert(scored, "launch");
  return scored;
}

export function processTrade(mint: string): TokenState | null {
  const token = tokens.get(mint);
  if (!token) return null;

  const isBuy = Math.random() > 0.43;
  const delta = randomInt(100, 2500);
  token.volume += delta;
  token.holderCount += isBuy ? randomInt(0, 3) : randomInt(-1, 1);
  token.holderCount = Math.max(1, token.holderCount);
  token.buyCount += isBuy ? 1 : 0;
  token.sellCount += isBuy ? 0 : 1;
  token.smartWalletNetFlow += isBuy ? Number((Math.random() * 0.8).toFixed(2)) : -Number((Math.random() * 0.8).toFixed(2));
  token.smartWalletCount = Math.max(0, token.smartWalletCount + (Math.random() > 0.75 ? (isBuy ? 1 : -1) : 0));
  token.insiderConcentration = Math.max(0, Math.min(1, token.insiderConcentration + (Math.random() - 0.48) * 0.02));
  token.marketCap = Math.max(1000, token.marketCap + (isBuy ? delta : -delta * 0.7));
  token.athMarketCap = Math.max(token.athMarketCap, token.marketCap);

  const scored = scoreToken(token);
  tokens.set(mint, scored);
  maybeGenerateAlert(scored, "trade");
  return scored;
}

function maybeGenerateAlert(token: TokenState, source: "launch" | "trade"): void {
  if (source === "launch" && token.devScore > 70) {
    alerts.unshift({
      id: `${token.mint}:${Date.now()}:good-dev`,
      tokenMint: token.mint,
      severity: "info",
      type: "good_dev_launch",
      message: `Good dev launched ${token.symbol} (score ${token.devScore})`,
      createdAt: new Date().toISOString()
    });
  }
  if (token.insiderConcentration > 0.35) {
    alerts.unshift({
      id: `${token.mint}:${Date.now()}:insider`,
      tokenMint: token.mint,
      severity: "warning",
      type: "insider_concentration",
      message: `Insider concentration rising on ${token.symbol}`,
      createdAt: new Date().toISOString()
    });
  }
  if (token.probabilityContinuation < 35) {
    alerts.unshift({
      id: `${token.mint}:${Date.now()}:continuation`,
      tokenMint: token.mint,
      severity: "critical",
      type: "continuation_drop",
      message: `Continuation probability dropped on ${token.symbol}`,
      createdAt: new Date().toISOString()
    });
  }

  if (alerts.length > 100) alerts.length = 100;
}

export function listTokens(): TokenState[] {
  return [...tokens.values()].sort((a, b) => b.marketCap - a.marketCap);
}

export function listAlerts(): AlertEvent[] {
  return alerts.slice(0, 30);
}

export function currentMints(): string[] {
  return [...tokens.keys()];
}
