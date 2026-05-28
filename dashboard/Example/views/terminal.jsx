// terminal.jsx — Live token feed (main landing view)

const TerminalView = ({ onSelectToken, search, liveTokens, lastTick }) => {
  const [sortKey, setSortKey] = React.useState('prob');
  const [sortDir, setSortDir] = React.useState('desc');
  const [phaseFilter, setPhaseFilter] = React.useState('ALL');
  const [minProb, setMinProb] = React.useState(0);
  const [onlySmart, setOnlySmart] = React.useState(false);

  const sorted = React.useMemo(() => {
    let arr = liveTokens.filter(t => {
      if (phaseFilter !== 'ALL' && t.phase !== phaseFilter) return false;
      if (t.prob < minProb) return false;
      if (onlySmart && t.smartCount < 2) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!t.symbol.toLowerCase().includes(s) && !t.name.toLowerCase().includes(s) && !t.mint.toLowerCase().includes(s) && !(t.dev.alias || '').toLowerCase().includes(s)) return false;
      }
      return true;
    });
    arr.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const r = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? r : -r;
    });
    return arr;
  }, [liveTokens, sortKey, sortDir, phaseFilter, minProb, onlySmart, search]);

  const setSort = (k) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const sortIcon = (k) => sortKey === k ? (sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';

  // sidebar: top movers (highest prob change in last 5 min)
  const movers = React.useMemo(() => {
    return [...liveTokens]
      .map(t => ({ t, delta: t.prob - (t.probHistory[t.probHistory.length - 6] || t.prob) }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 8);
  }, [liveTokens]);

  const losers = React.useMemo(() => {
    return [...liveTokens]
      .map(t => ({ t, delta: t.prob - (t.probHistory[t.probHistory.length - 6] || t.prob) }))
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 6);
  }, [liveTokens]);

  return (
    <div className="view" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 1, background: 'var(--border)', height: '100%' }}>
      {/* main table */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
        <div className="filterbar">
          <span className="ascii-h">LIVE TOKEN FEED</span>
          <span className="muted">·</span>
          <label>phase</label>
          <div className="seg">
            {['ALL', 'LAUNCH', 'CURVE', 'MIGRATING', 'PUMPSWAP'].map(p => (
              <button key={p} className={phaseFilter === p ? 'active' : ''} onClick={() => setPhaseFilter(p)}>{p}</button>
            ))}
          </div>
          <label>min P</label>
          <div className="seg">
            {[0, 40, 60, 75].map(v => (
              <button key={v} className={minProb === v ? 'active' : ''} onClick={() => setMinProb(v)}>{v === 0 ? 'any' : v + '%'}</button>
            ))}
          </div>
          <button className={onlySmart ? 'seg-active' : ''} onClick={() => setOnlySmart(!onlySmart)} style={{
            padding: '3px 9px',
            background: onlySmart ? 'var(--green-bg)' : 'transparent',
            color: onlySmart ? 'var(--green)' : 'var(--text-3)',
            border: '1px solid ' + (onlySmart ? 'var(--green-dim)' : 'var(--border)'),
            fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>{onlySmart ? '✓' : '·'} smart money ≥ 2</button>
          <div className="spacer" />
          <span className="muted">{sorted.length}/{liveTokens.length} tokens</span>
          <span className="muted">·</span>
          <span style={{ color: 'var(--green)' }}>live <span className="dot dot-green pulse" /></span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th onClick={() => setSort('ageMin')} className={sortIcon('ageMin')} style={{ width: 60 }}>AGE</th>
                <th>TICKER</th>
                <th style={{ width: 110 }}>PHASE</th>
                <th onClick={() => setSort('mc')} className={sortIcon('mc') + ' right'} style={{ textAlign: 'right' }}>MC</th>
                <th onClick={() => setSort('volume24h')} className={sortIcon('volume24h') + ' right'} style={{ textAlign: 'right' }}>VOL/24h</th>
                <th onClick={() => setSort('holders')} className={sortIcon('holders') + ' right'} style={{ textAlign: 'right' }}>HOLDERS</th>
                <th style={{ width: 90, textAlign: 'right' }}>HOLD/MIN</th>
                <th onClick={() => setSort('smartCount')} className={sortIcon('smartCount') + ' right'} style={{ textAlign: 'right', width: 80 }}>SMART</th>
                <th style={{ textAlign: 'right', width: 80 }}>NET SOL</th>
                <th style={{ textAlign: 'right', width: 80 }}>INSIDER%</th>
                <th>DEV</th>
                <th onClick={() => setSort('prob')} className={sortIcon('prob')} style={{ width: 140 }}>PROBABILITY ↑</th>
                <th style={{ width: 80 }}>5m TREND</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const flash = lastTick && lastTick[t.mint];
                return (
                  <tr key={t.mint} onClick={() => onSelectToken(t)} className={flash === 'up' ? 'flash-up' : flash === 'dn' ? 'flash-dn' : ''}>
                    <td className="dim">{String(i + 1).padStart(3, '0')}</td>
                    <td className="dim">{fmtAge(t.ageMin)}</td>
                    <td>
                      <div className="tick">
                        <span className="sym">${t.symbol}</span>
                        <span className="ca">{shortAddr(t.mint)}</span>
                      </div>
                    </td>
                    <td>
                      <span className={'badge ' + (t.phase === 'MIGRATING' ? 'a' : t.phase === 'PUMPSWAP' ? 'g' : t.phase === 'DEAD' ? 'r' : '')}>{t.phase}</span>
                    </td>
                    <td className="right">${fmtMC(t.mc)}</td>
                    <td className="right dim">${fmtMC(t.volume24h)}</td>
                    <td className="right">{t.holders.toLocaleString()}</td>
                    <td className={'right ' + (t.holderGrowth > 1 ? 'up' : t.holderGrowth < 0.2 ? 'dn' : 'dim')}>
                      {t.holderGrowth >= 0 ? '+' : ''}{t.holderGrowth.toFixed(1)}
                    </td>
                    <td className={'right ' + (t.smartCount >= 3 ? 'up' : t.smartCount === 0 ? 'dim' : '')}>{t.smartCount}</td>
                    <td className={'right ' + (t.smartNetFlow > 0 ? 'up' : t.smartNetFlow < 0 ? 'dn' : 'dim')}>
                      {t.smartNetFlow >= 0 ? '+' : ''}{t.smartNetFlow}
                    </td>
                    <td className={'right ' + (t.insiderConc > 0.3 ? 'dn' : t.insiderConc < 0.1 ? 'up' : 'dim')}>
                      {(t.insiderConc * 100).toFixed(0)}%
                    </td>
                    <td className="dim">
                      {t.dev.alias || shortAddr(t.dev.addr)}
                      <span style={{ marginLeft: 6, fontSize: 10 }} className={t.dev.score >= 70 ? 'up' : t.dev.score < 35 ? 'dn' : 'dim'}>
                        {t.dev.score}
                      </span>
                    </td>
                    <td><ProbBar value={t.prob} /></td>
                    <td><Sparkline data={t.probHistory.slice(-12)} width={70} height={18} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* sidebar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--border)', minHeight: 0, overflow: 'hidden' }}>
        <Panel title="▲ TOP PROBABILITY MOVERS · 5m" bodyClass="p" style={{ minHeight: 0 }}>
          {movers.map(({ t, delta }) => (
            <div key={t.mint} onClick={() => onSelectToken(t)} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', alignItems: 'center', fontSize: 12 }}>
              <div>
                <div className="fg">${t.symbol}</div>
                <div className="dim" style={{ fontSize: 10 }}>{t.phase} · ${fmtMC(t.mc)}</div>
              </div>
              <Sparkline data={t.probHistory.slice(-10)} width={40} height={14} />
              <div style={{ textAlign: 'right' }}>
                <div className={delta >= 0 ? 'up' : 'dn'} style={{ fontWeight: 500 }}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}</div>
                <div className="dim" style={{ fontSize: 10 }}>P={t.prob.toFixed(0)}</div>
              </div>
            </div>
          ))}
        </Panel>

        <Panel title="▼ DEGRADING TOKENS" bodyClass="p" style={{ minHeight: 0 }}>
          {losers.map(({ t, delta }) => (
            <div key={t.mint} onClick={() => onSelectToken(t)} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', alignItems: 'center', fontSize: 12 }}>
              <div>
                <div className="fg">${t.symbol}</div>
                <div className="dim" style={{ fontSize: 10 }}>{t.phase} · ${fmtMC(t.mc)}</div>
              </div>
              <div className="dn" style={{ fontWeight: 500 }}>{delta.toFixed(1)}</div>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
};

window.TerminalView = TerminalView;
