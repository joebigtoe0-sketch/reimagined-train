// wallets.jsx — Wallet intelligence view (list + profile)

const WalletsView = ({ selectedWallet, onSelect, search }) => {
  const [classFilter, setClassFilter] = React.useState('ALL');
  const [sortKey, setSortKey] = React.useState('score');
  const [sortDir, setSortDir] = React.useState('desc');

  const filtered = React.useMemo(() => {
    let arr = wallets.filter(w => {
      if (classFilter !== 'ALL' && w.cls.id !== classFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!w.addr.toLowerCase().includes(s)) return false;
      }
      return true;
    });
    arr.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const r = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? r : -r;
    });
    return arr;
  }, [classFilter, sortKey, sortDir, search]);

  const setSort = (k) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  const sortIcon = (k) => sortKey === k ? (sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';

  const w = selectedWallet || filtered[0];

  // class distribution for overview bar
  const classDist = React.useMemo(() => {
    const d = {};
    WALLET_CLASSES.forEach(c => d[c.id] = 0);
    wallets.forEach(w => d[w.cls.id]++);
    return d;
  }, []);

  return (
    <div className="view" style={{ display: 'grid', gridTemplateColumns: '1fr 480px', gap: 1, background: 'var(--border)', height: '100%' }}>
      {/* LEFT: list */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
        <div className="filterbar">
          <span className="ascii-h">WALLET INTELLIGENCE</span>
          <span className="muted">·</span>
          <label>class</label>
          <div className="seg">
            {['ALL', ...WALLET_CLASSES.map(c => c.id)].map(c => (
              <button key={c} className={classFilter === c ? 'active' : ''} onClick={() => setClassFilter(c)}>
                {c === 'ALL' ? 'all' : c}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <span className="muted">{filtered.length}/{wallets.length} wallets · {Object.keys(walletByAddr).length} indexed</span>
        </div>

        {/* class distribution strip */}
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', display: 'flex', gap: 0, fontSize: 10, height: 28, alignItems: 'center' }}>
          {WALLET_CLASSES.map(c => {
            const count = classDist[c.id];
            const pct = (count / wallets.length) * 100;
            const color = c.tone === 'g' ? 'var(--green)' : c.tone === 'r' ? 'var(--red)' : c.tone === 'a' ? 'var(--amber)' : 'var(--text-3)';
            return (
              <div key={c.id} title={c.label + ': ' + count}
                onClick={() => setClassFilter(c.id)}
                style={{ flex: pct, height: 12, background: color, opacity: classFilter === c.id || classFilter === 'ALL' ? 1 : 0.3, borderRight: '1px solid var(--bg-1)', cursor: 'pointer' }}
              />
            );
          })}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>WALLET</th>
                <th>CLASS</th>
                <th onClick={() => setSort('score')} className={sortIcon('score') + ' right'} style={{ textAlign: 'right', width: 70 }}>SCORE</th>
                <th onClick={() => setSort('winRate')} className={sortIcon('winRate') + ' right'} style={{ textAlign: 'right', width: 70 }}>WIN%</th>
                <th onClick={() => setSort('avgX')} className={sortIcon('avgX') + ' right'} style={{ textAlign: 'right', width: 70 }}>AVG ×</th>
                <th onClick={() => setSort('tokens')} className={sortIcon('tokens') + ' right'} style={{ textAlign: 'right', width: 70 }}>TOKENS</th>
                <th onClick={() => setSort('entryMC')} className={sortIcon('entryMC') + ' right'} style={{ textAlign: 'right', width: 80 }}>AVG ENT.</th>
                <th onClick={() => setSort('holdMin')} className={sortIcon('holdMin') + ' right'} style={{ textAlign: 'right', width: 70 }}>HOLD</th>
                <th onClick={() => setSort('realizedPnl')} className={sortIcon('realizedPnl') + ' right'} style={{ textAlign: 'right', width: 80 }}>PnL</th>
                <th>FUNDED</th>
                <th onClick={() => setSort('lastSeen')} className={sortIcon('lastSeen') + ' right'} style={{ textAlign: 'right', width: 70 }}>LAST</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((w_, i) => (
                <tr key={w_.addr} onClick={() => onSelect(w_)} className={selectedWallet && selectedWallet.addr === w_.addr ? 'selected' : ''}>
                  <td className="dim">{String(i + 1).padStart(3, '0')}</td>
                  <td className="addr">{shortAddr(w_.addr)}</td>
                  <td><ClassBadge cls={w_.cls} /></td>
                  <td className={'right ' + scoreClass(w_.score)}>{w_.score}</td>
                  <td className="right">{(w_.winRate * 100).toFixed(0)}%</td>
                  <td className="right">{w_.avgX.toFixed(2)}×</td>
                  <td className="right">{w_.tokens}</td>
                  <td className="right">${fmtMC(w_.entryMC)}</td>
                  <td className="right dim">{w_.holdMin < 60 ? w_.holdMin + 'm' : Math.floor(w_.holdMin/60) + 'h'}</td>
                  <td className={'right ' + (w_.realizedPnl > 0 ? 'up' : 'dn')}>{w_.realizedPnl > 0 ? '+' : ''}${(w_.realizedPnl/1000).toFixed(1)}k</td>
                  <td className="dim">{w_.funded}</td>
                  <td className="right dim">{fmtSec(w_.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* RIGHT: detail panel */}
      <WalletProfile wallet={w} />
    </div>
  );
};

const WalletProfile = ({ wallet }) => {
  if (!wallet) return null;
  const w = wallet;

  // synthesize a recent activity log (deterministic-ish)
  const activity = React.useMemo(() => {
    const out = [];
    const seed = w.addr.charCodeAt(0) + w.addr.charCodeAt(5);
    for (let i = 0; i < 12; i++) {
      const side = ((seed + i) % 5) > 1 ? 'buy' : 'sell';
      const tok = tokens[(seed + i * 3) % tokens.length];
      const result = side === 'buy' ? null : (((seed + i) % 3) === 0 ? 'loss' : 'win');
      out.push({
        time: (i + 1) * 240 + (seed % 60),
        side, token: tok,
        mc: Math.round(tok.mc * (0.3 + ((seed + i) % 7) / 10)),
        sol: 1 + ((seed + i * 7) % 30) / 2,
        result,
        x: result === 'win' ? 1.5 + ((seed + i) % 30) / 10 : result === 'loss' ? 0.3 + ((seed + i) % 8) / 10 : null,
      });
    }
    return out;
  }, [w.addr]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0, overflow: 'auto' }}>
      {/* top: identity */}
      <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <ScoreDonut value={w.score} size={84} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>WALLET</div>
            <div style={{ fontSize: 13, wordBreak: 'break-all', marginBottom: 6 }}>{w.addr}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <ClassBadge cls={w.cls} />
              <span className="badge">funded · {w.funded}</span>
              <span className="badge">age {w.age}d</span>
              <span className="badge">{w.tokens} tokens</span>
            </div>
          </div>
        </div>
      </div>

      {/* skill bars */}
      <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div className="ascii-h" style={{ marginBottom: 8 }}>SKILL METRICS</div>
        {[
          ['early', 'Early entry'],
          ['continuation', 'Continuation'],
          ['holding', 'Holding'],
          ['exit', 'Exit timing'],
          ['migration', 'Migration pred.'],
          ['risk', 'Risk mgmt'],
          ['consistency', 'Consistency'],
        ].map(([k, lbl]) => (
          <div key={k} className="skill">
            <span className="k">{lbl}</span>
            <span className="b"><i style={{
              width: w.skill[k] + '%',
              background: w.skill[k] >= 70 ? 'var(--green)' : w.skill[k] >= 40 ? 'var(--amber)' : 'var(--red)',
            }} /></span>
            <span className="v">{w.skill[k]}</span>
          </div>
        ))}
      </div>

      {/* key stats */}
      <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div className="ascii-h" style={{ marginBottom: 8 }}>PERFORMANCE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>WIN RATE</div>
            <div className={w.winRate > 0.4 ? 'up' : ''} style={{ fontSize: 22 }}>{(w.winRate * 100).toFixed(0)}%</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>AVG MULTIPLE</div>
            <div className={w.avgX > 2 ? 'up' : ''} style={{ fontSize: 22 }}>{w.avgX.toFixed(2)}×</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>REALIZED PnL</div>
            <div className={w.realizedPnl > 0 ? 'up' : 'dn'} style={{ fontSize: 22 }}>{w.realizedPnl > 0 ? '+' : ''}${(w.realizedPnl/1000).toFixed(1)}k</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>AVG ENTRY MC</div>
            <div style={{ fontSize: 14 }}>${fmtMC(w.entryMC)}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>AVG HOLD</div>
            <div style={{ fontSize: 14 }}>{w.holdMin < 60 ? w.holdMin + 'm' : Math.floor(w.holdMin/60) + 'h ' + (w.holdMin%60) + 'm'}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 10 }}>CONFIDENCE</div>
            <div className={w.tokens > 80 ? 'up' : 'dim'} style={{ fontSize: 14 }}>{w.tokens > 80 ? 'HIGH' : w.tokens > 30 ? 'MED' : 'LOW'}</div>
          </div>
        </div>
      </div>

      {/* recent activity */}
      <div style={{ padding: 0, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '10px 14px 4px' }}><div className="ascii-h">RECENT ACTIVITY</div></div>
        <div className="tape">
          {activity.map((a, i) => (
            <div key={i} className={'row ' + a.side}>
              <span className="t">{fmtSec(a.time)}</span>
              <span className="side">{a.side === 'buy' ? '▲ B' : '▼ S'}</span>
              <span className="addr">${a.token.symbol} <span className="dim">{a.token.phase.slice(0,3)}</span></span>
              <span className="amt">{a.sol.toFixed(1)} SOL</span>
              <span className={'mc ' + (a.result === 'win' ? 'up' : a.result === 'loss' ? 'dn' : '')}>
                {a.result === 'win' ? a.x.toFixed(1) + '×' : a.result === 'loss' ? a.x.toFixed(1) + '×' : '@' + fmtMC(a.mc)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

window.WalletsView = WalletsView;
