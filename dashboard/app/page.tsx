"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

function CopyButton({ value }: { value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button
      onClick={copy}
      title={value}
      style={{
        background: copied ? "#1a7a4a" : "#1e293b",
        border: "1px solid #334155",
        borderRadius: 4,
        color: copied ? "#4ade80" : "#94a3b8",
        cursor: "pointer",
        fontFamily: "monospace",
        fontSize: 11,
        padding: "2px 6px",
        transition: "all 0.15s"
      }}
    >
      {copied ? "✓ copied" : `${value.slice(0, 4)}…${value.slice(-4)}`}
    </button>
  );
}

function lifecycleBadge(lc: string): ReactElement {
  const colors: Record<string, string> = {
    new: "#3b82f6",
    accumulation: "#10b981",
    distribution: "#f59e0b",
    failed: "#ef4444",
    migrated: "#8b5cf6"
  };
  return (
    <span style={{
      background: colors[lc] ?? "#64748b",
      borderRadius: 4,
      color: "#fff",
      fontSize: 10,
      fontWeight: 700,
      padding: "1px 6px",
      textTransform: "uppercase"
    }}>
      {lc}
    </span>
  );
}

function pctColor(pct: number): string {
  if (pct >= 70) return "#4ade80";
  if (pct >= 50) return "#facc15";
  return "#f87171";
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
      try {
        const [tokenRes, alertRes, probRes, reportRes, rulesRes, coverageRes] = await Promise.all([
          fetch(`${API_BASE}/api/tokens`),
          fetch(`${API_BASE}/api/alerts`),
          fetch(`${API_BASE}/api/probabilities`),
          fetch(`${API_BASE}/api/backtest/calibration`),
          fetch(`${API_BASE}/api/alerts/rules`),
          fetch(`${API_BASE}/api/ops/coverage`)
        ]);
        const tokenJson = await tokenRes.json() as { tokens: TokenState[] };
        const alertJson = await alertRes.json() as { alerts: AlertEvent[] };
        const probJson = await probRes.json() as { probabilities?: ProbabilityRecord[] };
        const reportJson = await reportRes.json() as { report: CalibrationReport };
        const rulesJson = await rulesRes.json() as { rules?: AlertRule[] };
        const coverageJson = await coverageRes.json() as { coverage?: CoverageSnapshot };
        if (tokenJson.tokens) setTokens(tokenJson.tokens);
        if (alertJson.alerts) setAlerts(alertJson.alerts);
        setProbabilities(probJson.probabilities ?? []);
        if (reportJson.report) setReport(reportJson.report);
        setRules(rulesJson.rules ?? []);
        setCoverage(coverageJson.coverage ?? null);
      } catch {
        // backend may be restarting
      }
    };

    void load();
    const refresh = setInterval(() => void load(), 8000);

    const ws = new WebSocket(`${WS_BASE}/ws`);
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data as string) as {
        type: string;
        payload?: TokenState;
        alerts?: AlertEvent[];
        tokens?: TokenState[];
        probabilities?: ProbabilityRecord[];
      };
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
          return next.sort((a, b) => b.marketCap - a.marketCap).slice(0, 100);
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
          return [row, ...prev].slice(0, 200);
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
    <main style={{ background: "#0f172a", color: "#e2e8f0", fontFamily: "Inter, system-ui, sans-serif", minHeight: "100vh", padding: "20px 24px" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #1e293b", marginBottom: 20, paddingBottom: 16 }}>
        <h1 style={{ color: "#f8fafc", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Pump.fun Intelligence
        </h1>
        <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>
          {tokens.length} tokens tracked · {strongest} high-continuation setups
          {coverage && (
            <> · {coverage.knownWallets.toLocaleString()} wallets · {coverage.trackedMints.toLocaleString()} mints · sigs seen {coverage.signaturesSeen.toLocaleString()}
              {coverage.lastPollAt ? ` · last poll ${new Date(coverage.lastPollAt).toLocaleTimeString()} (+${coverage.lastEventCount})` : ""}
            </>
          )}
        </div>
        <div style={{ color: "#475569", fontSize: 12, marginTop: 4 }}>
          Backtest sample {report.sampleSize} · Brier {report.brierScore} · Precision {report.precision} · Recall {report.recall} · Drift {report.driftDelta}
        </div>
      </div>

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "1fr 340px" }}>
        {/* Tokens table */}
        <section>
          <h2 style={{ color: "#94a3b8", fontSize: 13, fontWeight: 600, letterSpacing: "0.05em", marginBottom: 12, textTransform: "uppercase" }}>
            Live Tokens
          </h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1e293b", color: "#475569", fontSize: 11, textAlign: "left" }}>
                  <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Token</th>
                  <th style={{ padding: "6px 10px" }}>Contract</th>
                  <th style={{ padding: "6px 10px" }}>MC</th>
                  <th style={{ padding: "6px 10px" }}>Holders</th>
                  <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>B/S</th>
                  <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Smart $</th>
                  <th style={{ padding: "6px 10px" }}>P(↑)</th>
                  <th style={{ padding: "6px 10px" }}>P(→)</th>
                  <th style={{ padding: "6px 10px" }}>P(✗)</th>
                  <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>P(30k)</th>
                  <th style={{ padding: "6px 10px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {tokens.slice(0, 40).map((token) => (
                  <tr
                    key={token.mint}
                    style={{ borderBottom: "1px solid #1e293b", transition: "background 0.2s" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#1e293b"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ""; }}
                  >
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                      <div style={{ color: "#f1f5f9", fontWeight: 600 }}>{token.name || token.symbol}</div>
                      <div style={{ color: "#64748b", fontSize: 11 }}>{token.symbol}</div>
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <CopyButton value={token.mint} />
                    </td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                      ${token.marketCap >= 1_000_000
                        ? `${(token.marketCap / 1_000_000).toFixed(2)}M`
                        : token.marketCap >= 1_000
                        ? `${Math.round(token.marketCap / 1_000)}k`
                        : Math.round(token.marketCap).toLocaleString()}
                    </td>
                    <td style={{ padding: "7px 10px" }}>{token.holderCount}</td>
                    <td style={{ padding: "7px 10px", color: "#94a3b8", fontSize: 12 }}>
                      <span style={{ color: "#4ade80" }}>B</span>
                      {token.buyCount ?? 0}{" / "}
                      <span style={{ color: "#f87171" }}>S</span>
                      {token.sellCount ?? 0}
                    </td>
                    <td style={{ padding: "7px 10px" }}>{token.smartWalletCount}</td>
                    <td style={{ color: pctColor(token.probabilityContinuation), fontWeight: 600, padding: "7px 10px" }}>
                      {token.probabilityContinuation}%
                    </td>
                    <td style={{ color: pctColor(token.probabilityMigration), padding: "7px 10px" }}>
                      {token.probabilityMigration}%
                    </td>
                    <td style={{ color: token.probabilityRug >= 50 ? "#f87171" : "#94a3b8", padding: "7px 10px" }}>
                      {token.probabilityRug}%
                    </td>
                    <td style={{ color: pctColor(token.probabilityHit30kBefore10k), padding: "7px 10px" }}>
                      {token.probabilityHit30kBefore10k}%
                    </td>
                    <td style={{ padding: "7px 10px" }}>{lifecycleBadge(token.lifecycle)}</td>
                  </tr>
                ))}
                {tokens.length === 0 && (
                  <tr>
                    <td colSpan={11} style={{ color: "#475569", padding: "24px 10px", textAlign: "center" }}>
                      Waiting for Pump.fun events…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Sidebar */}
        <aside style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Alerts */}
          <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: 16 }}>
            <h3 style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", margin: "0 0 12px", textTransform: "uppercase" }}>
              Recent Alerts
            </h3>
            {alerts.length === 0 && <div style={{ color: "#475569", fontSize: 13 }}>No alerts yet</div>}
            {alerts.slice(0, 10).map((alert, idx) => (
              <div key={`${alert.id}-${idx}`} style={{ borderBottom: "1px solid #1e293b", fontSize: 12, marginBottom: 8, paddingBottom: 8 }}>
                <span style={{
                  background: alert.severity === "critical" ? "#7f1d1d" : alert.severity === "warning" ? "#713f12" : "#1e3a5f",
                  borderRadius: 3,
                  color: alert.severity === "critical" ? "#fca5a5" : alert.severity === "warning" ? "#fcd34d" : "#93c5fd",
                  fontSize: 10,
                  fontWeight: 700,
                  marginRight: 6,
                  padding: "1px 5px"
                }}>
                  {alert.severity.toUpperCase()}
                </span>
                {alert.message}
              </div>
            ))}
          </div>

          {/* Recent probability samples */}
          <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: 16 }}>
            <h3 style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", margin: "0 0 12px", textTransform: "uppercase" }}>
              Latest Probabilities
            </h3>
            {probabilities.length === 0 && <div style={{ color: "#475569", fontSize: 13 }}>No data yet</div>}
            {probabilities.slice(0, 8).map((row, i) => (
              <div key={`${row.mint}-${i}`} style={{ borderBottom: "1px solid #1e293b", display: "flex", fontSize: 12, gap: 8, marginBottom: 6, paddingBottom: 6 }}>
                <span style={{ color: "#64748b", fontFamily: "monospace" }}>{row.mint.slice(0, 6)}</span>
                <span style={{ color: pctColor(row.continuation) }}>C:{row.continuation}%</span>
                <span>M:{row.migration}%</span>
                <span style={{ color: row.rug >= 50 ? "#f87171" : "#64748b" }}>R:{row.rug}%</span>
              </div>
            ))}
          </div>

          {/* Alert rules */}
          <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: 16 }}>
            <h3 style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", margin: "0 0 12px", textTransform: "uppercase" }}>
              Alert Rules
            </h3>
            {rules.slice(0, 6).map((rule) => (
              <div key={rule.id} style={{ alignItems: "center", display: "flex", fontSize: 12, gap: 8, marginBottom: 6 }}>
                <span style={{ color: rule.enabled ? "#4ade80" : "#ef4444", fontSize: 10 }}>●</span>
                <span style={{ color: "#cbd5e1", flex: 1 }}>{rule.name}</span>
                <span style={{ color: "#475569" }}>cd:{rule.cooldownSeconds}s</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
