"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { AlertEvent, AlertRule, CalibrationReport, ProbabilityRecord, TokenState, WalletProfile } from "../lib/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";
const WS_BASE = API_BASE.startsWith("https://")
  ? API_BASE.replace("https://", "wss://")
  : API_BASE.replace("http://", "ws://");

// ─── tiny design tokens ────────────────────────────────────────────────────
const C = {
  bg: "#0f172a", surface: "#111827", border: "#1e293b",
  text: "#e2e8f0", muted: "#64748b", faint: "#334155",
  green: "#4ade80", yellow: "#facc15", red: "#f87171",
  blue: "#60a5fa", purple: "#a78bfa",
} as const;

// ─── helpers ───────────────────────────────────────────────────────────────
function pctColor(n: number): string {
  return n >= 70 ? C.green : n >= 50 ? C.yellow : C.red;
}
function fmtMc(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}
function fmtSol(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)} SOL`;
}
function fmtMins(m: number): string {
  if (m >= 60) return `${(m / 60).toFixed(1)}h`;
  return `${Math.round(m)}m`;
}
function fmtAge(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ─── shared components ─────────────────────────────────────────────────────
function CopyButton({ value }: { value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button onClick={copy} title={value} style={{
      background: copied ? "#14532d" : C.surface,
      border: `1px solid ${C.border}`, borderRadius: 4,
      color: copied ? C.green : C.muted, cursor: "pointer",
      fontFamily: "monospace", fontSize: 11, padding: "2px 7px", transition: "all .15s",
    }}>
      {copied ? "✓ copied" : `${value.slice(0, 4)}…${value.slice(-4)}`}
    </button>
  );
}

function Badge({ label, color }: { label: string; color: string }): ReactElement {
  return (
    <span style={{
      background: color + "22", border: `1px solid ${color}44`,
      borderRadius: 4, color, fontSize: 10, fontWeight: 700,
      padding: "1px 6px", textTransform: "uppercase" as const,
    }}>{label}</span>
  );
}

function lifecycleBadge(lc: string): ReactElement {
  const map: Record<string, string> = {
    new: C.blue, accumulation: C.green, distribution: C.yellow, failed: C.red, migrated: C.purple
  };
  return <Badge label={lc} color={map[lc] ?? C.muted} />;
}

const categoryColor: Record<string, string> = {
  elite_early: C.green, continuation: C.blue, scalper: C.yellow,
  sniper: C.purple, distribution: C.yellow, insider: C.red, bad: C.red, unknown: C.muted,
};

function Th({ children, onClick, active, asc }: { children: React.ReactNode; onClick?: () => void; active?: boolean; asc?: boolean }): ReactElement {
  return (
    <th onClick={onClick} style={{
      color: active ? C.text : C.muted, cursor: onClick ? "pointer" : "default",
      fontSize: 11, fontWeight: 600, padding: "6px 10px",
      textAlign: "left", userSelect: "none", whiteSpace: "nowrap",
    }}>
      {children}{active ? (asc ? " ▲" : " ▼") : ""}
    </th>
  );
}

// ─── coverage bar ──────────────────────────────────────────────────────────
interface CoverageSnapshot {
  trackedWallets: number; trackedMints: number; globalAddresses: number;
  signaturesSeen: number; knownTokens: number; knownWallets: number;
  knownDevelopers: number; lastPollAt?: string; lastEventCount: number;
}

// ─── token filters ─────────────────────────────────────────────────────────
type SortField = "createdAt" | "marketCap" | "holderCount" | "smartWalletCount" | "probabilityContinuation"
  | "probabilityMigration" | "probabilityRug" | "probabilityHit30kBefore10k"
  | "probabilityLocalTop" | "buyCount" | "sellCount" | "volume" | "score";

interface TokenFilters {
  minMc: string; maxMc: string;
  minContinue: string; minMigrate: string; maxRug: string;
  lifecycle: string; search: string;
}

function applyTokenFilters(tokens: TokenState[], f: TokenFilters, sort: SortField, asc: boolean): TokenState[] {
  let list = tokens.filter((t) => {
    if (f.search && !t.name.toLowerCase().includes(f.search.toLowerCase())
      && !t.symbol.toLowerCase().includes(f.search.toLowerCase())
      && !t.mint.toLowerCase().includes(f.search.toLowerCase())) return false;
    if (f.minMc && t.marketCap < Number(f.minMc)) return false;
    if (f.maxMc && t.marketCap > Number(f.maxMc)) return false;
    if (f.minContinue && t.probabilityContinuation < Number(f.minContinue)) return false;
    if (f.minMigrate && t.probabilityMigration < Number(f.minMigrate)) return false;
    if (f.maxRug && t.probabilityRug > Number(f.maxRug)) return false;
    if (f.lifecycle && f.lifecycle !== "all" && t.lifecycle !== f.lifecycle) return false;
    return true;
  });
  list = list.sort((a, b) => {
    if (sort === "createdAt") {
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      return asc ? at - bt : bt - at;
    }
    const av = (a[sort] as number) ?? 0;
    const bv = (b[sort] as number) ?? 0;
    return asc ? av - bv : bv - av;
  });
  return list;
}

// ─── wallet filters ─────────────────────────────────────────────────────────
type WalletSortField = "realizedPnl" | "winRate" | "avgReturnMultiple" | "totalTrades"
  | "avgEntryMc" | "avgExitMc" | "avgHoldMinutes" | "migrationSuccessRate" | "rugExposureRate";

interface WalletFilters { category: string; search: string; minTrades: string; }

function applyWalletFilters(wallets: WalletProfile[], f: WalletFilters, sort: WalletSortField, asc: boolean): WalletProfile[] {
  let list = wallets.filter((w) => {
    if (f.search && !w.wallet.toLowerCase().includes(f.search.toLowerCase())) return false;
    if (f.category && f.category !== "all" && w.category !== f.category) return false;
    if (f.minTrades && w.totalTrades < Number(f.minTrades)) return false;
    return true;
  });
  list = list.sort((a, b) => {
    const av = (a[sort] as number) ?? 0;
    const bv = (b[sort] as number) ?? 0;
    return asc ? av - bv : bv - av;
  });
  return list;
}

// ─── styled primitives ─────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  background: C.surface, border: `1px solid ${C.faint}`, borderRadius: 5,
  color: C.text, fontSize: 12, padding: "4px 8px", outline: "none",
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

// ═══════════════════════════════════════════════════════════════════════════
export default function Home(): ReactElement {
  const [tab, setTab] = useState<"tokens" | "wallets">("tokens");
  const [tokens, setTokens] = useState<TokenState[]>([]);
  const [wallets, setWallets] = useState<WalletProfile[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [probabilities, setProbabilities] = useState<ProbabilityRecord[]>([]);
  const [report, setReport] = useState<CalibrationReport>({ sampleSize: 0, brierScore: 0, precision: 0, recall: 0, driftDelta: 0 });
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [coverage, setCoverage] = useState<CoverageSnapshot | null>(null);

  // token table state
  const [tokenFilters, setTokenFilters] = useState<TokenFilters>({
    minMc: "", maxMc: "", minContinue: "", minMigrate: "", maxRug: "", lifecycle: "all", search: "",
  });
  const [tokenSort, setTokenSort] = useState<SortField>("createdAt");
  const [tokenAsc, setTokenAsc] = useState(false);

  // wallet table state
  const [walletFilters, setWalletFilters] = useState<WalletFilters>({ category: "all", search: "", minTrades: "" });
  const [walletSort, setWalletSort] = useState<WalletSortField>("realizedPnl");
  const [walletAsc, setWalletAsc] = useState(false);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const [tR, aR, pR, rR, ruR, cR, wR] = await Promise.all([
          fetch(`${API_BASE}/api/tokens`),
          fetch(`${API_BASE}/api/alerts`),
          fetch(`${API_BASE}/api/probabilities`),
          fetch(`${API_BASE}/api/backtest/calibration`),
          fetch(`${API_BASE}/api/alerts/rules`),
          fetch(`${API_BASE}/api/ops/coverage`),
          fetch(`${API_BASE}/api/wallets`),
        ]);
        const tj = await tR.json() as { tokens?: TokenState[] };
        const aj = await aR.json() as { alerts?: AlertEvent[] };
        const pj = await pR.json() as { probabilities?: ProbabilityRecord[] };
        const rj = await rR.json() as { report?: CalibrationReport };
        const ruj = await ruR.json() as { rules?: AlertRule[] };
        const cj = await cR.json() as { coverage?: CoverageSnapshot };
        const wj = await wR.json() as { wallets?: WalletProfile[] };
        if (tj.tokens) setTokens(tj.tokens);
        if (aj.alerts) setAlerts(aj.alerts);
        setProbabilities(pj.probabilities ?? []);
        if (rj.report) setReport(rj.report);
        setRules(ruj.rules ?? []);
        setCoverage(cj.coverage ?? null);
        if (wj.wallets) setWallets(wj.wallets);
      } catch { /* backend restarting */ }
    };
    void load();
    const iv = setInterval(() => void load(), 8000);

    const ws = new WebSocket(`${WS_BASE}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string; payload?: TokenState;
        tokens?: TokenState[]; alerts?: AlertEvent[]; probabilities?: ProbabilityRecord[];
      };
      if (msg.type === "bootstrap") {
        if (msg.tokens) setTokens(msg.tokens);
        if (msg.alerts) setAlerts(msg.alerts);
        if (msg.probabilities) setProbabilities(msg.probabilities);
        return;
      }
      if (msg.type === "tokenUpdate" || msg.type === "tokenLaunch") {
        const t = msg.payload; if (!t) return;
        setTokens((prev) => {
          const next = prev.filter((x) => x.mint !== t.mint);
          next.push(t);
          return next.sort((a, b) => b.marketCap - a.marketCap).slice(0, 200);
        });
      }
    };
    return () => { clearInterval(iv); ws.close(); };
  }, []);

  const filteredTokens = useMemo(
    () => applyTokenFilters(tokens, tokenFilters, tokenSort, tokenAsc),
    [tokens, tokenFilters, tokenSort, tokenAsc]
  );
  const filteredWallets = useMemo(
    () => applyWalletFilters(wallets, walletFilters, walletSort, walletAsc),
    [wallets, walletFilters, walletSort, walletAsc]
  );

  const toggleTokenSort = (f: SortField) => {
    if (tokenSort === f) setTokenAsc((v) => !v); else { setTokenSort(f); setTokenAsc(false); }
  };
  const toggleWalletSort = (f: WalletSortField) => {
    if (walletSort === f) setWalletAsc((v) => !v); else { setWalletSort(f); setWalletAsc(false); }
  };

  // ─── layout ──────────────────────────────────────────────────────────────
  return (
    <main style={{ background: C.bg, color: C.text, fontFamily: "Inter,system-ui,sans-serif", minHeight: "100vh", padding: "20px 24px" }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, marginBottom: 16, paddingBottom: 14 }}>
        <h1 style={{ color: "#f8fafc", fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>Pump.fun Intelligence</h1>
        <div style={{ color: C.muted, fontSize: 12 }}>
          {tokens.length} tokens · {wallets.length} wallets
          {coverage && (
            <> · {coverage.knownWallets.toLocaleString()} tracked wallets · {coverage.trackedMints.toLocaleString()} mints
              · sigs {coverage.signaturesSeen.toLocaleString()}
              {coverage.lastPollAt ? ` · polled ${new Date(coverage.lastPollAt).toLocaleTimeString()} (+${coverage.lastEventCount})` : ""}
            </>
          )}
          {" · "}backtest n={report.sampleSize} brier={report.brierScore}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(["tokens", "wallets"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? C.faint : "transparent",
            border: `1px solid ${tab === t ? C.border : "transparent"}`,
            borderRadius: 6, color: tab === t ? C.text : C.muted,
            cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "6px 18px",
            textTransform: "capitalize",
          }}>{t}</button>
        ))}
      </div>

      {/* ══ TOKENS TAB ══ */}
      {tab === "tokens" && (
        <div>
          {/* Filter bar */}
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            <input placeholder="Search name / ticker / CA…" value={tokenFilters.search}
              onChange={(e) => setTokenFilters((f) => ({ ...f, search: e.target.value }))}
              style={{ ...inputStyle, minWidth: 200 }} />
            <input placeholder="Min MC $" value={tokenFilters.minMc} type="number"
              onChange={(e) => setTokenFilters((f) => ({ ...f, minMc: e.target.value }))}
              style={{ ...inputStyle, width: 90 }} />
            <input placeholder="Max MC $" value={tokenFilters.maxMc} type="number"
              onChange={(e) => setTokenFilters((f) => ({ ...f, maxMc: e.target.value }))}
              style={{ ...inputStyle, width: 90 }} />
            <input placeholder="Min Continue %" value={tokenFilters.minContinue} type="number"
              onChange={(e) => setTokenFilters((f) => ({ ...f, minContinue: e.target.value }))}
              style={{ ...inputStyle, width: 110 }} />
            <input placeholder="Min Migrate %" value={tokenFilters.minMigrate} type="number"
              onChange={(e) => setTokenFilters((f) => ({ ...f, minMigrate: e.target.value }))}
              style={{ ...inputStyle, width: 110 }} />
            <input placeholder="Max Rug %" value={tokenFilters.maxRug} type="number"
              onChange={(e) => setTokenFilters((f) => ({ ...f, maxRug: e.target.value }))}
              style={{ ...inputStyle, width: 90 }} />
            <select value={tokenFilters.lifecycle}
              onChange={(e) => setTokenFilters((f) => ({ ...f, lifecycle: e.target.value }))}
              style={selectStyle}>
              {["all", "new", "accumulation", "distribution", "failed", "migrated"].map((v) => (
                <option key={v} value={v}>{v === "all" ? "All statuses" : v}</option>
              ))}
            </select>
            {(tokenFilters.search || tokenFilters.minMc || tokenFilters.maxMc || tokenFilters.minContinue || tokenFilters.minMigrate || tokenFilters.maxRug || tokenFilters.lifecycle !== "all") && (
              <button onClick={() => setTokenFilters({ minMc: "", maxMc: "", minContinue: "", minMigrate: "", maxRug: "", lifecycle: "all", search: "" })}
                style={{ ...inputStyle, color: C.red, cursor: "pointer" }}>✕ clear</button>
            )}
            <span style={{ color: C.muted, fontSize: 12, marginLeft: "auto" }}>{filteredTokens.length} shown</span>
          </div>

          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 300px" }}>
            {/* Token table */}
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                <thead style={{ borderBottom: `1px solid ${C.border}` }}>
                  <tr>
                    <Th onClick={() => toggleTokenSort("createdAt")} active={tokenSort === "createdAt"} asc={tokenAsc}>Launched</Th>
                    <Th>Token</Th>
                    <Th>Contract</Th>
                    <Th onClick={() => toggleTokenSort("marketCap")} active={tokenSort === "marketCap"} asc={tokenAsc}>MC</Th>
                    <Th onClick={() => toggleTokenSort("holderCount")} active={tokenSort === "holderCount"} asc={tokenAsc}>Holders</Th>
                    <Th onClick={() => toggleTokenSort("buyCount")} active={tokenSort === "buyCount"} asc={tokenAsc}>Buys</Th>
                    <Th onClick={() => toggleTokenSort("sellCount")} active={tokenSort === "sellCount"} asc={tokenAsc}>Sells</Th>
                    <Th onClick={() => toggleTokenSort("smartWalletCount")} active={tokenSort === "smartWalletCount"} asc={tokenAsc}>Smart$</Th>
                    <Th onClick={() => toggleTokenSort("probabilityContinuation")} active={tokenSort === "probabilityContinuation"} asc={tokenAsc}>P(↑)</Th>
                    <Th onClick={() => toggleTokenSort("probabilityMigration")} active={tokenSort === "probabilityMigration"} asc={tokenAsc}>P(→)</Th>
                    <Th onClick={() => toggleTokenSort("probabilityRug")} active={tokenSort === "probabilityRug"} asc={tokenAsc}>P(✗)</Th>
                    <Th onClick={() => toggleTokenSort("probabilityHit30kBefore10k")} active={tokenSort === "probabilityHit30kBefore10k"} asc={tokenAsc}>P(30k)</Th>
                    <Th onClick={() => toggleTokenSort("probabilityLocalTop")} active={tokenSort === "probabilityLocalTop"} asc={tokenAsc}>P(Top)</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTokens.slice(0, 60).map((token) => (
                    <tr key={token.mint} style={{ borderBottom: `1px solid ${C.border}` }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.surface; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                      <td style={{ color: C.muted, fontSize: 11, padding: "6px 10px", whiteSpace: "nowrap" }}>
                        {token.createdAt ? fmtAge(token.createdAt) : "—"}
                      </td>
                      <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                        <div style={{ color: "#f1f5f9", fontWeight: 600 }}>{token.name || token.symbol}</div>
                        <div style={{ color: C.muted, fontSize: 11 }}>{token.symbol}</div>
                      </td>
                      <td style={{ padding: "6px 10px" }}><CopyButton value={token.mint} /></td>
                      <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{fmtMc(token.marketCap)}</td>
                      <td style={{ padding: "6px 10px" }}>{token.holderCount}</td>
                      <td style={{ color: C.green, padding: "6px 10px" }}>{token.buyCount ?? 0}</td>
                      <td style={{ color: C.red, padding: "6px 10px" }}>{token.sellCount ?? 0}</td>
                      <td style={{ padding: "6px 10px" }}>{token.smartWalletCount}</td>
                      <td style={{ color: pctColor(token.probabilityContinuation), fontWeight: 600, padding: "6px 10px" }}>{token.probabilityContinuation}%</td>
                      <td style={{ color: pctColor(token.probabilityMigration), padding: "6px 10px" }}>{token.probabilityMigration}%</td>
                      <td style={{ color: token.probabilityRug >= 50 ? C.red : C.muted, padding: "6px 10px" }}>{token.probabilityRug}%</td>
                      <td style={{ color: pctColor(token.probabilityHit30kBefore10k), padding: "6px 10px" }}>{token.probabilityHit30kBefore10k}%</td>
                      <td style={{ color: pctColor(token.probabilityLocalTop), padding: "6px 10px" }}>{token.probabilityLocalTop}%</td>
                      <td style={{ padding: "6px 10px" }}>{lifecycleBadge(token.lifecycle)}</td>
                    </tr>
                  ))}
                  {filteredTokens.length === 0 && (
                    <tr><td colSpan={14} style={{ color: C.muted, padding: "24px 10px", textAlign: "center" }}>
                      {tokens.length === 0 ? "Waiting for Pump.fun events…" : "No tokens match current filters."}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Sidebar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", marginBottom: 10, textTransform: "uppercase" }}>Recent Alerts</div>
                {alerts.length === 0 && <div style={{ color: C.muted, fontSize: 12 }}>No alerts yet</div>}
                {alerts.slice(0, 8).map((a, i) => (
                  <div key={`${a.id}-${i}`} style={{ borderBottom: `1px solid ${C.border}`, fontSize: 12, marginBottom: 7, paddingBottom: 7 }}>
                    <Badge label={a.severity} color={a.severity === "critical" ? C.red : a.severity === "warning" ? C.yellow : C.blue} />
                    {" "}{a.message}
                  </div>
                ))}
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", marginBottom: 10, textTransform: "uppercase" }}>Latest Probabilities</div>
                {probabilities.slice(0, 6).map((p, i) => (
                  <div key={`${p.mint}-${i}`} style={{ borderBottom: `1px solid ${C.border}`, display: "flex", fontSize: 12, gap: 8, marginBottom: 6, paddingBottom: 6 }}>
                    <span style={{ color: C.muted, fontFamily: "monospace" }}>{p.mint.slice(0, 6)}</span>
                    <span style={{ color: pctColor(p.continuation) }}>C:{p.continuation}%</span>
                    <span style={{ color: C.muted }}>M:{p.migration}%</span>
                    <span style={{ color: p.rug >= 50 ? C.red : C.muted }}>R:{p.rug}%</span>
                  </div>
                ))}
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", marginBottom: 10, textTransform: "uppercase" }}>Alert Rules</div>
                {rules.slice(0, 5).map((r) => (
                  <div key={r.id} style={{ alignItems: "center", display: "flex", fontSize: 12, gap: 8, marginBottom: 6 }}>
                    <span style={{ color: r.enabled ? C.green : C.red, fontSize: 10 }}>●</span>
                    <span style={{ color: "#cbd5e1", flex: 1 }}>{r.name}</span>
                    <span style={{ color: C.muted }}>cd:{r.cooldownSeconds}s</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ WALLETS TAB ══ */}
      {tab === "wallets" && (
        <div>
          {/* Filter bar */}
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            <input placeholder="Search wallet address…" value={walletFilters.search}
              onChange={(e) => setWalletFilters((f) => ({ ...f, search: e.target.value }))}
              style={{ ...inputStyle, minWidth: 260, fontFamily: "monospace" }} />
            <select value={walletFilters.category}
              onChange={(e) => setWalletFilters((f) => ({ ...f, category: e.target.value }))}
              style={selectStyle}>
              {["all", "elite_early", "continuation", "scalper", "sniper", "distribution", "insider", "bad", "unknown"].map((v) => (
                <option key={v} value={v}>{v === "all" ? "All categories" : v}</option>
              ))}
            </select>
            <input placeholder="Min trades" value={walletFilters.minTrades} type="number"
              onChange={(e) => setWalletFilters((f) => ({ ...f, minTrades: e.target.value }))}
              style={{ ...inputStyle, width: 90 }} />
            {(walletFilters.search || walletFilters.category !== "all" || walletFilters.minTrades) && (
              <button onClick={() => setWalletFilters({ category: "all", search: "", minTrades: "" })}
                style={{ ...inputStyle, color: C.red, cursor: "pointer" }}>✕ clear</button>
            )}
            <span style={{ color: C.muted, fontSize: 12, marginLeft: "auto" }}>{filteredWallets.length} wallets</span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
              <thead style={{ borderBottom: `1px solid ${C.border}` }}>
                <tr>
                  <Th>Wallet</Th>
                  <Th>Category</Th>
                  <Th onClick={() => toggleWalletSort("realizedPnl")} active={walletSort === "realizedPnl"} asc={walletAsc}>PnL (SOL)</Th>
                  <Th onClick={() => toggleWalletSort("winRate")} active={walletSort === "winRate"} asc={walletAsc}>Win %</Th>
                  <Th onClick={() => toggleWalletSort("avgReturnMultiple")} active={walletSort === "avgReturnMultiple"} asc={walletAsc}>Avg Return</Th>
                  <Th onClick={() => toggleWalletSort("totalTrades")} active={walletSort === "totalTrades"} asc={walletAsc}>Trades</Th>
                  <Th onClick={() => toggleWalletSort("avgEntryMc")} active={walletSort === "avgEntryMc"} asc={walletAsc}>Avg Entry MC</Th>
                  <Th onClick={() => toggleWalletSort("avgExitMc")} active={walletSort === "avgExitMc"} asc={walletAsc}>Avg Exit MC</Th>
                  <Th onClick={() => toggleWalletSort("avgHoldMinutes")} active={walletSort === "avgHoldMinutes"} asc={walletAsc}>Avg Hold</Th>
                  <Th onClick={() => toggleWalletSort("migrationSuccessRate")} active={walletSort === "migrationSuccessRate"} asc={walletAsc}>Migrate %</Th>
                  <Th onClick={() => toggleWalletSort("rugExposureRate")} active={walletSort === "rugExposureRate"} asc={walletAsc}>Rug Exp %</Th>
                  <Th>Confidence</Th>
                </tr>
              </thead>
              <tbody>
                {filteredWallets.slice(0, 100).map((w) => (
                  <tr key={w.wallet} style={{ borderBottom: `1px solid ${C.border}` }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.surface; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                    <td style={{ padding: "6px 10px" }}><CopyButton value={w.wallet} /></td>
                    <td style={{ padding: "6px 10px" }}>
                      <Badge label={w.category} color={categoryColor[w.category] ?? C.muted} />
                    </td>
                    <td style={{ color: w.realizedPnl >= 0 ? C.green : C.red, fontWeight: 600, padding: "6px 10px" }}>
                      {fmtSol(w.realizedPnl)}
                    </td>
                    <td style={{ color: pctColor(w.winRate * 100), padding: "6px 10px" }}>
                      {(w.winRate * 100).toFixed(1)}%
                    </td>
                    <td style={{ color: w.avgReturnMultiple >= 1 ? C.green : C.red, padding: "6px 10px" }}>
                      {w.avgReturnMultiple.toFixed(2)}x
                    </td>
                    <td style={{ padding: "6px 10px" }}>{w.totalTrades}</td>
                    <td style={{ color: C.muted, padding: "6px 10px" }}>{fmtMc(w.avgEntryMc)}</td>
                    <td style={{ color: C.muted, padding: "6px 10px" }}>{fmtMc(w.avgExitMc)}</td>
                    <td style={{ padding: "6px 10px" }}>{fmtMins(w.avgHoldMinutes)}</td>
                    <td style={{ color: pctColor(w.migrationSuccessRate * 100), padding: "6px 10px" }}>
                      {(w.migrationSuccessRate * 100).toFixed(1)}%
                    </td>
                    <td style={{ color: w.rugExposureRate > 0.5 ? C.red : C.muted, padding: "6px 10px" }}>
                      {(w.rugExposureRate * 100).toFixed(1)}%
                    </td>
                    <td style={{ color: C.muted, padding: "6px 10px" }}>
                      <div style={{ background: C.faint, borderRadius: 3, height: 6, overflow: "hidden", width: 60 }}>
                        <div style={{ background: C.blue, height: "100%", width: `${Math.round(w.confidence * 100)}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredWallets.length === 0 && (
                  <tr><td colSpan={12} style={{ color: C.muted, padding: "24px 10px", textAlign: "center" }}>
                    {wallets.length === 0 ? "No wallets tracked yet — they populate as tokens trade." : "No wallets match current filters."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
