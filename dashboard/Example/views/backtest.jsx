// backtest.jsx — Historical replay & validation view

const BacktestView = ({ onSelectToken }) => {
  const [token, setToken] = React.useState(() => tokens.find(t => t.phase === 'PUMPSWAP') || FEATURED_TOKEN);
  const [scrub, setScrub] = React.useState(token.probHistory.length - 1);
  const [playing, setPlaying] = React.useState(false);
  const [playSpeed, setPlaySpeed] = React.useState(2);

  React.useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setScrub(s => {
        if (s >= token.probHistory.length - 1) { setPlaying(false); return s; }
        return s + 1;
      });
    }, 1000 / playSpeed);
    return () => clearInterval(id);
  }, [playing, playSpeed, token]);

  const probAtT = token.probHistory[scrub];
  const mcAtT = token.mcHistory[scrub];
  const minutesAgo = token.probHistory.length - 1 - scrub;

  // model performance (synthetic backtest stats)
  const stats = {
    samples: 12_804,
    migrationHitRate: 0.41,
    avgRReached: 2.34,
    falsePositive: 0.18,
    avgLeadTime: 47, // seconds
  };

  // brier-ish calibration data
  const calibration = [
    { bucket: '0-10%', predicted: 5, actual: 6.2, count: 2148 },
    { bucket: '10-20%', predicted: 15, actual: 17.8, count: 1822 },
    { bucket: '20-30%', predicted: 25, actual: 24.1, count: 1604 },
    { bucket: '30-40%', predicted: 35, actual: 32.4, count: 1390 },
    { bucket: '40-50%', predicted: 45, actual: 47.6, count: 1240 },
    { bucket: '50-60%', predicted: 55, actual: 53.9, count: 1090 },
    { bucket: '60-70%', predicted: 65, actual: 68.2, count: 940 },
    { bucket: '70-80%', predicted: 75, actual: 74.1, count: 822 },
    { bucket: '80-90%', predicted: 85, actual: 89.3, count: 540 },
    { bucket: '90-100%', predicted: 95, actual: 92.0, count: 208 },
  ];

  // signal events along the timeline
  const events = [
    { idx: 12, lbl: 'launch', color: 'var(--text-3)' },
    { idx: 24, lbl: 'first smart wallet', color: 'var(--green)' },
    { idx: 32, lbl: '2 elite buyers', color: 'var(--green)' },
    { idx: 40, lbl: 'holder breakout', color: 'var(--green)' },
    { idx: 50, lbl: 'migration', color: 'var(--amber)' },
    { idx: 56, lbl: 'distribution', color: 'var(--red)' },
  ].filter(e => e.idx < token.probHistory.length);

  return (
    <div className="view" style={{ display: 'grid', gridTemplateRows: 'auto auto 1fr', height: '100%', background: 'var(--bg)' }}>
      {/* HEADER */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)' }}>
        <div>
          <div className="ascii-h">BACKTEST · REPLAY</div>
          <div style={{ fontSize: 16, marginTop: 4 }}>
            replaying <b className="fg">${token.symbol}</b> <span className="dim">· {token.name}</span>
          </div>
        </div>
        <div className="seg">
          {tokens.filter(t => t.phase === 'PUMPSWAP' || t.phase === 'DEAD' || t.phase === 'MIGRATING').slice(0, 6).map(t => (
            <button key={t.mint} className={token.mint === t.mint ? 'active' : ''} onClick={() => { setToken(t); setScrub(t.probHistory.length - 1); }}>${t.symbol}</button>
          ))}
        </div>
      </div>

      {/* PLAYBACK CONTROLS */}
      <div style={{ padding: '10px 16px', background: 'var(--bg-1)', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'auto auto 1fr auto auto auto', gap: 14, alignItems: 'center' }}>
        <button onClick={() => setPlaying(!playing)} style={{ padding: '6px 14px', border: '1px solid ' + (playing ? 'var(--green-dim)' : 'var(--border)'), color: playing ? 'var(--green)' : 'var(--text)', fontSize: 12 }}>
          {playing ? '❚❚ PAUSE' : '▶ PLAY'}
        </button>
        <button onClick={() => { setPlaying(false); setScrub(0); }} style={{ padding: '6px 10px', fontSize: 10 }}>↩ RESTART</button>

        {/* SCRUBBER */}
        <div style={{ position: 'relative', height: 36 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 16, height: 4, background: 'var(--bg-3)', border: '1px solid var(--border)' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: (scrub / (token.probHistory.length - 1)) * 100 + '%', background: 'var(--green)' }} />
          </div>
          {events.map((e, i) => (
            <div key={i} style={{ position: 'absolute', left: (e.idx / (token.probHistory.length - 1)) * 100 + '%', top: 8, transform: 'translateX(-50%)' }}>
              <div style={{ width: 1, height: 18, background: e.color, opacity: 0.7 }} />
              <div style={{ fontSize: 8, color: e.color, position: 'absolute', top: 22, left: -20, width: 60, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{e.lbl}</div>
            </div>
          ))}
          <input
            type="range"
            min="0"
            max={token.probHistory.length - 1}
            value={scrub}
            onChange={e => { setPlaying(false); setScrub(+e.target.value); }}
            style={{ position: 'absolute', left: 0, right: 0, top: 8, width: '100%', opacity: 0.001, height: 20, cursor: 'pointer' }}
          />
          <div style={{ position: 'absolute', left: (scrub / (token.probHistory.length - 1)) * 100 + '%', top: 4, transform: 'translateX(-50%)', pointerEvents: 'none' }}>
            <div style={{ width: 2, height: 28, background: 'var(--text)', boxShadow: '0 0 6px var(--text)' }} />
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="dim" style={{ fontSize: 9 }}>T-{minutesAgo}m</div>
          <div style={{ fontSize: 14 }}>{scrub + 1}/{token.probHistory.length}</div>
        </div>

        <div className="seg">
          {[1, 2, 4, 8].map(s => (
            <button key={s} className={playSpeed === s ? 'active' : ''} onClick={() => setPlaySpeed(s)}>{s}×</button>
          ))}
        </div>

        <button onClick={() => onSelectToken(token)} style={{ padding: '4px 10px', fontSize: 10 }}>open token →</button>
      </div>

      {/* MAIN BODY */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)', minHeight: 0 }}>
        {/* LEFT: probability + MC at this moment */}
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr 1fr', gap: 1, background: 'var(--border)', minHeight: 0 }}>
          <div style={{ padding: 14, background: 'var(--bg-1)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14 }}>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>P AT T-{minutesAgo}m</div>
              <div className={probAtT >= 70 ? 'up' : probAtT >= 40 ? '' : 'dn'} style={{ fontSize: 28, fontWeight: 500 }}>{probAtT.toFixed(1)}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>MC AT T-{minutesAgo}m</div>
              <div style={{ fontSize: 24 }}>${fmtMC(mcAtT)}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>FINAL MC</div>
              <div className={token.mc > mcAtT ? 'up' : 'dn'} style={{ fontSize: 18 }}>${fmtMC(token.mc)}</div>
              <div className={token.mc > mcAtT ? 'up' : 'dn'} style={{ fontSize: 10 }}>{((token.mc / mcAtT - 1) * 100).toFixed(1)}% from here</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 10 }}>OUTCOME</div>
              <span className={'badge ' + (token.phase === 'PUMPSWAP' ? 'g' : token.phase === 'DEAD' ? 'r' : 'a')}>{token.phase === 'PUMPSWAP' ? 'MIGRATED' : token.phase === 'DEAD' ? 'FAILED' : token.phase}</span>
            </div>
          </div>

          <Panel title="PROBABILITY · history">
            <div style={{ padding: 8, flex: 1 }}>
              <LineChart
                data={token.probHistory.slice(0, scrub + 1)}
                color="var(--green)"
                yMin={0} yMax={100}
                suffix="%"
                annotations={events.filter(e => e.idx <= scrub).map(e => ({ idx: e.idx, label: e.lbl, color: e.color }))}
              />
            </div>
          </Panel>

          <Panel title="MARKET CAP · history">
            <div style={{ padding: 8, flex: 1 }}>
              <LineChart
                data={token.mcHistory.slice(0, scrub + 1)}
                color="var(--text-2)"
              />
            </div>
          </Panel>
        </div>

        {/* RIGHT: model validation */}
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 1, background: 'var(--border)', minHeight: 0 }}>
          <div style={{ padding: 14, background: 'var(--bg-1)' }}>
            <div className="ascii-h">MODEL VALIDATION · 30d sample</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 12 }}>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>SAMPLES</div>
                <div style={{ fontSize: 22 }}>{stats.samples.toLocaleString()}</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>MIGRATION HIT RATE</div>
                <div className="up" style={{ fontSize: 22 }}>{(stats.migrationHitRate * 100).toFixed(0)}%</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>AVG R MULT.</div>
                <div className="up" style={{ fontSize: 22 }}>{stats.avgRReached.toFixed(2)}×</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>FALSE POSITIVE</div>
                <div className="dn" style={{ fontSize: 14 }}>{(stats.falsePositive * 100).toFixed(0)}%</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>AVG LEAD TIME</div>
                <div style={{ fontSize: 14 }}>{stats.avgLeadTime}s</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>BRIER</div>
                <div className="up" style={{ fontSize: 14 }}>0.142</div>
              </div>
            </div>
          </div>

          <Panel title="CALIBRATION · predicted vs. actual" bodyClass="p">
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 8 }}>perfectly calibrated → diagonal line</div>
            <CalibrationChart data={calibration} />
            <div style={{ marginTop: 12 }}>
              {calibration.map((c, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 50px 50px', gap: 8, padding: '3px 0', fontSize: 11, alignItems: 'center', borderBottom: '1px dashed var(--border)' }}>
                  <span className="dim">{c.bucket}</span>
                  <div style={{ height: 4, background: 'var(--bg-3)', position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: c.actual + '%', background: Math.abs(c.predicted - c.actual) < 3 ? 'var(--green)' : 'var(--amber)' }} />
                  </div>
                  <span className="tar">{c.actual.toFixed(1)}%</span>
                  <span className="tar dim">n={c.count}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
};

const CalibrationChart = ({ data }) => {
  const W = 200, H = 120, pad = 18;
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', maxWidth: 300 }}>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--border-2)" />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="var(--border-2)" />
      {/* diagonal reference */}
      <line x1={pad} y1={H - pad} x2={W - pad} y2={pad} stroke="var(--text-3)" strokeDasharray="2 2" />
      {/* data points */}
      {data.map((d, i) => {
        const x = pad + (d.predicted / 100) * (W - 2 * pad);
        const y = (H - pad) - (d.actual / 100) * (H - 2 * pad);
        return <circle key={i} cx={x} cy={y} r="2.5" fill="var(--green)" />;
      })}
      {data.length > 1 && (
        <path
          d={data.map((d, i) => {
            const x = pad + (d.predicted / 100) * (W - 2 * pad);
            const y = (H - pad) - (d.actual / 100) * (H - 2 * pad);
            return (i === 0 ? 'M' : 'L') + x + ',' + y;
          }).join(' ')}
          stroke="var(--green)"
          strokeWidth="1"
          fill="none"
        />
      )}
      <text x={pad} y={pad - 4} fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)">100%</text>
      <text x={W - pad} y={H - 4} fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)" textAnchor="end">predicted</text>
    </svg>
  );
};

window.BacktestView = BacktestView;
