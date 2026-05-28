// chrome.jsx — Header, tabs, status bar, shared UI primitives

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// === useClock — UTC ticker ===
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// === Header ===
function Header({ search, setSearch, marketStats }) {
  const now = useClock();
  return (
    <header className="hdr">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-name">SAIRAS<span>//</span>PROBE</div>
        <div className="brand-build">v0.4.1 · build 8842</div>
      </div>

      <div className="hdr-stats">
        <span className="hdr-stat"><span className="dot dot-green pulse" /> RPC <b>helius·mainnet</b></span>
      </div>

      <div className="hdr-search">
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>›</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="search mint, wallet, dev, ticker — try DRIFT, mempool-king, 7Xk..."
        />
        <span className="kbd">/</span>
      </div>

      <div className="hdr-stats">
        <span className="hdr-stat">SOL <b>${marketStats.solPrice.toFixed(2)}</b> <span className={marketStats.solDelta >= 0 ? 'up' : 'down'}>
          {marketStats.solDelta >= 0 ? '+' : ''}{marketStats.solDelta.toFixed(2)}%
        </span></span>
        <span className="hdr-stat">launches/min <b>{marketStats.launchRate}</b></span>
        <span className="hdr-stat">migrating <b className="up">{marketStats.migrating}</b></span>
      </div>

      <div className="hdr-clock">{fmtClock(now)}</div>
    </header>
  );
}

// === Tabs ===
const TAB_DEFS = [
  { id: 'terminal', label: 'TERMINAL', desc: 'live token feed' },
  { id: 'token',    label: 'TOKEN',    desc: 'deep-dive' },
  { id: 'wallets',  label: 'WALLETS',  desc: 'intelligence' },
  { id: 'devs',     label: 'DEVS',     desc: 'developer scores' },
  { id: 'flow',     label: 'FLOW',     desc: 'smart money' },
  { id: 'alerts',   label: 'ALERTS',   desc: 'event stream' },
  { id: 'backtest', label: 'BACKTEST', desc: 'replay & validate' },
];

function Tabs({ active, onChange }) {
  return (
    <nav className="tabs">
      {TAB_DEFS.map((t, i) => (
        <div
          key={t.id}
          className={'tab' + (active === t.id ? ' active' : '')}
          onClick={() => onChange(t.id)}
        >
          <span className="idx">F{i+1}</span>
          <span>{t.label}</span>
          <span className="idx" style={{ marginLeft: 4 }}>{t.desc}</span>
        </div>
      ))}
    </nav>
  );
}

// === Status bar ===
function StatusBar({ wsLatency, ingestRate, snapshotsHeld, totalTokens, totalWallets, errors }) {
  const now = useClock();
  return (
    <footer className="statusbar">
      <span><span className={'dot ' + (wsLatency < 80 ? 'dot-green' : wsLatency < 200 ? 'dot-amber' : 'dot-red')} /> ws {wsLatency}ms</span>
      <span className="sep">│</span>
      <span>ingest <b>{ingestRate}</b> events/s</span>
      <span className="sep">│</span>
      <span>snapshots <b>{snapshotsHeld.toLocaleString()}</b></span>
      <span className="sep">│</span>
      <span>tokens <b>{totalTokens}</b></span>
      <span className="sep">│</span>
      <span>wallets <b>{totalWallets.toLocaleString()}</b></span>
      <span className="sep">│</span>
      <span>errors <b className={errors > 0 ? 'dn' : ''}>{errors}</b></span>
      <span className="right">
        <span>shift+? help</span>
        <span className="sep">│</span>
        <span>session {fmtClock(now).slice(0, 8)}</span>
      </span>
    </footer>
  );
}

// === Probability display (bar + value) ===
function ProbBar({ value, width = 60 }) {
  const tone = value >= 70 ? '' : value >= 40 ? 'mid' : 'lo';
  const valTone = value >= 70 ? 'hi' : value >= 40 ? 'mid' : 'lo';
  return (
    <span className="prob">
      <span className={'prob-bar ' + tone} style={{ width }}>
        <i style={{ width: value + '%' }} />
      </span>
      <span className={'prob-val ' + valTone}>{value.toFixed(1)}</span>
    </span>
  );
}

// === Sparkline (SVG) ===
function Sparkline({ data, width = 70, height = 20, stroke, fill = 'none' }) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  let d = '';
  data.forEach((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  });
  const last = data[data.length - 1];
  const first = data[0];
  const trend = last >= first ? 'var(--green)' : 'var(--red)';
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={d} fill={fill} stroke={stroke || trend} strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

// === Big line chart with axes (used in deep-dive) ===
function LineChart({ data, height = 160, color = 'var(--green)', label = '', yMin, yMax, suffix = '', annotations = [] }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 600, h: height });
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const cr = entries[0].contentRect;
      setSize({ w: cr.width, h: cr.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const padL = 36, padR = 8, padT = 8, padB = 18;
  const innerW = Math.max(10, w - padL - padR);
  const innerH = Math.max(10, h - padT - padB);

  const min = yMin != null ? yMin : Math.min(...data);
  const max = yMax != null ? yMax : Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = padL + (i / (data.length - 1)) * innerW;
    const y = padT + innerH - ((v - min) / range) * innerH;
    return { x, y, v, i };
  });

  const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const areaPath = path + ` L${points[points.length-1].x.toFixed(1)},${(padT+innerH).toFixed(1)} L${padL.toFixed(1)},${(padT+innerH).toFixed(1)} Z`;

  const onMove = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round(((x - padL) / innerW) * (data.length - 1));
    if (idx >= 0 && idx < data.length) setHover({ idx, x: points[idx].x, y: points[idx].y });
  };

  // Y ticks (3)
  const ticks = [0, 0.5, 1].map(t => {
    const v = min + range * t;
    const y = padT + innerH - t * innerH;
    return { v, y };
  });

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height: '100%' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {/* grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={padL+innerW} y2={t.y} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padL - 6} y={t.y + 3} textAnchor="end" fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)">
              {typeof t.v === 'number' ? (t.v >= 1000 ? fmtMC(t.v) : t.v.toFixed(0)) + suffix : t.v}
            </text>
          </g>
        ))}
        {/* x axis baseline */}
        <line x1={padL} y1={padT+innerH} x2={padL+innerW} y2={padT+innerH} stroke="var(--border-2)" />
        {/* area fill */}
        <path d={areaPath} fill={color} opacity="0.08" />
        {/* line */}
        <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        {/* annotations */}
        {annotations.map((a, i) => {
          const x = padL + (a.idx / (data.length - 1)) * innerW;
          return (
            <g key={i}>
              <line x1={x} y1={padT} x2={x} y2={padT+innerH} stroke={a.color || 'var(--amber)'} strokeDasharray="2 2" opacity="0.6" />
              <circle cx={x} cy={padT+innerH-((data[a.idx]-min)/range)*innerH} r="2.5" fill={a.color || 'var(--amber)'} />
              <text x={x + 4} y={padT + 10} fill={a.color || 'var(--amber)'} fontSize="9" fontFamily="var(--mono)">{a.label}</text>
            </g>
          );
        })}
        {/* hover crosshair */}
        {hover && (
          <g>
            <line x1={hover.x} y1={padT} x2={hover.x} y2={padT+innerH} stroke="var(--text-3)" strokeDasharray="2 2" />
            <circle cx={hover.x} cy={hover.y} r="3" fill={color} stroke="var(--bg)" strokeWidth="1" />
            <rect x={hover.x + 6} y={padT} width={70} height={32} fill="var(--bg)" stroke="var(--border-bright)" />
            <text x={hover.x + 12} y={padT + 13} fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)">t-{(data.length-1-hover.idx)}m</text>
            <text x={hover.x + 12} y={padT + 25} fill={color} fontSize="10" fontFamily="var(--mono)">
              {(data[hover.idx] >= 1000 ? fmtMC(data[hover.idx]) : data[hover.idx].toFixed(1)) + suffix}
            </text>
          </g>
        )}
        {/* label */}
        {label && <text x={padL + 4} y={padT + 11} fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)" letterSpacing="1">{label.toUpperCase()}</text>}
      </svg>
    </div>
  );
}

// === Panel wrapper ===
function Panel({ title, right, children, bodyClass = '', style }) {
  return (
    <div className="panel" style={style}>
      <div className="panel-hdr">
        <span className="title">{title}</span>
        {right && <div className="right">{right}</div>}
      </div>
      <div className={'panel-body ' + bodyClass}>
        {children}
      </div>
    </div>
  );
}

// === Class badge ===
function ClassBadge({ cls }) {
  return <span className={'badge ' + (cls.tone || '')}>{cls.label}</span>;
}

// === Donut score ===
function ScoreDonut({ value, label = 'SCORE', size = 80 }) {
  const col = value >= 70 ? 'var(--green)' : value >= 40 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="donut" style={{ width: size, height: size, '--p': value, '--col': col }}>
      <div>
        <b>{Math.round(value)}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

// === Helper: classify wallet score color ===
function scoreClass(v) {
  if (v >= 70) return 'up';
  if (v >= 45) return '';
  return 'dn';
}

Object.assign(window, {
  useClock, Header, Tabs, StatusBar, ProbBar, Sparkline, LineChart, Panel, ClassBadge, ScoreDonut, scoreClass, TAB_DEFS,
});
