"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, CSSProperties } from "react";
import type { AlertEvent, AlertRule, DeveloperStat, PaperState, TokenState, WalletProfile } from "../lib/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";
const WS_BASE = API_BASE.startsWith("https://")
  ? API_BASE.replace("https://", "wss://")
  : API_BASE.replace("http://", "ws://");

// ─── Format helpers ────────────────────────────────────────────────────────
function fmtMC(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 1 : 2) + "k";
  return n.toFixed(0);
}
function fmtAge(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return secs + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m";
  if (secs < 86400) return Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m";
  return Math.floor(secs / 86400) + "d";
}
function fmtSec(s: number): string {
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}
function fmtClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " UTC";
}
function shortAddr(a: string): string {
  if (!a || a.length < 8) return a;
  return a.slice(0, 4) + "…" + a.slice(-4);
}
// Deadness is decided by the backend (lifecycle) so the UI never flip-flops on
// a moving client clock. The backend reaper marks tokens dead after ~2m of no trades.
function isDeadToken(t: TokenState): boolean {
  return t.lifecycle === "dead" || t.lifecycle === "failed";
}

// ─── Map real data to display phase ───────────────────────────────────────
function toPhase(lc: TokenState["lifecycle"]): string {
  const m: Record<string, string> = { new: "LAUNCH", accumulation: "CURVE", distribution: "CURVE", failed: "DEAD", migrated: "PUMPSWAP", dead: "DEAD" };
  return m[lc] ?? "CURVE";
}
function phaseBadge(phase: string): string {
  if (phase === "MIGRATING" || phase === "PUMPSWAP") return "a";
  if (phase === "DEAD") return "r";
  if (phase === "LAUNCH") return "g";
  return "";
}
function walletCatBadge(cat: string): string {
  const m: Record<string, string> = { elite_early: "g", continuation: "g", sniper: "a", scalper: "", distribution: "r", insider: "r", bad: "r", unknown: "" };
  return m[cat] ?? "";
}

// ─── Shared components ──────────────────────────────────────────────────────
function ProbBar({ value, width = 60 }: { value: number; width?: number }): ReactElement {
  const tone = value >= 70 ? "" : value >= 40 ? "mid" : "lo";
  const valTone = value >= 70 ? "hi" : value >= 40 ? "mid" : "lo";
  return (
    <span className="prob">
      <span className={`prob-bar ${tone}`} style={{ width }}>
        <i style={{ width: Math.min(100, value) + "%" }} />
      </span>
      <span className={`prob-val ${valTone}`}>{value.toFixed(1)}</span>
    </span>
  );
}

function Sparkline({ data, width = 70, height = 18 }: { data: number[]; width?: number; height?: number }): ReactElement | null {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data); const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  let d = "";
  data.forEach((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
  });
  const trend = data[data.length - 1] >= data[0] ? "var(--green)" : "var(--red)";
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={trend} strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function ScoreDonut({ value, label = "SCORE", size = 80 }: { value: number; label?: string; size?: number }): ReactElement {
  const col = value >= 70 ? "var(--green)" : value >= 40 ? "var(--amber)" : "var(--red)";
  return (
    <div className="donut" style={{ width: size, height: size, "--p": value, "--col": col } as CSSProperties}>
      <div>
        <b>{Math.round(value)}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

function CopyCell({ value }: { value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [value]);
  return (
    <span onClick={copy} title={value} style={{
      color: copied ? "var(--green)" : "var(--text-4)", cursor: "pointer", fontSize: 10,
      border: "1px solid var(--border)", padding: "0 4px", transition: "all .15s",
    }}>
      {copied ? "✓" : shortAddr(value)}
    </span>
  );
}

// ─── Coverage snapshot type ─────────────────────────────────────────────────
interface CoverageSnapshot {
  trackedMints: number; knownWallets: number; knownTokens: number;
  signaturesSeen: number; lastEventCount: number; lastPollAt?: string;
  launchSource?: string; bitqueryActive?: boolean;
}

// ─── Clock hook ─────────────────────────────────────────────────────────────
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  return now;
}

// ─── Header ─────────────────────────────────────────────────────────────────
function Header({ search, setSearch, coverage, wsConnected }: {
  search: string; setSearch: (v: string) => void; coverage: CoverageSnapshot | null; wsConnected: boolean;
}): ReactElement {
  const now = useClock();
  return (
    <header className="hdr">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-name">SAIRAS<span>//</span>PROBE</div>
        <div className="brand-build">v1.0 · live</div>
      </div>
      <div className="hdr-stats">
        <span className="hdr-stat">
          <span className={`dot ${wsConnected ? "dot-green pulse" : "dot-red"}`} /> {wsConnected ? "LIVE" : "CONNECTING"}
        </span>
        {coverage && <span className="hdr-stat">mints <b>{coverage.trackedMints}</b></span>}
        {coverage && <span className="hdr-stat">wallets <b>{coverage.knownWallets.toLocaleString()}</b></span>}
      </div>
      <div className="hdr-search">
        <span style={{ color: "var(--text-3)", fontSize: 11 }}>›</span>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="search mint, ticker, wallet… press /" />
        <span className="kbd">/</span>
      </div>
      <div className="hdr-stats">
        <span className="hdr-stat">
          source <b style={{ color: coverage?.bitqueryActive ? "var(--green)" : "var(--amber)" }}>
            {coverage?.launchSource ?? "helius+pumpfun"}
          </b>
        </span>
      </div>
      <div className="hdr-clock">{fmtClock(now)}</div>
    </header>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────
type TabId = "terminal" | "token" | "wallets" | "devs" | "alerts";
const TAB_DEFS: { id: TabId; label: string; desc: string }[] = [
  { id: "terminal", label: "TERMINAL", desc: "live token feed" },
  { id: "token",    label: "TOKEN",    desc: "deep-dive" },
  { id: "wallets",  label: "WALLETS",  desc: "intelligence" },
  { id: "devs",     label: "DEVS",     desc: "creator stats" },
  { id: "alerts",   label: "ALERTS",   desc: "event stream" },
];

function Tabs({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }): ReactElement {
  return (
    <nav className="tabs">
      {TAB_DEFS.map((t, i) => (
        <div key={t.id} className={"tab" + (active === t.id ? " active" : "")} onClick={() => onChange(t.id)}>
          <span className="idx">F{i + 1}</span>
          <span>{t.label}</span>
          <span className="idx" style={{ marginLeft: 4 }}>{t.desc}</span>
        </div>
      ))}
    </nav>
  );
}

// ─── Status bar ─────────────────────────────────────────────────────────────
function StatusBar({ totalTokens, totalWallets, coverage }: {
  totalTokens: number; totalWallets: number; coverage: CoverageSnapshot | null;
}): ReactElement {
  const now = useClock();
  return (
    <footer className="statusbar">
      <span>tokens <b>{totalTokens}</b></span>
      <span className="sep">│</span>
      <span>wallets <b>{totalWallets.toLocaleString()}</b></span>
      {coverage && <>
        <span className="sep">│</span>
        <span>sigs <b>{coverage.signaturesSeen.toLocaleString()}</b></span>
        <span className="sep">│</span>
        <span>events <b>{coverage.lastEventCount}</b></span>
      </>}
      <span className="right">
        <span>session {fmtClock(now).slice(0, 8)}</span>
      </span>
    </footer>
  );
}

// ─── TERMINAL VIEW ───────────────────────────────────────────────────────────
type SortKey = "createdAt" | "marketCap" | "holderCount" | "probabilityContinuation"
  | "probabilityMigration" | "probabilityRug" | "smartWalletCount" | "buyCount" | "volume" | "entryScore";

const EXIT_LABEL: Record<string, string> = {
  accumulate: "ACCUM", hold: "HOLD", take_profit: "TRIM", exit: "EXIT", dead: "DEAD"
};
function exitClass(sig?: string): string {
  if (sig === "hold") return "g";
  if (sig === "take_profit") return "a";
  if (sig === "exit" || sig === "dead") return "r";
  return "";
}
function entryClass(score: number): string {
  if (score >= 70) return "up";
  if (score >= 45) return "";
  return "dim";
}
// Headline ACTION badge styling — BUY pops, exits warn, dead/avoid dim.
function actionStyle(a?: string): React.CSSProperties {
  switch (a) {
    case "BUY": return { background: "var(--green)", color: "#001b0e", fontWeight: 800, boxShadow: "0 0 8px var(--green-dim)" };
    case "WATCH": return { background: "var(--green-bg)", color: "var(--green)", border: "1px solid var(--green-dim)" };
    case "HOLD": return { background: "transparent", color: "var(--green)", border: "1px solid var(--green-dim)" };
    case "TRIM": return { background: "var(--amber-bg, transparent)", color: "var(--amber, #e0a13a)", border: "1px solid var(--amber, #e0a13a)" };
    case "EXIT": return { background: "transparent", color: "var(--red)", border: "1px solid var(--red)", fontWeight: 700 };
    case "DEAD": return { background: "transparent", color: "var(--text-3)", border: "1px solid var(--border)" };
    default: return { background: "transparent", color: "var(--text-3)", border: "1px solid var(--border)" }; // AVOID
  }
}

function TerminalView({ tokens, search, onSelectToken, paper, onPaperControl }: {
  tokens: TokenState[]; search: string; onSelectToken: (t: TokenState) => void;
  paper: PaperState | null; onPaperControl: (action: "start" | "stop" | "reset") => void;
}): ReactElement {
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [phaseFilter, setPhaseFilter] = useState("ALL");
  const [minProb, setMinProb] = useState(0);
  const [onlySmart, setOnlySmart] = useState(false);
  const [onlyRunners, setOnlyRunners] = useState(false);
  const [onlyAlpha, setOnlyAlpha] = useState(false);
  const [onlyBuy, setOnlyBuy] = useState(false);

  const sorted = useMemo(() => {
    let arr = tokens.filter(t => {
      const phase = isDeadToken(t) ? "DEAD" : toPhase(t.lifecycle);
      if (phaseFilter !== "ALL" && phase !== phaseFilter) return false;
      if (t.probabilityContinuation < minProb) return false;
      if (onlySmart && t.smartWalletCount < 2) return false;
      if (onlyRunners && (t.entryScore ?? 0) < 45) return false;
      if (onlyAlpha && (t.smartMoneyBuys ?? 0) < 1) return false;
      if (onlyBuy && t.action !== "BUY") return false;
      if (search) {
        const s = search.toLowerCase();
        if (!t.symbol.toLowerCase().includes(s) && !t.name.toLowerCase().includes(s) && !t.mint.toLowerCase().includes(s)) return false;
      }
      return true;
    });
    arr = [...arr].sort((a, b) => {
      let av: number; let bv: number;
      if (sortKey === "createdAt") {
        av = new Date(a.createdAt).getTime(); bv = new Date(b.createdAt).getTime();
      } else {
        av = (a[sortKey] as number) ?? 0; bv = (b[sortKey] as number) ?? 0;
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [tokens, sortKey, sortDir, phaseFilter, minProb, onlySmart, onlyRunners, onlyAlpha, onlyBuy, search]);

  const setSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  };
  const sIcon = (k: SortKey) => sortKey === k ? (sortDir === "asc" ? "sort-asc" : "sort-desc") : "";

  // Top movers by prob (last seen vs current — use probabilityContinuation as proxy)
  const movers = useMemo(() =>
    [...tokens].sort((a, b) => b.probabilityContinuation - a.probabilityContinuation).slice(0, 8),
    [tokens]
  );

  return (
    <div className="view" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 1, background: "var(--border)", height: "100%", overflow: "hidden" }}>
      {/* main table */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)", overflow: "hidden" }}>
        <div className="filterbar">
          <span className="ascii-h">LIVE TOKEN FEED</span>
          <span className="muted">·</span>
          <button onClick={() => setOnlyBuy(s => !s)} style={{
            padding: "3px 10px", background: onlyBuy ? "var(--green)" : "transparent",
            color: onlyBuy ? "#001b0e" : "var(--green)", fontWeight: 800,
            border: "1px solid var(--green-dim)",
            fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{onlyBuy ? "✓" : "▸"} buy now</button>
          <label>phase</label>
          <div className="seg">
            {["ALL", "LAUNCH", "CURVE", "PUMPSWAP", "DEAD"].map(p => (
              <button key={p} className={phaseFilter === p ? "active" : ""} onClick={() => setPhaseFilter(p)}>{p}</button>
            ))}
          </div>
          <label>min P</label>
          <div className="seg">
            {[0, 40, 60, 75].map(v => (
              <button key={v} className={minProb === v ? "active" : ""} onClick={() => setMinProb(v)}>{v === 0 ? "any" : v + "%"}</button>
            ))}
          </div>
          <button onClick={() => setOnlySmart(s => !s)} style={{
            padding: "3px 9px", background: onlySmart ? "var(--green-bg)" : "transparent",
            color: onlySmart ? "var(--green)" : "var(--text-3)",
            border: "1px solid " + (onlySmart ? "var(--green-dim)" : "var(--border)"),
            fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{onlySmart ? "✓" : "·"} smart ≥ 2</button>
          <button onClick={() => setOnlyRunners(s => !s)} style={{
            padding: "3px 9px", background: onlyRunners ? "var(--green-bg)" : "transparent",
            color: onlyRunners ? "var(--green)" : "var(--text-3)",
            border: "1px solid " + (onlyRunners ? "var(--green-dim)" : "var(--border)"),
            fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{onlyRunners ? "✓" : "·"} runners</button>
          <button onClick={() => setOnlyAlpha(s => !s)} style={{
            padding: "3px 9px", background: onlyAlpha ? "var(--green-bg)" : "transparent",
            color: onlyAlpha ? "var(--green)" : "var(--text-3)",
            border: "1px solid " + (onlyAlpha ? "var(--green-dim)" : "var(--border)"),
            fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{onlyAlpha ? "✓" : "·"} ★ smart money</button>
          <div className="spacer" />
          <span className="muted">{sorted.length}/{tokens.length}</span>
          <span style={{ color: "var(--green)" }}>live <span className="dot dot-green pulse" /></span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th onClick={() => setSort("createdAt")} className={sIcon("createdAt")} style={{ width: 56 }}>AGE</th>
                <th>TICKER</th>
                <th style={{ width: 72 }}>ACTION</th>
                <th style={{ width: 90 }}>PHASE</th>
                <th onClick={() => setSort("marketCap")} className={sIcon("marketCap") + " right"} style={{ textAlign: "right", width: 80 }}>MC</th>
                <th onClick={() => setSort("volume")} className={sIcon("volume") + " right"} style={{ textAlign: "right", width: 80 }}>VOL</th>
                <th onClick={() => setSort("holderCount")} className={sIcon("holderCount") + " right"} style={{ textAlign: "right", width: 70 }}>HOLD.</th>
                <th onClick={() => setSort("buyCount")} className={sIcon("buyCount") + " right"} style={{ textAlign: "right", width: 60 }}>BUYS</th>
                <th style={{ textAlign: "right", width: 60 }}>SELLS</th>
                <th onClick={() => setSort("smartWalletCount")} className={sIcon("smartWalletCount") + " right"} style={{ textAlign: "right", width: 60 }}>SMART</th>
                <th style={{ textAlign: "right", width: 70 }}>INSIDER%</th>
                <th style={{ width: 60 }}>DEV★</th>
                <th onClick={() => setSort("entryScore")} className={sIcon("entryScore") + " right"} style={{ textAlign: "right", width: 64 }}>ENTRY</th>
                <th style={{ width: 70 }}>EXIT</th>
                <th onClick={() => setSort("probabilityContinuation")} className={sIcon("probabilityContinuation")} style={{ width: 140 }}>P(CONT) ↑</th>
                <th onClick={() => setSort("probabilityMigration")} className={sIcon("probabilityMigration")} style={{ width: 120 }}>P(MIGR)</th>
                <th onClick={() => setSort("probabilityRug")} className={sIcon("probabilityRug")} style={{ width: 100 }}>P(RUG)</th>
                <th style={{ width: 60 }}>COPY</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const dead = isDeadToken(t);
                const phase = dead ? "DEAD" : toPhase(t.lifecycle);
                const insider = t.insiderConcentration ?? 0;
                return (
                  <tr key={t.mint} onClick={() => onSelectToken(t)} style={dead ? { opacity: 0.45 } : undefined}>
                    <td className="dim">{String(i + 1).padStart(3, "0")}</td>
                    <td className="dim">{t.createdAt ? fmtAge(t.createdAt) : "—"}</td>
                    <td>
                      <div className="tick">
                        <span className="sym">${t.symbol}</span>
                        {(t.smartMoneyBuys ?? 0) > 0 && (
                          <span
                            title={`${t.smartMoneyBuys} proven-predictive wallet${(t.smartMoneyBuys ?? 0) > 1 ? "s" : ""} bought this`}
                            style={{ color: "var(--green)", fontWeight: 700, fontSize: 10, letterSpacing: 0.3 }}
                          >★{(t.smartMoneyBuys ?? 0) > 1 ? `×${t.smartMoneyBuys}` : ""} SMART</span>
                        )}
                        <span className="ca">{t.name && t.name !== t.symbol ? t.name.slice(0, 14) : ""}</span>
                      </div>
                    </td>
                    <td>
                      <span style={{ ...actionStyle(dead ? "DEAD" : t.action), padding: "2px 7px", borderRadius: 3, fontSize: 10, letterSpacing: "0.05em", display: "inline-block" }}>
                        {dead ? "DEAD" : (t.action ?? "WATCH")}
                      </span>
                    </td>
                    <td><span className={`badge ${phaseBadge(phase)}`}>{phase}</span></td>
                    <td className="right">${fmtMC(t.marketCap)}</td>
                    <td className="right dim">{t.volume ? "$" + fmtMC(t.volume) : "—"}</td>
                    <td className="right">{t.holderCount.toLocaleString()}</td>
                    <td className="right up">{t.buyCount ?? 0}</td>
                    <td className="right down">{t.sellCount ?? 0}</td>
                    <td className={`right ${t.smartWalletCount >= 3 ? "up" : t.smartWalletCount === 0 ? "dim" : ""}`}>{t.smartWalletCount}</td>
                    <td className={`right ${insider > 0.3 ? "down" : insider < 0.1 ? "up" : "dim"}`}>
                      {insider > 0 ? (insider * 100).toFixed(0) + "%" : "—"}
                    </td>
                    <td className={`dim ${t.devScore >= 70 ? "up" : t.devScore < 35 ? "down" : ""}`} style={{ fontSize: 11 }}>{t.devScore}</td>
                    <td className={`right ${entryClass(t.entryScore ?? 0)}`} title={`${t.earlyUniqueBuyers ?? 0} early buyers · net ${(t.earlyNetSol ?? 0).toFixed(1)} SOL`} style={{ fontWeight: 600 }}>{t.entryScore ?? 0}</td>
                    <td><span className={`badge ${exitClass(t.exitSignal)}`}>{EXIT_LABEL[t.exitSignal ?? "accumulate"]}</span></td>
                    <td><ProbBar value={t.probabilityContinuation} /></td>
                    <td><ProbBar value={t.probabilityMigration} /></td>
                    <td><ProbBar value={t.probabilityRug} /></td>
                    <td onClick={e => e.stopPropagation()}><CopyCell value={t.mint} /></td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={19} style={{ color: "var(--text-3)", padding: "32px 10px", textAlign: "center" }}>
                  {tokens.length === 0 ? "Waiting for Pump.fun launches…" : "No tokens match filters."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", minHeight: 0, overflow: "hidden" }}>
        <div className="panel" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel-hdr"><span className="title">▲ TOP PROBABILITY</span></div>
          <div className="panel-body p" style={{ overflow: "auto" }}>
            {movers.map(t => (
              <div key={t.mint} onClick={() => onSelectToken(t)} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)", cursor: "pointer", alignItems: "center", fontSize: 12 }}>
                <div>
                  <div className="fg">${t.symbol}</div>
                  <div className="dim" style={{ fontSize: 10 }}>{toPhase(t.lifecycle)} · ${fmtMC(t.marketCap)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="up" style={{ fontWeight: 500 }}>{t.probabilityContinuation.toFixed(0)}</div>
                  <div className="dim" style={{ fontSize: 10 }}>{fmtAge(t.createdAt)}</div>
                </div>
              </div>
            ))}
            {movers.length === 0 && <div className="dim" style={{ fontSize: 11, padding: 12 }}>No tokens yet</div>}
          </div>
        </div>
        <PaperBotPanel paper={paper} onControl={onPaperControl} onSelectToken={onSelectToken} tokens={tokens} />
      </div>
    </div>
  );
}

// ─── PAPER TRADING BOT PANEL ─────────────────────────────────────────────────
function exitLabel(reason: string): string {
  const map: Record<string, string> = { trail: "trail 30%", stop: "stop −10%", tp: "take-profit", dead: "dead", timestop: "time-stop", leadersell: "leader sell" };
  return map[reason] ?? reason;
}

function PaperBotPanel({ paper, onControl, onSelectToken, tokens }: {
  paper: PaperState | null;
  onControl: (action: "start" | "stop" | "reset") => void;
  onSelectToken: (t: TokenState) => void;
  tokens: TokenState[];
}): ReactElement {
  const running = paper?.enabled ?? false;
  const ret = paper?.totalReturnPct ?? 0;
  const retColor = ret > 0 ? "var(--green)" : ret < 0 ? "var(--red)" : "var(--text-2)";
  const openByMint = (mint: string) => tokens.find(t => t.mint === mint);
  return (
    <div className="panel" style={{ flex: "0 0 auto", maxHeight: "52%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="panel-hdr" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="title">🤖 PAPER BOT {running && <span className="dot dot-green pulse" />}</span>
        <span style={{ fontSize: 9, color: running ? "var(--green)" : "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {running ? "running" : "stopped"}
        </span>
      </div>
      <div className="panel-body" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden", minHeight: 0 }}>
        {/* controls */}
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => onControl(running ? "stop" : "start")} style={{
            flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
            background: running ? "var(--red)" : "var(--green)", color: running ? "#fff" : "#001b0e", border: "none", cursor: "pointer",
          }}>{running ? "■ Stop" : "▶ Start"}</button>
          <button onClick={() => onControl("reset")} style={{
            padding: "5px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
            background: "transparent", color: "var(--text-3)", border: "1px solid var(--border)", cursor: "pointer",
          }}>Reset</button>
        </div>
        {/* equity summary */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <Stat label="EQUITY" value={`${(paper?.equity ?? 0).toFixed(2)}◎`} />
          <Stat label="RETURN" value={`${ret > 0 ? "+" : ""}${ret.toFixed(1)}%`} color={retColor} />
          <Stat label="REALIZED" value={`${(paper?.realizedPnl ?? 0) > 0 ? "+" : ""}${(paper?.realizedPnl ?? 0).toFixed(2)}◎`} color={(paper?.realizedPnl ?? 0) >= 0 ? "var(--green)" : "var(--red)"} />
          <Stat label="CASH" value={`${(paper?.cash ?? 0).toFixed(2)}◎`} />
          <Stat label="WIN RATE" value={paper && paper.tradeCount > 0 ? `${Math.round(paper.winRate * 100)}%` : "—"} />
          <Stat label="TRADES" value={`${paper?.tradeCount ?? 0} (${paper?.wins ?? 0}/${paper?.losses ?? 0})`} />
        </div>
        {/* open positions */}
        <div style={{ overflow: "auto", minHeight: 0, flex: 1 }}>
          <div className="dim" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", margin: "2px 0 4px" }}>
            Open ({paper?.openCount ?? 0})
          </div>
          {(paper?.positions ?? []).map(p => (
            <div key={p.mint} onClick={() => { const t = openByMint(p.mint); if (t) onSelectToken(t); }} title="open chart" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span className="fg">${p.symbol} {p.riding && <span style={{ fontSize: 8, color: "var(--amber)", border: "1px solid var(--amber)", padding: "0 3px", letterSpacing: "0.06em" }}>RIDING</span>}</span>
                <span style={{ color: p.pnlPct >= 0 ? "var(--green)" : "var(--red)" }}>{p.pnlPct > 0 ? "+" : ""}{p.pnlPct.toFixed(0)}%</span>
              </div>
              <div className="dim" style={{ fontSize: 9, marginTop: 1 }}>
                ${fmtMC(p.entryMc)} → ${fmtMC(p.currentMc)} <span style={{ opacity: 0.6 }}>· peak ${fmtMC(p.peakMc)}</span>
              </div>
            </div>
          ))}
          {(paper?.positions ?? []).length === 0 && <div className="dim" style={{ fontSize: 10 }}>no open positions</div>}

          <div className="dim" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", margin: "8px 0 4px" }}>
            Recent closes
          </div>
          {(paper?.trades ?? []).slice(0, 8).map((t, i) => (
            <div key={t.mint + i} onClick={() => { const tok = openByMint(t.mint); if (tok) onSelectToken(tok); }} style={{ padding: "4px 0", borderBottom: "1px solid var(--border)", cursor: openByMint(t.mint) ? "pointer" : "default" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span className="fg">${t.symbol} <span className="dim" style={{ fontSize: 9 }}>{exitLabel(t.reason)}</span></span>
                <span style={{ color: t.pnl >= 0 ? "var(--green)" : "var(--red)" }}>{t.pnl > 0 ? "+" : ""}{t.pnl.toFixed(2)}◎ <span style={{ fontSize: 9 }}>({t.pnlPct > 0 ? "+" : ""}{t.pnlPct.toFixed(0)}%)</span></span>
              </div>
              <div className="dim" style={{ fontSize: 9, marginTop: 1 }}>${fmtMC(t.entryMc)} → ${fmtMC(t.exitMc)}</div>
            </div>
          ))}
          {(paper?.trades ?? []).length === 0 && <div className="dim" style={{ fontSize: 10 }}>no closed trades yet</div>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }): ReactElement {
  return (
    <div style={{ background: "var(--bg-2, rgba(255,255,255,0.02))", padding: "4px 6px", border: "1px solid var(--border)" }}>
      <div className="dim" style={{ fontSize: 8, letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: color ?? "var(--text-1)" }}>{value}</div>
    </div>
  );
}

// ─── PRICE CHART (dependency-free SVG) ───────────────────────────────────────
function PriceChart({ mint, entryMc, exitMc, height = 120 }: { mint: string; entryMc?: number; exitMc?: number; height?: number }): ReactElement {
  const [pts, setPts] = useState<{ t: number; mc: number }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancel = false;
    const fetchPts = (initial: boolean) => {
      if (initial) { setLoading(true); setPts([]); }
      fetch(`${API_BASE}/api/tokens/${mint}/trades`)
        .then(r => r.json())
        .then((j: { trades?: { marketCap: number; ts: string }[] }) => {
          if (cancel) return;
          const raw = (j.trades ?? [])
            .map(tr => ({ t: new Date(tr.ts).getTime(), mc: Number(tr.marketCap) || 0 }))
            .filter(p => p.mc > 0 && Number.isFinite(p.t))
            .sort((a, b) => a.t - b.t);
          setPts(raw); setLoading(false);
        })
        .catch(() => { if (!cancel) setLoading(false); });
    };
    fetchPts(true);
    const iv = setInterval(() => fetchPts(false), 10000); // refresh while watching a live position
    return () => { cancel = true; clearInterval(iv); };
  }, [mint]);

  if (loading) return <div className="dim" style={{ fontSize: 11, padding: 12 }}>loading price history…</div>;
  if (pts.length < 2) return <div className="dim" style={{ fontSize: 11, padding: 12 }}>not enough trade history to chart yet</div>;

  const W = 320, H = height, PAD = 4;
  const mcs = pts.map(p => p.mc);
  let minMc = Math.min(...mcs), maxMc = Math.max(...mcs);
  for (const v of [entryMc, exitMc]) { if (v && v > 0) { minMc = Math.min(minMc, v); maxMc = Math.max(maxMc, v); } }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (mc: number) => PAD + (1 - (mc - minMc) / Math.max(1, maxMc - minMc)) * (H - 2 * PAD);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.mc).toFixed(1)}`).join(" ");
  const up = pts[pts.length - 1].mc >= pts[0].mc;
  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", background: "var(--bg-3)", border: "1px solid var(--border)" }}>
        {entryMc && entryMc > 0 && <line x1={0} x2={W} y1={y(entryMc)} y2={y(entryMc)} stroke="var(--green)" strokeWidth={0.6} strokeDasharray="3 2" opacity={0.7} />}
        {exitMc && exitMc > 0 && <line x1={0} x2={W} y1={y(exitMc)} y2={y(exitMc)} stroke="var(--red)" strokeWidth={0.6} strokeDasharray="3 2" opacity={0.7} />}
        <path d={path} fill="none" stroke={up ? "var(--green)" : "var(--red)"} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="dim" style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 3 }}>
        <span>low ${fmtMC(minMc)}</span>
        <span>{pts.length} trades{entryMc ? " · ⸺ entry" : ""}{exitMc ? " · ⸺ exit" : ""}</span>
        <span>high ${fmtMC(maxMc)}</span>
      </div>
    </div>
  );
}

// ─── TOKEN DEEP-DIVE VIEW ───────────────────────────────────────────────────
function TokenView({ token, onSelectToken, paper }: { token: TokenState | null; onSelectToken: (t: TokenState) => void; paper: PaperState | null }): ReactElement {
  const [innerTab, setInnerTab] = useState("signals");

  if (!token) {
    return (
      <div className="view" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)", height: "100%" }}>
        no token selected — click a row in the terminal
      </div>
    );
  }

  const prob = token.probabilityContinuation;
  const probColor = prob >= 70 ? "var(--green)" : prob >= 40 ? "var(--amber)" : "var(--red)";
  const phase = toPhase(token.lifecycle);
  const insider = token.insiderConcentration ?? 0;
  const buyPressure = token.buyCount && token.sellCount ? (token.buyCount / Math.max(1, token.sellCount)) : 0;

  const measurables = [
    { label: `reaches $${fmtMC(token.marketCap * 1.5)} before $${fmtMC(token.marketCap * 0.6)}`, p: Math.round(Math.min(95, prob * 1.05)) },
    { label: `migrates to PumpSwap`, p: token.probabilityMigration },
    { label: `rug / abandonment`, p: token.probabilityRug },
    { label: `local top within 10m`, p: token.probabilityLocalTop ?? Math.round(Math.max(8, 70 - prob * 0.7)) },
    { label: `hits $30k before $10k`, p: token.probabilityHit30kBefore10k ?? Math.round(prob * 0.6) },
  ];

  const signals: { s: number; label: string; detail: string }[] = [];
  if (token.devScore > 70) signals.push({ s: +(10 + Math.round(token.devScore / 10)), label: "High-reputation dev", detail: "score " + token.devScore });
  if (token.devScore < 35) signals.push({ s: -(8 + Math.round((50 - token.devScore) / 5)), label: "Low-reputation dev", detail: "score " + token.devScore });
  if (token.smartWalletCount >= 3) signals.push({ s: +(token.smartWalletCount * 3), label: `${token.smartWalletCount} smart wallets in`, detail: "net " + (token.smartWalletNetFlow >= 0 ? "+" : "") + token.smartWalletNetFlow.toFixed(0) + " SOL" });
  if (token.smartWalletCount === 0) signals.push({ s: -8, label: "No smart money", detail: "" });
  if (insider > 0.30) signals.push({ s: -(Math.round(insider * 60)), label: "High insider concentration", detail: (insider * 100).toFixed(0) + "% top holders" });
  if (insider > 0 && insider < 0.10) signals.push({ s: +6, label: "Low insider concentration", detail: (insider * 100).toFixed(1) + "%" });
  if (token.holderCount > 200) signals.push({ s: +8, label: "Strong holder base", detail: token.holderCount.toLocaleString() + " holders" });
  if (buyPressure > 1.4) signals.push({ s: +8, label: "Buy pressure dominant", detail: "B/S " + buyPressure.toFixed(2) });
  if (buyPressure > 0 && buyPressure < 0.7) signals.push({ s: -8, label: "Sell pressure dominant", detail: "B/S " + buyPressure.toFixed(2) });
  const signalTotal = signals.reduce((s, x) => s + x.s, 0);

  const pos = paper?.positions.find(p => p.mint === token.mint) ?? null;
  const lastTrade = paper?.trades.find(t => t.mint === token.mint) ?? null;
  const chartEntry = pos?.entryMc ?? lastTrade?.entryMc;
  const chartExit = lastTrade?.exitMc;

  return (
    <div className="view" style={{ display: "grid", gridTemplateRows: "auto auto 1fr", height: "100%", background: "var(--bg)", overflow: "hidden" }}>
      {/* token header */}
      <div style={{ borderBottom: "1px solid var(--border)", padding: "14px 16px", display: "grid", gridTemplateColumns: "1fr auto auto auto auto", gap: 24, alignItems: "center", background: "var(--bg-1)" }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em" }}>${token.symbol}</span>
            <span className="dim" style={{ fontSize: 13 }}>{token.name}</span>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11, color: "var(--text-3)" }}>
            <span>mint <CopyCell value={token.mint} /></span>
            <span>│</span>
            <span>age <span className="fg">{fmtAge(token.createdAt)}</span></span>
            <span>│</span>
            <span>dev ★<span className={token.devScore >= 70 ? "up" : token.devScore < 35 ? "down" : "dim"} style={{ marginLeft: 4 }}>{token.devScore}</span></span>
            <span>│</span>
            <span>phase <span className={`badge ${phaseBadge(phase)}`}>{phase}</span></span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="ascii-h">MARKET CAP</div>
          <div className="bignum">${fmtMC(token.marketCap)}</div>
          <div className="dim" style={{ fontSize: 11 }}>ATH ${fmtMC(token.athMarketCap ?? token.marketCap)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="ascii-h">HOLDERS</div>
          <div className="bignum">{token.holderCount.toLocaleString()}</div>
          <div className="dim" style={{ fontSize: 11 }}>buys {token.buyCount ?? 0} / sells {token.sellCount ?? 0}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="ascii-h">SMART WALLETS</div>
          <div className="bignum">{token.smartWalletCount}</div>
          <div className={token.smartWalletNetFlow > 0 ? "up" : "dn"} style={{ fontSize: 11 }}>
            net {token.smartWalletNetFlow >= 0 ? "+" : ""}{token.smartWalletNetFlow.toFixed(0)} SOL
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ScoreDonut value={prob} label="PROBABILITY" size={94} />
          <div>
            <div className="ascii-h">SIGNAL</div>
            <div className={signalTotal >= 0 ? "up" : "dn"} style={{ fontSize: 18, fontWeight: 500 }}>{signalTotal >= 0 ? "+" : ""}{signalTotal}</div>
            <div className="dim" style={{ fontSize: 10 }}>weighted score</div>
          </div>
        </div>
      </div>

      {/* full-width price chart */}
      <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-1)", padding: "12px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 16, flexWrap: "wrap" }}>
          <span className="ascii-h">PRICE (MARKET CAP) · {pos ? "IN POSITION" : lastTrade ? "CLOSED" : "history"}</span>
          {(pos || lastTrade) && (
            <div style={{ display: "flex", gap: 22, alignItems: "baseline" }}>
              <Stat label="ENTRY MC" value={`$${fmtMC((pos?.entryMc ?? lastTrade?.entryMc) || 0)}`} />
              {pos
                ? <Stat label={pos.riding ? "NOW · RIDING" : "NOW"} value={`$${fmtMC(pos.currentMc)}`} color={pos.pnlPct >= 0 ? "var(--green)" : "var(--red)"} />
                : <Stat label={`EXIT · ${exitLabel(lastTrade!.reason)}`} value={`$${fmtMC(lastTrade!.exitMc)}`} color={lastTrade!.pnl >= 0 ? "var(--green)" : "var(--red)"} />}
              <Stat label="PEAK MC" value={`$${fmtMC(pos?.peakMc ?? lastTrade?.exitMc ?? 0)}`} />
              <Stat label="P&L" value={`${((pos?.pnlPct ?? lastTrade?.pnlPct) ?? 0) > 0 ? "+" : ""}${((pos?.pnlPct ?? lastTrade?.pnlPct) ?? 0).toFixed(0)}%`} color={((pos?.pnlPct ?? lastTrade?.pnlPct) ?? 0) >= 0 ? "var(--green)" : "var(--red)"} />
              {token.playbookScore != null && <Stat label="WINNER SCORE" value={`${(token.playbookScore * 100).toFixed(0)}`} color={token.playbookScore >= 0.5 ? "var(--green)" : "var(--text-2)"} />}
              <Stat label="SIZE" value={`${(pos?.solIn ?? lastTrade?.solIn ?? 0).toFixed(2)}◎`} />
            </div>
          )}
        </div>
        <PriceChart mint={token.mint} entryMc={chartEntry} exitMc={chartExit} height={260} />
      </div>

      {/* body */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 360px", gap: 1, background: "var(--border)", minHeight: 0, overflow: "hidden" }}>
        {/* left: probabilities */}
        <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", minHeight: 0, overflow: "hidden" }}>
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-hdr"><span className="title">PROBABILITIES</span></div>
            <div className="panel-body p" style={{ overflow: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                {[
                  { label: "P(Continuation)", value: token.probabilityContinuation, color: "var(--green)" },
                  { label: "P(Migration)", value: token.probabilityMigration, color: "var(--amber)" },
                  { label: "P(Rug)", value: token.probabilityRug, color: "var(--red)" },
                  { label: "P(Local Top)", value: token.probabilityLocalTop ?? 0, color: "var(--text-2)" },
                  { label: "P(Hit $30k)", value: token.probabilityHit30kBefore10k ?? 0, color: "var(--green)" },
                  { label: "P(Hit $25k)", value: token.probabilityHit25kBefore10k ?? 0, color: "var(--text-2)" },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div className="dim" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
                    <div style={{ height: 6, background: "var(--bg-3)", position: "relative", marginBottom: 2 }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.min(100, value) + "%", background: color }} />
                    </div>
                    <div style={{ color, fontSize: 18, fontWeight: 500 }}>{value.toFixed(1)}<span className="dim" style={{ fontSize: 11 }}>%</span></div>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>STATS</div>
              <div className="kv">
                <span className="k">insider%</span><span className="v">{insider > 0 ? (insider * 100).toFixed(1) + "%" : "—"}</span>
                <span className="k">buy/sell</span><span className="v">{buyPressure > 0 ? buyPressure.toFixed(2) : "—"}</span>
                <span className="k">volume</span><span className="v">{token.volume ? "$" + fmtMC(token.volume) : "—"}</span>
                <span className="k">dev score</span><span className="v">{token.devScore}</span>
              </div>
            </div>
          </div>
        </div>

        {/* center: signal composition */}
        <div style={{ display: "grid", gridTemplateRows: "1fr auto", gap: 1, background: "var(--border)", minHeight: 0, overflow: "hidden" }}>
          <div className="panel">
            <div className="panel-hdr"><span className="title">PROBABILITY COMPOSITION · why this score?</span></div>
            <div className="panel-body p" style={{ overflow: "auto" }}>
              <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>weighted signals · sum to score</div>
              {signals.map((sig, i) => (
                <div key={i} className="signal">
                  <span className={`delta ${sig.s > 0 ? "p" : "n"}`}>{sig.s > 0 ? "+" : ""}{sig.s}</span>
                  <span className="lbl"><em style={{ color: "var(--text)" }}>{sig.label}</em> {sig.detail && <span className="dim">· {sig.detail}</span>}</span>
                </div>
              ))}
              {signals.length === 0 && <div className="dim" style={{ fontSize: 11, padding: "12px 0" }}>Accumulating signal data…</div>}
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="dim" style={{ fontSize: 11 }}>NET SIGNAL</span>
                <span className={signalTotal >= 0 ? "up" : "dn"} style={{ fontSize: 16, fontWeight: 500 }}>{signalTotal >= 0 ? "+" : ""}{signalTotal}</span>
              </div>
            </div>
          </div>

          <div className="panel" style={{ maxHeight: 220 }}>
            <div className="panel-hdr"><span className="title">MEASURABLE PREDICTIONS</span></div>
            <div className="panel-body p" style={{ overflow: "auto" }}>
              {measurables.map((m, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "5px 0", borderBottom: "1px dashed var(--border)", alignItems: "center", fontSize: 12 }}>
                  <span className="fg" style={{ fontSize: 11 }}>{m.label}</span>
                  <ProbBar value={m.p} width={50} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* right: tabs */}
        <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-1)", minHeight: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {[["signals", "OVERVIEW"], ["curve", "CURVE / PHASE"]].map(([id, lbl]) => (
              <div key={id} onClick={() => setInnerTab(id)} style={{
                padding: "8px 12px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em",
                cursor: "pointer", color: innerTab === id ? "var(--text)" : "var(--text-3)",
                borderBottom: innerTab === id ? "1px solid var(--green)" : "1px solid transparent",
                marginBottom: -1,
              }}>{lbl}</div>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {innerTab === "signals" && (
              <div style={{ padding: 12 }}>
                <div style={{ marginBottom: 12 }}>
                  <div className="ascii-h">INSIDER CONCENTRATION</div>
                  <div style={{ height: 8, background: "var(--bg-3)", marginTop: 6 }}>
                    <div style={{ height: "100%", width: Math.min(100, insider * 100) + "%", background: insider > 0.3 ? "var(--red)" : "var(--amber)" }} />
                  </div>
                  <div className="dim" style={{ fontSize: 10, marginTop: 4 }}>{(insider * 100).toFixed(1)}% held by linked wallets</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11, marginTop: 16 }}>
                  <div>
                    <div className="dim" style={{ fontSize: 10 }}>BUY/SELL RATIO</div>
                    <div className={buyPressure > 1 ? "up" : "dn"} style={{ fontSize: 18 }}>{buyPressure > 0 ? buyPressure.toFixed(2) : "—"}</div>
                  </div>
                  <div>
                    <div className="dim" style={{ fontSize: 10 }}>SMART WALLETS</div>
                    <div className={token.smartWalletCount >= 3 ? "up" : "dim"} style={{ fontSize: 18 }}>{token.smartWalletCount}</div>
                  </div>
                  <div>
                    <div className="dim" style={{ fontSize: 10 }}>ATH MC</div>
                    <div style={{ fontSize: 14 }}>${fmtMC(token.athMarketCap ?? token.marketCap)}</div>
                  </div>
                  <div>
                    <div className="dim" style={{ fontSize: 10 }}>VOLUME</div>
                    <div style={{ fontSize: 14 }}>{token.volume ? "$" + fmtMC(token.volume) : "—"}</div>
                  </div>
                </div>
              </div>
            )}
            {innerTab === "curve" && (
              <div style={{ padding: 14 }}>
                <div className="ascii-h">LIFECYCLE PHASE</div>
                <div style={{ marginTop: 12 }}>
                  {[
                    { id: "new", label: "LAUNCH" },
                    { id: "accumulation", label: "CURVE" },
                    { id: "distribution", label: "DISTRIBUTION" },
                    { id: "migrated", label: "PUMPSWAP" },
                    { id: "failed", label: "DEAD" },
                  ].map(ph => (
                    <div key={ph.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 11 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: token.lifecycle === ph.id ? "var(--green)" : "var(--bg-3)", border: "1px solid var(--border-2)" }} />
                      <span className={token.lifecycle === ph.id ? "up" : "dim"}>{ph.label}</span>
                      {token.lifecycle === ph.id && <span className="up" style={{ marginLeft: "auto", fontSize: 10 }}>← CURRENT</span>}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 20 }}>
                  <div className="ascii-h">PUMP CURVE TARGET</div>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                      <span className="dim">$0</span>
                      <span className={token.marketCap > 40000 ? "up" : "dim"}>{Math.min(100, (token.marketCap / 69000 * 100)).toFixed(1)}%</span>
                      <span className="dim">$69k</span>
                    </div>
                    <div style={{ height: 14, background: "var(--bg-3)", border: "1px solid var(--border)", position: "relative" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.min(100, token.marketCap / 69000 * 100) + "%", background: token.marketCap > 60000 ? "var(--amber)" : "var(--green)" }} />
                    </div>
                    <div className="dim" style={{ fontSize: 10, marginTop: 4 }}>migrates to PumpSwap at $69k MC</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── WALLETS VIEW ────────────────────────────────────────────────────────────
type WalletSort = "realizedPnl" | "winRate" | "avgReturnMultiple" | "totalTrades" | "avgEntryMc" | "avgHoldMinutes" | "migrationSuccessRate" | "rugExposureRate";

function WalletsView({ wallets, search, onSelectWallet, selectedWallet }: {
  wallets: WalletProfile[]; search: string;
  onSelectWallet: (w: WalletProfile) => void; selectedWallet: WalletProfile | null;
}): ReactElement {
  const [classFilter, setClassFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState<WalletSort>("realizedPnl");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    let arr = wallets.filter(w => {
      if (classFilter !== "ALL" && w.category !== classFilter) return false;
      if (search) { const s = search.toLowerCase(); if (!w.wallet.toLowerCase().includes(s)) return false; }
      return true;
    });
    arr = [...arr].sort((a, b) => {
      const av = (a[sortKey] as number) ?? 0; const bv = (b[sortKey] as number) ?? 0;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [wallets, classFilter, sortKey, sortDir, search]);

  const setSort = (k: WalletSort) => {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  };
  const sIcon = (k: WalletSort) => sortKey === k ? (sortDir === "asc" ? "sort-asc" : "sort-desc") : "";

  const CATS = ["ALL", "elite_early", "continuation", "sniper", "scalper", "distribution", "insider", "bad", "unknown"];
  const sel = selectedWallet ?? filtered[0] ?? null;

  return (
    <div className="view" style={{ display: "grid", gridTemplateColumns: "1fr 460px", gap: 1, background: "var(--border)", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)", overflow: "hidden" }}>
        <div className="filterbar">
          <span className="ascii-h">WALLET INTELLIGENCE</span>
          <span className="muted">·</span>
          <label>class</label>
          <div className="seg">
            {CATS.map(c => (
              <button key={c} className={classFilter === c ? "active" : ""} onClick={() => setClassFilter(c)}>{c === "ALL" ? "all" : c.replace("_", " ")}</button>
            ))}
          </div>
          <div className="spacer" />
          <span className="muted">{filtered.length}/{wallets.length} wallets</span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>WALLET</th>
                <th>CLASS</th>
                <th onClick={() => setSort("realizedPnl")} className={sIcon("realizedPnl") + " right"} style={{ textAlign: "right", width: 80 }}>PnL (SOL)</th>
                <th onClick={() => setSort("winRate")} className={sIcon("winRate") + " right"} style={{ textAlign: "right", width: 60 }}>WIN%</th>
                <th onClick={() => setSort("avgReturnMultiple")} className={sIcon("avgReturnMultiple") + " right"} style={{ textAlign: "right", width: 60 }}>AVG ×</th>
                <th onClick={() => setSort("totalTrades")} className={sIcon("totalTrades") + " right"} style={{ textAlign: "right", width: 60 }}>TRADES</th>
                <th onClick={() => setSort("avgEntryMc")} className={sIcon("avgEntryMc") + " right"} style={{ textAlign: "right", width: 80 }}>ENT. MC</th>
                <th onClick={() => setSort("avgHoldMinutes")} className={sIcon("avgHoldMinutes") + " right"} style={{ textAlign: "right", width: 60 }}>HOLD</th>
                <th onClick={() => setSort("migrationSuccessRate")} className={sIcon("migrationSuccessRate") + " right"} style={{ textAlign: "right", width: 70 }}>MIGR%</th>
                <th onClick={() => setSort("rugExposureRate")} className={sIcon("rugExposureRate") + " right"} style={{ textAlign: "right", width: 60 }}>RUG%</th>
                <th style={{ width: 70 }}>CONFIDENCE</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((w, i) => (
                <tr key={w.wallet} onClick={() => onSelectWallet(w)} className={sel?.wallet === w.wallet ? "selected" : ""}>
                  <td className="dim">{String(i + 1).padStart(3, "0")}</td>
                  <td className="addr">{shortAddr(w.wallet)}</td>
                  <td><span className={`badge ${walletCatBadge(w.category)}`}>{w.category.replace("_", " ")}</span></td>
                  <td className={`right ${w.realizedPnl > 0 ? "up" : "down"}`}>{w.realizedPnl > 0 ? "+" : ""}{w.realizedPnl.toFixed(2)}</td>
                  <td className="right">{(w.winRate * 100).toFixed(0)}%</td>
                  <td className="right">{w.avgReturnMultiple.toFixed(2)}×</td>
                  <td className="right">{w.totalTrades}</td>
                  <td className="right">${fmtMC(w.avgEntryMc)}</td>
                  <td className="right dim">{w.avgHoldMinutes < 60 ? Math.round(w.avgHoldMinutes) + "m" : Math.floor(w.avgHoldMinutes / 60) + "h"}</td>
                  <td className={`right ${w.migrationSuccessRate > 0.3 ? "up" : "dim"}`}>{(w.migrationSuccessRate * 100).toFixed(0)}%</td>
                  <td className={`right ${w.rugExposureRate > 0.5 ? "down" : "dim"}`}>{(w.rugExposureRate * 100).toFixed(0)}%</td>
                  <td>
                    <div style={{ height: 4, background: "var(--bg-3)", width: 60 }}>
                      <div style={{ height: "100%", width: Math.round(w.confidence * 100) + "%", background: "var(--green)" }} />
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={12} style={{ color: "var(--text-3)", padding: "32px 10px", textAlign: "center" }}>
                  {wallets.length === 0 ? "Wallets populate as tokens trade." : "No wallets match filters."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* wallet profile panel */}
      {sel ? (
        <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-1)", minHeight: 0, overflow: "auto" }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
              <ScoreDonut value={Math.round(sel.confidence * 100)} size={84} label="SCORE" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>WALLET</div>
                <div style={{ fontSize: 12, wordBreak: "break-all", marginBottom: 6 }}>{sel.wallet}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className={`badge ${walletCatBadge(sel.category)}`}>{sel.category.replace("_", " ")}</span>
                  <span className="badge">{sel.totalTrades} trades</span>
                </div>
              </div>
            </div>
          </div>

          <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
            <div className="ascii-h" style={{ marginBottom: 8 }}>SKILL METRICS</div>
            {[
              ["Win Rate", sel.winRate * 100, "%"],
              ["Avg Return", sel.avgReturnMultiple * 50, "×"],
              ["Migration Rate", sel.migrationSuccessRate * 100, "%"],
              ["Rug Avoidance", (1 - sel.rugExposureRate) * 100, "%"],
              ["Confidence", sel.confidence * 100, ""],
            ].map(([lbl, val, suffix]) => {
              const v = val as number;
              return (
                <div key={lbl as string} className="skill">
                  <span className="k">{lbl}</span>
                  <span className="b"><i style={{ width: Math.min(100, v) + "%", background: v >= 70 ? "var(--green)" : v >= 40 ? "var(--amber)" : "var(--red)" }} /></span>
                  <span className="v">{v.toFixed(0)}{suffix}</span>
                </div>
              );
            })}
          </div>

          <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
            <div className="ascii-h" style={{ marginBottom: 8 }}>PERFORMANCE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>WIN RATE</div>
                <div className={sel.winRate > 0.4 ? "up" : ""} style={{ fontSize: 22 }}>{(sel.winRate * 100).toFixed(0)}%</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>AVG MULTIPLE</div>
                <div className={sel.avgReturnMultiple > 2 ? "up" : ""} style={{ fontSize: 22 }}>{sel.avgReturnMultiple.toFixed(2)}×</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>REALIZED PnL</div>
                <div className={sel.realizedPnl > 0 ? "up" : "dn"} style={{ fontSize: 22 }}>{sel.realizedPnl > 0 ? "+" : ""}{sel.realizedPnl.toFixed(1)}</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>AVG ENTRY MC</div>
                <div style={{ fontSize: 14 }}>${fmtMC(sel.avgEntryMc)}</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>AVG HOLD</div>
                <div style={{ fontSize: 14 }}>{sel.avgHoldMinutes < 60 ? Math.round(sel.avgHoldMinutes) + "m" : Math.floor(sel.avgHoldMinutes / 60) + "h"}</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>TOTAL TRADES</div>
                <div style={{ fontSize: 14 }}>{sel.totalTrades}</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)", background: "var(--bg-1)", fontSize: 11 }}>
          select a wallet
        </div>
      )}
    </div>
  );
}

// ─── ALERTS VIEW ─────────────────────────────────────────────────────────────
function AlertsView({ alerts, rules, onSelectToken, tokens }: {
  alerts: AlertEvent[]; rules: AlertRule[];
  onSelectToken: (t: TokenState) => void; tokens: TokenState[];
}): ReactElement {
  const [toneFilter, setToneFilter] = useState("ALL");
  const [paused, setPaused] = useState(false);

  const filtered = useMemo(() => {
    if (toneFilter === "ALL") return alerts;
    const map: Record<string, string> = { good: "info", warn: "warning", crit: "critical" };
    const sev = map[toneFilter] ?? toneFilter;
    return alerts.filter(a => a.severity === sev);
  }, [alerts, toneFilter]);

  const counts = useMemo(() => {
    const c = { info: 0, warning: 0, critical: 0 };
    alerts.forEach(a => { if (a.severity in c) c[a.severity as keyof typeof c]++; });
    return c;
  }, [alerts]);

  const alertTone = (sev: string) => sev === "critical" ? "crit" : sev === "warning" ? "warn" : "good";
  const alertIcon = (sev: string) => sev === "critical" ? "✕" : sev === "warning" ? "!" : "↑";

  return (
    <div className="view" style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 1, background: "var(--border)", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)", overflow: "hidden" }}>
        <div className="filterbar">
          <span className="ascii-h">ALERT STREAM</span>
          <span className="muted">·</span>
          <div className="seg">
            <button className={toneFilter === "ALL" ? "active" : ""} onClick={() => setToneFilter("ALL")}>all <span className="dim">{alerts.length}</span></button>
            <button className={toneFilter === "good" ? "active" : ""} onClick={() => setToneFilter("good")} style={{ color: "var(--green)" }}>signal <span className="dim">{counts.info}</span></button>
            <button className={toneFilter === "warn" ? "active" : ""} onClick={() => setToneFilter("warn")} style={{ color: "var(--amber)" }}>warn <span className="dim">{counts.warning}</span></button>
            <button className={toneFilter === "crit" ? "active" : ""} onClick={() => setToneFilter("crit")} style={{ color: "var(--red)" }}>crit <span className="dim">{counts.critical}</span></button>
          </div>
          <div className="spacer" />
          <button onClick={() => setPaused(p => !p)} style={{ padding: "3px 10px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {paused ? "▶ resume" : "❚❚ pause"}
          </button>
          <span className={paused ? "muted" : "up"} style={{ fontSize: 10 }}>{paused ? "PAUSED" : "LIVE"} <span className={`dot ${paused ? "dot-dim" : "dot-green pulse"}`} /></span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {(paused ? filtered : filtered).map((a, i) => {
            const relToken = tokens.find(t => t.mint === a.tokenMint);
            const tone = alertTone(a.severity);
            return (
              <div key={a.id + "-" + i} className={`alert ${tone}`} onClick={() => relToken && onSelectToken(relToken)}>
                <span className="time">{fmtSec(Math.floor((Date.now() - new Date(a.createdAt).getTime()) / 1000))}</span>
                <span className="iconbox">{alertIcon(a.severity)}</span>
                <span className="msg">{a.message}</span>
                <span className="meta" style={{ fontSize: 10, color: "var(--text-3)" }}>{a.type}</span>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ color: "var(--text-3)", padding: "32px", textAlign: "center", fontSize: 11 }}>
              No alerts yet — they appear as tokens are analyzed.
            </div>
          )}
        </div>
      </div>

      {/* rules + stats */}
      <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-1)", minHeight: 0, overflow: "auto" }}>
        <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
          <div className="ascii-h">SESSION SUMMARY</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 10 }}>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>SIGNAL</div>
              <div className="up" style={{ fontSize: 22 }}>{counts.info}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>WARN</div>
              <div style={{ fontSize: 22, color: "var(--amber)" }}>{counts.warning}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>CRIT</div>
              <div className="dn" style={{ fontSize: 22 }}>{counts.critical}</div>
            </div>
          </div>
        </div>
        <div style={{ padding: 14, flex: 1, minHeight: 0, overflow: "auto" }}>
          <div className="ascii-h" style={{ marginBottom: 10 }}>ALERT RULES · {rules.filter(r => r.enabled).length}/{rules.length} active</div>
          {rules.length === 0 && <div className="dim" style={{ fontSize: 11 }}>No rules configured.</div>}
          {rules.map(r => (
            <div key={r.id} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "grid", gridTemplateColumns: "20px 1fr auto", alignItems: "center", gap: 10, fontSize: 11 }}>
              <span style={{
                width: 14, height: 14, border: "1px solid " + (r.enabled ? "var(--green-dim)" : "var(--border)"),
                background: r.enabled ? "var(--green-bg)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--green)", fontSize: 10,
              }}>{r.enabled ? "✓" : ""}</span>
              <div>
                <div className={r.enabled ? "fg" : "dim"}>{r.name}</div>
                <div className="dim" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em" }}>{r.severity} · cd:{r.cooldownSeconds}s</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── DEVS VIEW ───────────────────────────────────────────────────────────────
type DevSort = "tokens" | "migrated" | "hits25k" | "rugged" | "bestAth" | "avgAth" | "reputation";

function DevsView({ developers, search, onSelectToken, tokens }: {
  developers: DeveloperStat[]; search: string;
  onSelectToken: (t: TokenState) => void; tokens: TokenState[];
}): ReactElement {
  const [sortKey, setSortKey] = useState<DevSort>("tokens");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let arr = developers.filter(d => {
      if (search) { const s = search.toLowerCase(); if (!d.devWallet.toLowerCase().includes(s)) return false; }
      return true;
    });
    arr = [...arr].sort((a, b) => {
      const av = (a[sortKey] as number) ?? 0; const bv = (b[sortKey] as number) ?? 0;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [developers, sortKey, sortDir, search]);

  const setSort = (k: DevSort) => {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  };
  const sIcon = (k: DevSort) => sortKey === k ? (sortDir === "asc" ? "sort-asc" : "sort-desc") : "";

  const sel = selected ?? filtered[0]?.devWallet ?? null;
  const selDev = filtered.find(d => d.devWallet === sel) ?? null;
  const devTokens = useMemo(
    () => tokens.filter(t => t.devWallet && t.devWallet === sel)
      .sort((a, b) => (b.athMarketCap ?? 0) - (a.athMarketCap ?? 0)),
    [tokens, sel]
  );

  return (
    <div className="view" style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 1, background: "var(--border)", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)", overflow: "hidden" }}>
        <div className="filterbar">
          <span className="ascii-h">DEVELOPER INTELLIGENCE</span>
          <span className="muted">·</span>
          <span className="muted">creators ranked by observed launches & outcomes</span>
          <div className="spacer" />
          <span className="muted">{filtered.length} devs</span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>DEV WALLET</th>
                <th onClick={() => setSort("tokens")} className={sIcon("tokens") + " right"} style={{ textAlign: "right", width: 70 }}>LAUNCHES</th>
                <th onClick={() => setSort("migrated")} className={sIcon("migrated") + " right"} style={{ textAlign: "right", width: 70 }}>MIGR.</th>
                <th onClick={() => setSort("hits25k")} className={sIcon("hits25k") + " right"} style={{ textAlign: "right", width: 80 }}>≥25k</th>
                <th onClick={() => setSort("rugged")} className={sIcon("rugged") + " right"} style={{ textAlign: "right", width: 70 }}>RUGS</th>
                <th onClick={() => setSort("bestAth")} className={sIcon("bestAth") + " right"} style={{ textAlign: "right", width: 90 }}>BEST ATH</th>
                <th onClick={() => setSort("avgAth")} className={sIcon("avgAth") + " right"} style={{ textAlign: "right", width: 90 }}>AVG ATH</th>
                <th style={{ width: 56 }}>LAST</th>
                <th onClick={() => setSort("reputation")} className={sIcon("reputation")} style={{ width: 90 }}>REP</th>
                <th style={{ width: 60 }}>COPY</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map((d, i) => (
                <tr key={d.devWallet} onClick={() => setSelected(d.devWallet)} className={sel === d.devWallet ? "selected" : ""}>
                  <td className="dim">{String(i + 1).padStart(3, "0")}</td>
                  <td className="addr">{shortAddr(d.devWallet)}</td>
                  <td className={`right ${d.tokens >= 8 ? "down" : ""}`}>{d.tokens}</td>
                  <td className={`right ${d.migrated > 0 ? "up" : "dim"}`}>{d.migrated}</td>
                  <td className={`right ${d.hits25k > 0 ? "up" : "dim"}`}>{d.hits25k}</td>
                  <td className={`right ${d.rugged > 0 ? "down" : "dim"}`}>{d.rugged}</td>
                  <td className="right">${fmtMC(d.bestAth)}</td>
                  <td className="right dim">${fmtMC(d.avgAth)}</td>
                  <td className="dim">{d.lastLaunch ? fmtAge(d.lastLaunch) : "—"}</td>
                  <td><ProbBar value={d.reputation} /></td>
                  <td onClick={e => e.stopPropagation()}><CopyCell value={d.devWallet} /></td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={11} style={{ color: "var(--text-3)", padding: "32px 10px", textAlign: "center" }}>
                  {developers.length === 0 ? "Developer stats populate as tokens are tracked." : "No devs match search."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* dev detail panel: this creator's tokens */}
      <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-1)", minHeight: 0, overflow: "auto" }}>
        {selDev ? (
          <>
            <div style={{ padding: 16, borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                <ScoreDonut value={selDev.reputation} size={84} label="REP" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>DEV WALLET</div>
                  <div style={{ fontSize: 12, wordBreak: "break-all", marginBottom: 6 }}>{selDev.devWallet}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span className="badge">{selDev.tokens} launches</span>
                    {selDev.migrated > 0 && <span className="badge g">{selDev.migrated} migrated</span>}
                    {selDev.rugged > 0 && <span className="badge r">{selDev.rugged} rugs</span>}
                    {selDev.tokens >= 8 && selDev.migrated === 0 && <span className="badge r">serial spammer</span>}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: 14 }}>
              <div className="ascii-h" style={{ marginBottom: 8 }}>TOKENS BY THIS DEV {devTokens.length > 0 ? `(${devTokens.length} live)` : ""}</div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>TICKER</th>
                    <th style={{ textAlign: "right" }}>MC</th>
                    <th style={{ textAlign: "right" }}>ATH</th>
                    <th style={{ width: 70 }}>PHASE</th>
                  </tr>
                </thead>
                <tbody>
                  {devTokens.slice(0, 40).map(t => {
                    const phase = isDeadToken(t) ? "DEAD" : toPhase(t.lifecycle);
                    return (
                      <tr key={t.mint} onClick={() => onSelectToken(t)}>
                        <td><span className="sym">${t.symbol}</span></td>
                        <td className="right">${fmtMC(t.marketCap)}</td>
                        <td className="right dim">${fmtMC(t.athMarketCap ?? 0)}</td>
                        <td><span className={`badge ${phaseBadge(phase)}`}>{phase}</span></td>
                      </tr>
                    );
                  })}
                  {devTokens.length === 0 && (
                    <tr><td colSpan={4} style={{ color: "var(--text-3)", padding: "16px 10px", textAlign: "center" }}>
                      No live tokens from this dev in the current feed.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div style={{ padding: 24, color: "var(--text-3)" }}>Select a developer.</div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function Home(): ReactElement {
  const [tab, setTab] = useState<TabId>("terminal");
  const [search, setSearch] = useState("");
  const [tokens, setTokens] = useState<TokenState[]>([]);
  const [wallets, setWallets] = useState<WalletProfile[]>([]);
  const [developers, setDevelopers] = useState<DeveloperStat[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [coverage, setCoverage] = useState<CoverageSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [selectedToken, setSelectedToken] = useState<TokenState | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<WalletProfile | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // ── Data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const [tR, aR, ruR, cR, wR, dR, pR] = await Promise.all([
          fetch(`${API_BASE}/api/tokens`),
          fetch(`${API_BASE}/api/alerts`),
          fetch(`${API_BASE}/api/alerts/rules`),
          fetch(`${API_BASE}/api/ops/coverage`),
          fetch(`${API_BASE}/api/wallets`),
          fetch(`${API_BASE}/api/developers`),
          fetch(`${API_BASE}/api/paper`),
        ]);
        const tj = await tR.json() as { tokens?: TokenState[] };
        const aj = await aR.json() as { alerts?: AlertEvent[] };
        const ruj = await ruR.json() as { rules?: AlertRule[] };
        const cj = await cR.json() as { coverage?: CoverageSnapshot };
        const wj = await wR.json() as { wallets?: WalletProfile[] };
        const dj = await dR.json() as { developers?: DeveloperStat[] };
        const pj = await pR.json() as { paper?: PaperState };
        if (tj.tokens) setTokens(tj.tokens);
        if (aj.alerts) setAlerts(aj.alerts);
        setRules(ruj.rules ?? []);
        setCoverage(cj.coverage ?? null);
        if (wj.wallets) setWallets(wj.wallets);
        if (dj.developers) setDevelopers(dj.developers);
        if (pj.paper) setPaper(pj.paper);
      } catch { /* backend may be starting */ }
    };
    void load();
    const iv = setInterval(() => void load(), 8000);

    // WebSocket for real-time token updates
    const connect = () => {
      const ws = new WebSocket(`${WS_BASE}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => { setWsConnected(false); setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string; payload?: TokenState | PaperState;
            tokens?: TokenState[]; alerts?: AlertEvent[];
          };
          if (msg.type === "bootstrap") {
            if (msg.tokens) setTokens(msg.tokens);
            if (msg.alerts) setAlerts(msg.alerts);
            return;
          }
          if (msg.type === "paperUpdate") {
            if (msg.payload) setPaper(msg.payload as PaperState);
            return;
          }
          if (msg.type === "tokenUpdate" || msg.type === "tokenLaunch") {
            const t = msg.payload as TokenState | undefined; if (!t) return;
            setTokens(prev => {
              const next = prev.filter(x => x.mint !== t.mint);
              next.push(t);
              return next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 500);
            });
          }
        } catch { /* ignore parse errors */ }
      };
    };
    connect();
    return () => { clearInterval(iv); wsRef.current?.close(); };
  }, []);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const keys: Record<string, TabId> = { "1": "terminal", "2": "token", "3": "wallets", "4": "devs", "5": "alerts" };
      if (keys[e.key]) setTab(keys[e.key]);
      if (e.key === "/") { e.preventDefault(); document.querySelector<HTMLInputElement>(".hdr-search input")?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleSelectToken = (t: TokenState) => { setSelectedToken(t); setTab("token"); };

  const paperControl = useCallback(async (action: "start" | "stop" | "reset") => {
    try {
      const r = await fetch(`${API_BASE}/api/paper/${action}`, { method: "POST" });
      const j = await r.json() as { paper?: PaperState };
      if (j.paper) setPaper(j.paper);
    } catch { /* backend busy */ }
  }, []);

  return (
    <div className="app">
      <Header search={search} setSearch={setSearch} coverage={coverage} wsConnected={wsConnected} />
      <Tabs active={tab} onChange={setTab} />

      <div style={{ minHeight: 0, overflow: "hidden", position: "relative" }}>
        {tab === "terminal" && (
          <TerminalView tokens={tokens} search={search} onSelectToken={handleSelectToken} paper={paper} onPaperControl={paperControl} />
        )}
        {tab === "token" && (
          <TokenView token={selectedToken} onSelectToken={handleSelectToken} paper={paper} />
        )}
        {tab === "wallets" && (
          <WalletsView wallets={wallets} search={search} onSelectWallet={setSelectedWallet} selectedWallet={selectedWallet} />
        )}
        {tab === "devs" && (
          <DevsView developers={developers} search={search} onSelectToken={handleSelectToken} tokens={tokens} />
        )}
        {tab === "alerts" && (
          <AlertsView alerts={alerts} rules={rules} onSelectToken={handleSelectToken} tokens={tokens} />
        )}
      </div>

      <StatusBar totalTokens={tokens.length} totalWallets={wallets.length} coverage={coverage} />
    </div>
  );
}
