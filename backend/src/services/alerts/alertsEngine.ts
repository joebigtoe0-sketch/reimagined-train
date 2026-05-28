import type { AlertEvent, TokenState } from "../../types.js";

export interface AlertRuleConfig {
  continuationFloor: number;
  insiderThreshold: number;
  localTopThreshold: number;
}

const defaultConfig: AlertRuleConfig = {
  continuationFloor: 38,
  insiderThreshold: 0.35,
  localTopThreshold: 70
};

export function evaluateAlerts(token: TokenState, config: AlertRuleConfig = defaultConfig): AlertEvent[] {
  const now = new Date().toISOString();
  const alerts: AlertEvent[] = [];

  if (token.devScore >= 70 && token.marketCap <= 12_000) {
    alerts.push({
      id: `${token.mint}:${now}:good-dev`,
      tokenMint: token.mint,
      severity: "info",
      type: "good_dev_launch",
      message: `Good dev score on ${token.symbol} (${token.devScore})`,
      createdAt: now
    });
  }

  if (token.insiderConcentration >= config.insiderThreshold) {
    alerts.push({
      id: `${token.mint}:${now}:insider`,
      tokenMint: token.mint,
      severity: "warning",
      type: "insider_concentration",
      message: `Insider concentration rising on ${token.symbol}`,
      createdAt: now
    });
  }

  if (token.probabilityContinuation <= config.continuationFloor) {
    alerts.push({
      id: `${token.mint}:${now}:continuation-drop`,
      tokenMint: token.mint,
      severity: "critical",
      type: "continuation_drop",
      message: `Continuation probability dropped on ${token.symbol}`,
      createdAt: now
    });
  }

  if (token.probabilityLocalTop >= config.localTopThreshold) {
    alerts.push({
      id: `${token.mint}:${now}:local-top`,
      tokenMint: token.mint,
      severity: "warning",
      type: "local_top_risk",
      message: `${token.symbol} may be near local top`,
      createdAt: now
    });
  }

  return alerts;
}
