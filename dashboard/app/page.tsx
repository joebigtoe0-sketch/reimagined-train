"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { AlertEvent, AlertRule, CalibrationReport, ProbabilityRecord, TokenState } from "../lib/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";
const WS_BASE = API_BASE.startsWith("https://")
  ? API_BASE.replace("https://", "wss://")
  : API_BASE.replace("http://", "ws://");

interface CoverageSnapshot {
  trackedWallets: number;
  trackedMints: number;
  globalAddresses: number;
  signaturesSeen: number;
  knownTokens: number;
  knownWallets: number;
  knownDevelopers: number;
  lastPollAt?: string;
  lastEventCount: number;
  queue?: { queued: number; deadLetters: number; seenIds: number };
}

export default function Home(): ReactElement {
  const [tokens, setTokens] = useState<TokenState[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [probabilities, setProbabilities] = useState<ProbabilityRecord[]>([]);
  const [report, setReport] = useState<CalibrationReport>({ sampleSize: 0, brierScore: 0, precision: 0, recall: 0, driftDelta: 0 });
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [coverage, setCoverage] = useState<CoverageSnapshot | null>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      const [tokenRes, alertRes, probRes, reportRes, rulesRes, coverageRes] = await Promise.all([
        fetch(`${API_BASE}/api/tokens`),
        fetch(`${API_BASE}/api/alerts`),
        fetch(`${API_BASE}/api/probabilities`),
        fetch(`${API_BASE}/api/backtest/calibration`),
        fetch(`${API_BASE}/api/alerts/rules`),
        fetch(`${API_BASE}/api/ops/coverage`)
      ]);
      const tokenJson = await tokenRes.json();
      const alertJson = await alertRes.json();
      const probJson = await probRes.json();
      const reportJson = await reportRes.json();
      const rulesJson = await rulesRes.json();
      const coverageJson = await coverageRes.json();
      setTokens(tokenJson.tokens);
      setAlerts(alertJson.alerts);
      setProbabilities(probJson.probabilities ?? []);
      setReport(reportJson.report);
      setRules(rulesJson.rules ?? []);
      setCoverage(coverageJson.coverage ?? null);
    };

    void load();
    const refresh = setInterval(() => void load(), 8000);

    const ws = new WebSocket(`${WS_BASE}/ws`);
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as { type: string; payload?: TokenState; alerts?: AlertEvent[]; tokens?: TokenState[]; probabilities?: ProbabilityRecord[] };
      if (parsed.type === "bootstrap") {
        if (parsed.tokens) setTokens(parsed.tokens);
        if (parsed.alerts) setAlerts(parsed.alerts);
        if (parsed.probabilities) setProbabilities(parsed.probabilities);
        return;
      }
      if (parsed.type === "tokenUpdate" || parsed.type === "tokenLaunch") {
        const token = parsed.payload;
        if (!token) return;
        setTokens((prev) => {
          const next = prev.filter((t) => t.mint !== token.mint);
          next.push(token);
          return next.sort((a, b) => b.marketCap - a.marketCap).slice(0, 50);
        });
        setProbabilities((prev) => {
          const row: ProbabilityRecord = {
            mint: token.mint,
            timestamp: new Date().toISOString(),
            continuation: token.probabilityContinuation,
            migration: token.probabilityMigration,
            rug: token.probabilityRug,
            hit30kBefore10k: token.probabilityHit30kBefore10k,
            localTop: token.probabilityLocalTop,
            score: token.probabilityContinuation - token.probabilityRug
          };
          return [row, ...prev].slice(0, 80);
        });
      }
    };

    return () => {
      clearInterval(refresh);
      ws.close();
    };
  }, []);

  const strongest = useMemo(
    () => tokens.filter((t) => t.probabilityContinuation >= 65).length,
    [tokens]
  );

  return (
    <main className="wrap">
      <h1>Pump.fun Probability MVP</h1>
      <p>Tracked tokens: {tokens.length} | High continuation setups: {strongest}</p>
      <p>
        Backtest sample: {report.sampleSize} | Brier: {report.brierScore} | Precision: {report.precision} | Recall: {report.recall} | Drift: {report.driftDelta}
      </p>
      {coverage && (
        <p>
          Coverage: tokens {coverage.knownTokens} | wallets {coverage.knownWallets} | devs {coverage.knownDevelopers} | tracked mints {coverage.trackedMints} | tracked wallets {coverage.trackedWallets} | program addrs {coverage.globalAddresses} | sigs seen {coverage.signaturesSeen}
          {coverage.lastPollAt ? ` | last poll ${new Date(coverage.lastPollAt).toLocaleTimeString()} (+${coverage.lastEventCount})` : ""}
        </p>
      )}
      <div className="grid">
        <section className="card">
          <h2>Live Tokens</h2>
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>MC</th>
                <th>Holders</th>
                <th>Smart Wallets</th>
                <th>Net Flow</th>
                <th>P(Continue)</th>
                <th>P(Migrate)</th>
                <th>P(Rug)</th>
                <th>P(30k&gt;10k)</th>
                <th>P(LocalTop)</th>
                <th>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {tokens.slice(0, 25).map((token) => (
                <tr key={token.mint}>
                  <td>{token.symbol}</td>
                  <td>${Math.round(token.marketCap).toLocaleString()}</td>
                  <td>{token.holderCount}</td>
                  <td>{token.smartWalletCount}</td>
                  <td>{token.smartWalletNetFlow.toFixed(2)}</td>
                  <td>{token.probabilityContinuation}%</td>
                  <td>{token.probabilityMigration}%</td>
                  <td>{token.probabilityRug}%</td>
                  <td>{token.probabilityHit30kBefore10k}%</td>
                  <td>{token.probabilityLocalTop}%</td>
                  <td>{token.lifecycle}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="card">
          <h2>Recent Alerts</h2>
          {alerts.slice(0, 12).map((alert, idx) => (
            <p key={`${alert.id}-${idx}`}>
              <strong>[{alert.severity.toUpperCase()}]</strong> {alert.message}
            </p>
          ))}
          <h3>Recent Probability Samples</h3>
          {probabilities.slice(0, 6).map((row) => (
            <p key={`${row.mint}-${row.timestamp}`}>
              {row.mint.slice(0, 6)} C:{row.continuation}% M:{row.migration}% R:{row.rug}%
            </p>
          ))}
          <h3>Alert Rules</h3>
          {rules.slice(0, 6).map((rule) => (
            <p key={rule.id}>
              {rule.enabled ? "ON" : "OFF"} {rule.name} ({rule.severity}) cd:{rule.cooldownSeconds}s
            </p>
          ))}
        </aside>
      </div>
    </main>
  );
}
