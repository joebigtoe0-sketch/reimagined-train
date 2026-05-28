// devs.jsx — Developer scorecard view

const DevsView = ({ selectedDev, onSelect, onSelectToken, search }) => {
  const [sortKey, setSortKey] = React.useState('score');
  const [sortDir, setSortDir] = React.useState('desc');

  const filtered = React.useMemo(() => {
    let arr = devs.filter(d => {
      if (search) {
        const s = search.toLowerCase();
        if (!d.addr.toLowerCase().includes(s) && !(d.alias || '').toLowerCase().includes(s)) return false;
      }
      return true;
    });
    arr.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const r = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? r : -r;
    });
    return arr;
  }, [sortKey, sortDir, search]);

  const setSort = (k) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  const sortIcon = (k) => sortKey === k ? (sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';

  const dev = selectedDev || filtered[0];

  return (
    <div className="view" style={{ display: 'grid', gridTemplateColumns: '1fr 460px', gap: 1, background: 'var(--border)', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
        <div className="filterbar">
          <span className="ascii-h">DEVELOPER INTELLIGENCE</span>
          <span className="muted">·</span>
          <span className="muted">{filtered.length} devs tracked · {devs.reduce((s, d) => s + d.launches, 0)} total launches</span>
          <div className="spacer" />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>DEV WALLET</th>
                <th onClick={() => setSort('score')} className={sortIcon('score') + ' right'} style={{ textAlign: 'right', width: 70 }}>SCORE</th>
                <th onClick={() => setSort('launches')} className={sortIcon('launches') + ' right'} style={{ textAlign: 'right', width: 70 }}>LAUNCH</th>
                <th onClick={() => setSort('migrations')} className={sortIcon('migrations') + ' right'} style={{ textAlign: 'right', width: 80 }}>MIGRATE</th>
                <th style={{ textAlign: 'right', width: 60 }}>RUGS</th>
                <th onClick={() => setSort('medianATH')} className={sortIcon('medianATH') + ' right'} style={{ textAlign: 'right', width: 90 }}>MED. ATH</th>
                <th onClick={() => setSort('avgLifespanHrs')} className={sortIcon('avgLifespanHrs') + ' right'} style={{ textAlign: 'right', width: 80 }}>LIFESPAN</th>
                <th onClick={() => setSort('elitOverlap')} className={sortIcon('elitOverlap') + ' right'} style={{ textAlign: 'right', width: 100 }}>ELITE BUYS</th>
                <th style={{ textAlign: 'right', width: 70 }}>HOLDER↗</th>
                <th>FLAGS</th>
                <th onClick={() => setSort('lastLaunchHrs')} className={sortIcon('lastLaunchHrs') + ' right'} style={{ textAlign: 'right', width: 80 }}>LAST</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => {
                const migRate = (d.migrations / d.launches) * 100;
                return (
                  <tr key={d.addr} onClick={() => onSelect(d)} className={selectedDev && selectedDev.addr === d.addr ? 'selected' : ''}>
                    <td className="dim">{String(i + 1).padStart(3, '0')}</td>
                    <td>
                      <div className="tick">
                        <span className="sym">{d.alias || shortAddr(d.addr)}</span>
                        {d.alias && <span className="ca">{shortAddr(d.addr)}</span>}
                      </div>
                    </td>
                    <td className={'right ' + scoreClass(d.score)}>{d.score}</td>
                    <td className="right">{d.launches}</td>
                    <td className={'right ' + (migRate >= 30 ? 'up' : migRate < 10 ? 'dn' : 'dim')}>{d.migrations} <span className="dim" style={{ fontSize: 10 }}>({migRate.toFixed(0)}%)</span></td>
                    <td className={'right ' + (d.rugs > 2 ? 'dn' : 'dim')}>{d.rugs}</td>
                    <td className="right">${fmtMC(d.medianATH)}</td>
                    <td className="right dim">{d.avgLifespanHrs < 1 ? (d.avgLifespanHrs * 60).toFixed(0) + 'm' : d.avgLifespanHrs.toFixed(1) + 'h'}</td>
                    <td className={'right ' + (d.elitOverlap > 3 ? 'up' : 'dim')}>{d.elitOverlap}</td>
                    <td className="right">+{d.holderGrowth.toFixed(1)}</td>
                    <td>
                      <span style={{ display: 'flex', gap: 4 }}>
                        {d.devSellFlag && <span className="badge r">DEV-SELL</span>}
                        {d.insiderCluster && <span className="badge r">CLUSTER</span>}
                        {d.score >= 80 && <span className="badge g">TRUSTED</span>}
                      </span>
                    </td>
                    <td className="right dim">{d.lastLaunchHrs < 1 ? (d.lastLaunchHrs * 60).toFixed(0) + 'm' : d.lastLaunchHrs.toFixed(1) + 'h'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* DEV PROFILE */}
      <DevProfile dev={dev} onSelectToken={onSelectToken} />
    </div>
  );
};

const DevProfile = ({ dev, onSelectToken }) => {
  if (!dev) return null;

  // synth launch history with outcomes
  const launches = React.useMemo(() => {
    const out = [];
    const seed = dev.addr.charCodeAt(0) + dev.launches;
    for (let i = 0; i < dev.launches; i++) {
      let outcome;
      if (i < dev.migrations) outcome = 'migrate';
      else if (i < dev.migrations + dev.rugs) outcome = 'rug';
      else outcome = ((seed + i) % 3) === 0 ? 'fade' : 'flop';
      const ath = outcome === 'migrate' ? 90000 + ((seed + i * 17) % 600000)
        : outcome === 'rug' ? 5000 + ((seed + i * 23) % 30000)
        : 8000 + ((seed + i * 13) % 60000);
      out.push({
        symbol: ['DRIFT', 'BORK', 'NEONCAT', 'PUMPV2', 'WIFAI', 'GIGAINU', 'CHADX', 'COPELAND', 'MOONMAX', 'ECHO'][i % 10] + (i > 9 ? i : ''),
        outcome,
        ath,
        ageDaysAgo: i * 3 + ((seed + i) % 4),
        lifespanHrs: outcome === 'migrate' ? 24 + ((seed + i * 7) % 200) : 0.5 + ((seed + i) % 20),
      });
    }
    return out;
  }, [dev.addr]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <ScoreDonut value={dev.score} size={84} label="DEV SCORE" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>DEVELOPER</div>
            {dev.alias && <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 2 }}>{dev.alias}</div>}
            <div style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text-2)', marginBottom: 8 }}>{dev.addr}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {dev.score >= 80 && <span className="badge g">TRUSTED</span>}
              {dev.score < 35 && <span className="badge r">AVOID</span>}
              {dev.devSellFlag && <span className="badge r">DEV-SELL HISTORY</span>}
              {dev.insiderCluster && <span className="badge r">INSIDER CLUSTER</span>}
              {dev.elitOverlap > 3 && <span className="badge g">ELITE FOLLOWED</span>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div className="ascii-h" style={{ marginBottom: 10 }}>TRACK RECORD</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>LAUNCHES</div>
            <div style={{ fontSize: 22 }}>{dev.launches}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>MIGRATION RATE</div>
            <div className={dev.migrations / dev.launches > 0.3 ? 'up' : ''} style={{ fontSize: 22 }}>{((dev.migrations / dev.launches) * 100).toFixed(0)}%</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>RUG RATE</div>
            <div className={dev.rugs / dev.launches > 0.2 ? 'dn' : ''} style={{ fontSize: 22 }}>{((dev.rugs / dev.launches) * 100).toFixed(0)}%</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>MEDIAN ATH</div>
            <div style={{ fontSize: 14 }}>${fmtMC(dev.medianATH)}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>REPEAT BUYERS</div>
            <div style={{ fontSize: 14 }}>{dev.repeatBuyers}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>ELITE OVERLAP</div>
            <div className="up" style={{ fontSize: 14 }}>{dev.elitOverlap} wallets</div>
          </div>
        </div>
      </div>

      <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div className="ascii-h" style={{ marginBottom: 8 }}>OUTCOME DISTRIBUTION</div>
        <div style={{ display: 'flex', height: 24, border: '1px solid var(--border)' }}>
          <div style={{ flex: dev.migrations, background: 'var(--green)', position: 'relative' }} title={dev.migrations + ' migrations'}>
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#000' }}>{dev.migrations}</span>
          </div>
          <div style={{ flex: dev.rugs, background: 'var(--red)', position: 'relative' }} title={dev.rugs + ' rugs'}>
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#000' }}>{dev.rugs}</span>
          </div>
          <div style={{ flex: dev.launches - dev.migrations - dev.rugs, background: 'var(--bg-3)', position: 'relative' }} title="faded">
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--text-2)' }}>{dev.launches - dev.migrations - dev.rugs}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
          <span><i style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--green)', marginRight: 4 }} /> migrated</span>
          <span><i style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', marginRight: 4 }} /> rugged</span>
          <span><i style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--bg-3)', marginRight: 4 }} /> faded</span>
        </div>
      </div>

      <div style={{ padding: 0, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '12px 14px 6px' }}><div className="ascii-h">LAUNCH HISTORY</div></div>
        <table className="tbl">
          <thead>
            <tr>
              <th>TICKER</th>
              <th>OUTCOME</th>
              <th style={{ textAlign: 'right' }}>ATH</th>
              <th style={{ textAlign: 'right' }}>LIFE</th>
              <th style={{ textAlign: 'right' }}>AGE</th>
            </tr>
          </thead>
          <tbody>
            {launches.map((l, i) => (
              <tr key={i}>
                <td>${l.symbol}</td>
                <td>
                  <span className={'badge ' + (l.outcome === 'migrate' ? 'g' : l.outcome === 'rug' ? 'r' : '')}>
                    {l.outcome.toUpperCase()}
                  </span>
                </td>
                <td className={'right ' + (l.outcome === 'migrate' ? 'up' : l.outcome === 'rug' ? 'dn' : 'dim')}>${fmtMC(l.ath)}</td>
                <td className="right dim">{l.lifespanHrs < 1 ? (l.lifespanHrs * 60).toFixed(0) + 'm' : l.lifespanHrs.toFixed(0) + 'h'}</td>
                <td className="right dim">{l.ageDaysAgo}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

window.DevsView = DevsView;
