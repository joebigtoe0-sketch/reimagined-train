// alerts.jsx — Alert feed view

const AlertsView = ({ onSelectToken, liveAlerts }) => {
  const [toneFilter, setToneFilter] = React.useState('ALL');
  const [paused, setPaused] = React.useState(false);

  const filtered = React.useMemo(() => {
    return liveAlerts.filter(a => toneFilter === 'ALL' || a.tone === toneFilter);
  }, [liveAlerts, toneFilter]);

  // count per tone
  const counts = React.useMemo(() => {
    const c = { good: 0, warn: 0, crit: 0 };
    liveAlerts.forEach(a => c[a.tone]++);
    return c;
  }, [liveAlerts]);

  // rule library (configurable)
  const rules = [
    { id: 'r1', name: 'Elite wallet entry < 10k MC', tone: 'good', active: true, hits: 142 },
    { id: 'r2', name: 'Smart wallet accumulation (3+ in 90s)', tone: 'good', active: true, hits: 88 },
    { id: 'r3', name: 'High-rep dev launch', tone: 'good', active: true, hits: 34 },
    { id: 'r4', name: 'Probability crossed 75%', tone: 'good', active: true, hits: 19 },
    { id: 'r5', name: 'Probability crossed 90%', tone: 'good', active: true, hits: 4 },
    { id: 'r6', name: 'Insider concentration > 30%', tone: 'warn', active: true, hits: 211 },
    { id: 'r7', name: 'Smart wallet distribution', tone: 'warn', active: true, hits: 67 },
    { id: 'r8', name: 'Wallet cluster sync entry', tone: 'warn', active: true, hits: 23 },
    { id: 'r9', name: 'Dev sold > 20%', tone: 'crit', active: true, hits: 11 },
    { id: 'r10', name: 'Probability collapse > 25pp/60s', tone: 'crit', active: true, hits: 7 },
    { id: 'r11', name: 'Migration approaching (>90% curve)', tone: 'good', active: true, hits: 26 },
    { id: 'r12', name: 'Top holder > 15% of supply', tone: 'warn', active: false, hits: 0 },
  ];

  return (
    <div className="view" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 1, background: 'var(--border)', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
        <div className="filterbar">
          <span className="ascii-h">ALERT STREAM</span>
          <span className="muted">·</span>
          <div className="seg">
            <button className={toneFilter === 'ALL' ? 'active' : ''} onClick={() => setToneFilter('ALL')}>all <span className="dim">{liveAlerts.length}</span></button>
            <button className={toneFilter === 'good' ? 'active' : ''} onClick={() => setToneFilter('good')} style={{ color: 'var(--green)' }}>signal <span className="dim">{counts.good}</span></button>
            <button className={toneFilter === 'warn' ? 'active' : ''} onClick={() => setToneFilter('warn')} style={{ color: 'var(--amber)' }}>warn <span className="dim">{counts.warn}</span></button>
            <button className={toneFilter === 'crit' ? 'active' : ''} onClick={() => setToneFilter('crit')} style={{ color: 'var(--red)' }}>crit <span className="dim">{counts.crit}</span></button>
          </div>
          <div className="spacer" />
          <button onClick={() => setPaused(!paused)} style={{ padding: '3px 10px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {paused ? '▶ resume' : '❚❚ pause'}
          </button>
          <span className={paused ? 'muted' : 'up'} style={{ fontSize: 10 }}>{paused ? 'PAUSED' : 'LIVE'} <span className={'dot ' + (paused ? 'dot-dim' : 'dot-green pulse')} /></span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {filtered.map((a, i) => (
            <div key={a.id + '-' + i} className={'alert ' + a.tone} onClick={() => onSelectToken(a.token)}>
              <span className="time">{fmtSec(a.secondsAgo)}</span>
              <span className="iconbox">{a.icon}</span>
              <span className="msg">{a.msg}</span>
              <span className="meta">{a.token.phase} · ${fmtMC(a.token.mc)} · P {a.token.prob.toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT: rules + stats */}
      <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
          <div className="ascii-h">SESSION SUMMARY</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>SIGNAL</div>
              <div className="up" style={{ fontSize: 22 }}>{counts.good}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>WARN</div>
              <div style={{ fontSize: 22, color: 'var(--amber)' }}>{counts.warn}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>CRIT</div>
              <div className="dn" style={{ fontSize: 22 }}>{counts.crit}</div>
            </div>
          </div>
          <div className="dim" style={{ fontSize: 10, marginTop: 12 }}>since session start · {fmtSec(liveAlerts[liveAlerts.length-1]?.secondsAgo || 0)} ago</div>
        </div>

        <div style={{ padding: 14, flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div className="ascii-h" style={{ marginBottom: 10 }}>ALERT RULES · {rules.filter(r => r.active).length}/{rules.length} active</div>
          {rules.map(r => (
            <div key={r.id} style={{
              padding: '8px 10px',
              borderBottom: '1px solid var(--border)',
              display: 'grid',
              gridTemplateColumns: '20px 1fr auto',
              alignItems: 'center',
              gap: 10,
              fontSize: 11,
            }}>
              <span style={{
                width: 14, height: 14,
                border: '1px solid ' + (r.active ? (r.tone === 'good' ? 'var(--green-dim)' : r.tone === 'crit' ? 'var(--red-dim)' : 'var(--amber-dim)') : 'var(--border)'),
                background: r.active ? (r.tone === 'good' ? 'var(--green-bg)' : r.tone === 'crit' ? 'var(--red-bg)' : 'rgba(214,178,96,0.1)') : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: r.tone === 'good' ? 'var(--green)' : r.tone === 'crit' ? 'var(--red)' : 'var(--amber)',
                fontSize: 10,
              }}>{r.active ? '✓' : ''}</span>
              <div>
                <div className={r.active ? 'fg' : 'dim'}>{r.name}</div>
                <div className="dim" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{r.tone} · {r.hits} hits today</div>
              </div>
              <button style={{ padding: '2px 6px', fontSize: 9, color: 'var(--text-3)' }}>edit</button>
            </div>
          ))}
        </div>

        <div style={{ padding: 10, borderTop: '1px solid var(--border)', textAlign: 'center' }}>
          <button style={{ padding: '5px 12px', fontSize: 10, color: 'var(--green)', borderColor: 'var(--green-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>+ new rule</button>
        </div>
      </div>
    </div>
  );
};

window.AlertsView = AlertsView;
