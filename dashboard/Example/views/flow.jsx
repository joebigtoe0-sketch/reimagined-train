// flow.jsx — Smart money flow visualization

const FlowView = ({ onSelectToken, onNavigateWallet }) => {
  const [windowMin, setWindowMin] = React.useState(15);

  // build flow data: source category -> token destinations -> wallet class outflow
  const flowData = React.useMemo(() => {
    // pick top 8 tokens by smart count
    const topTokens = [...tokens].filter(t => t.smartCount > 0).sort((a, b) => b.smartCount - a.smartCount).slice(0, 8);

    // active wallets routing into them
    const active = STAR_WALLETS.slice(0, 10);

    return { topTokens, active };
  }, [windowMin]);

  // Net SOL flow per token
  const tokenFlow = flowData.topTokens.map(t => ({
    token: t,
    netSol: t.smartNetFlow,
    inflows: Math.max(20, t.smartNetFlow + Math.abs(t.smartNetFlow) * 0.6),
    outflows: Math.max(5, Math.abs(t.smartNetFlow) * 0.4),
    smartCount: t.smartCount,
  }));

  const totalIn = tokenFlow.reduce((s, t) => s + t.inflows, 0);
  const totalOut = tokenFlow.reduce((s, t) => s + t.outflows, 0);
  const net = totalIn - totalOut;

  // recent smart-money trades
  const smartTrades = React.useMemo(() => {
    const out = [];
    for (let i = 0; i < 40; i++) {
      const w = STAR_WALLETS[i % STAR_WALLETS.length];
      const t = flowData.topTokens[i % flowData.topTokens.length];
      const side = i % 3 === 0 ? 'sell' : 'buy';
      out.push({
        secondsAgo: i * 18 + (i * 7) % 30,
        side, wallet: w, token: t,
        sol: 0.8 + (i * 1.3) % 24,
        mc: Math.round(t.mc * (0.5 + (i % 10) / 20)),
      });
    }
    return out;
  }, [windowMin]);

  return (
    <div className="view" style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%', background: 'var(--bg)' }}>
      {/* HEADER */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto auto', gap: 18, alignItems: 'center', padding: '14px 16px', background: 'var(--bg-1)', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div className="ascii-h">SMART MONEY FLOW</div>
          <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>elite + continuation wallet movements · last {windowMin}m</div>
        </div>
        <div />
        <div className="seg">
          {[5, 15, 60, 240].map(m => (
            <button key={m} className={windowMin === m ? 'active' : ''} onClick={() => setWindowMin(m)}>{m}m</button>
          ))}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="dim" style={{ fontSize: 10 }}>NET INFLOW</div>
          <div className={net > 0 ? 'up' : 'dn'} style={{ fontSize: 20 }}>{net > 0 ? '+' : ''}{net.toFixed(0)} ◎</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="dim" style={{ fontSize: 10 }}>GROSS IN</div>
          <div className="up" style={{ fontSize: 16 }}>+{totalIn.toFixed(0)} ◎</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="dim" style={{ fontSize: 10 }}>GROSS OUT</div>
          <div className="dn" style={{ fontSize: 16 }}>-{totalOut.toFixed(0)} ◎</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 360px', gap: 1, background: 'var(--border)', minHeight: 0 }}>
        {/* Flow visualization */}
        <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0, padding: 0 }}>
          <div className="panel-hdr"><span className="title">FLOW MAP · wallets → tokens</span></div>
          <div style={{ flex: 1, minHeight: 0, padding: 14, overflow: 'auto' }}>
            <FlowDiagram tokenFlow={tokenFlow} wallets={flowData.active} onSelectToken={onSelectToken} onNavigateWallet={onNavigateWallet} />
          </div>
        </div>

        {/* Net flow leaders */}
        <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 1, background: 'var(--border)' }}>
          <Panel title="NET ACCUMULATION · top tokens" bodyClass="p">
            {[...tokenFlow].sort((a, b) => b.netSol - a.netSol).slice(0, 6).map((tf, i) => (
              <div key={i} onClick={() => onSelectToken(tf.token)} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr auto',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                alignItems: 'center',
              }}>
                <div>
                  <div className="fg" style={{ fontSize: 13 }}>${tf.token.symbol}</div>
                  <div className="dim" style={{ fontSize: 10 }}>{tf.smartCount} smart · ${fmtMC(tf.token.mc)}</div>
                </div>
                <div style={{ height: 6, background: 'var(--bg-3)', position: 'relative' }}>
                  <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: Math.min(50, Math.abs(tf.netSol) / 10) + '%', background: tf.netSol > 0 ? 'var(--green)' : 'var(--red)', transform: tf.netSol < 0 ? 'translateX(-100%)' : 'none' }} />
                  <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: 'var(--text-3)' }} />
                </div>
                <div className={tf.netSol > 0 ? 'up' : 'dn'} style={{ fontSize: 13, fontWeight: 500, textAlign: 'right', minWidth: 60 }}>
                  {tf.netSol > 0 ? '+' : ''}{tf.netSol} ◎
                </div>
              </div>
            ))}
          </Panel>

          <Panel title="NET DISTRIBUTION · top exits" bodyClass="p">
            {[...tokenFlow].sort((a, b) => a.netSol - b.netSol).slice(0, 6).map((tf, i) => (
              <div key={i} onClick={() => onSelectToken(tf.token)} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr auto',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                alignItems: 'center',
              }}>
                <div>
                  <div className="fg" style={{ fontSize: 13 }}>${tf.token.symbol}</div>
                  <div className="dim" style={{ fontSize: 10 }}>{tf.smartCount} smart · ${fmtMC(tf.token.mc)}</div>
                </div>
                <div style={{ height: 6, background: 'var(--bg-3)', position: 'relative' }}>
                  <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: Math.min(50, Math.abs(tf.netSol) / 10) + '%', background: tf.netSol > 0 ? 'var(--green)' : 'var(--red)', transform: tf.netSol < 0 ? 'translateX(-100%)' : 'none' }} />
                  <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: 'var(--text-3)' }} />
                </div>
                <div className={tf.netSol > 0 ? 'up' : 'dn'} style={{ fontSize: 13, fontWeight: 500, textAlign: 'right', minWidth: 60 }}>
                  {tf.netSol > 0 ? '+' : ''}{tf.netSol} ◎
                </div>
              </div>
            ))}
          </Panel>
        </div>

        {/* Smart trade tape */}
        <Panel title="SMART WALLET TAPE" right={<span className="up" style={{ fontSize: 10 }}>live <span className="dot dot-green pulse" /></span>}>
          <div className="tape">
            {smartTrades.map((tr, i) => (
              <div key={i} className={'row ' + tr.side}>
                <span className="t">{fmtSec(tr.secondsAgo)}</span>
                <span className="side">{tr.side === 'buy' ? '▲' : '▼'}</span>
                <span className="addr" onClick={() => onNavigateWallet(tr.wallet)} style={{ cursor: 'pointer' }}>
                  {shortAddr(tr.wallet.addr)}
                  <span className={'badge ' + tr.wallet.cls.tone} style={{ marginLeft: 4 }}>{tr.wallet.cls.label.split(' ')[0]}</span>
                </span>
                <span className="amt">{tr.sol.toFixed(1)} ◎</span>
                <span className="mc" onClick={() => onSelectToken(tr.token)} style={{ cursor: 'pointer', color: 'var(--text-2)' }}>${tr.token.symbol}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
};

// === FlowDiagram — simple sankey-ish visualization ===
const FlowDiagram = ({ tokenFlow, wallets, onSelectToken, onNavigateWallet }) => {
  const W = 720;
  const H = Math.max(420, 60 * Math.max(tokenFlow.length, wallets.length));
  const leftX = 100;
  const rightX = W - 100;

  const walletRows = wallets.slice(0, 8);
  const tokenRows = tokenFlow;

  const lY = (i) => 30 + (H - 60) * (i / Math.max(1, walletRows.length - 1));
  const rY = (i) => 30 + (H - 60) * (i / Math.max(1, tokenRows.length - 1));

  // connections: each wallet connects to 2 tokens
  const connections = [];
  walletRows.forEach((w, wi) => {
    const t1 = wi % tokenRows.length;
    const t2 = (wi * 3 + 1) % tokenRows.length;
    connections.push({ w, wi, ti: t1, weight: 2 + (wi % 4) });
    if (t1 !== t2) connections.push({ w, wi, ti: t2, weight: 1 + (wi % 3) });
  });

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="flowGrad" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* connection paths */}
      {connections.map((c, i) => {
        const y1 = lY(c.wi);
        const y2 = rY(c.ti);
        const x1 = leftX;
        const x2 = rightX;
        const cx1 = x1 + (x2 - x1) * 0.5;
        const cx2 = x2 - (x2 - x1) * 0.5;
        const d = `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;
        const netSol = tokenRows[c.ti].netSol;
        const col = netSol > 0 ? 'var(--green)' : 'var(--red)';
        return <path key={i} d={d} stroke={col} strokeWidth={c.weight} fill="none" opacity="0.45" />;
      })}
      {/* wallet nodes (left) */}
      {walletRows.map((w, i) => {
        const y = lY(i);
        return (
          <g key={w.addr} onClick={() => onNavigateWallet(w)} style={{ cursor: 'pointer' }}>
            <rect x={leftX - 92} y={y - 14} width="92" height="28" fill="var(--bg-2)" stroke="var(--border-2)" />
            <text x={leftX - 86} y={y - 2} fill="var(--text)" fontSize="10" fontFamily="var(--mono)">{shortAddr(w.addr)}</text>
            <text x={leftX - 86} y={y + 9} fill={w.cls.tone === 'g' ? 'var(--green)' : w.cls.tone === 'r' ? 'var(--red)' : 'var(--text-3)'} fontSize="8" fontFamily="var(--mono)">{w.cls.label}</text>
            <circle cx={leftX} cy={y} r="3" fill="var(--green)" />
          </g>
        );
      })}
      {/* token nodes (right) */}
      {tokenRows.map((tf, i) => {
        const y = rY(i);
        const netCol = tf.netSol > 0 ? 'var(--green)' : 'var(--red)';
        return (
          <g key={tf.token.mint} onClick={() => onSelectToken(tf.token)} style={{ cursor: 'pointer' }}>
            <rect x={rightX} y={y - 14} width="92" height="28" fill="var(--bg-2)" stroke="var(--border-2)" />
            <text x={rightX + 6} y={y - 2} fill="var(--text)" fontSize="11" fontFamily="var(--mono)">${tf.token.symbol}</text>
            <text x={rightX + 6} y={y + 9} fill={netCol} fontSize="9" fontFamily="var(--mono)">{tf.netSol > 0 ? '+' : ''}{tf.netSol}◎ · {tf.smartCount}w</text>
            <circle cx={rightX} cy={y} r="3" fill={netCol} />
          </g>
        );
      })}
      {/* labels */}
      <text x={leftX - 92} y={18} fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)" letterSpacing="1">SMART WALLETS</text>
      <text x={rightX} y={18} fill="var(--text-3)" fontSize="9" fontFamily="var(--mono)" letterSpacing="1">TOKENS</text>
    </svg>
  );
};

window.FlowView = FlowView;
