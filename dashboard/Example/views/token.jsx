// token.jsx — Token deep-dive view

const TokenView = ({ token, onSelectToken, onNavigateWallet, onNavigateDev }) => {
  const [tab, setTab] = React.useState('signals');

  if (!token) {
    return (
      <div className="view" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
        no token selected — click a row in the terminal
      </div>
    );
  }

  const prob = token.prob;
  const probColor = prob >= 70 ? 'var(--green)' : prob >= 40 ? 'var(--amber)' : 'var(--red)';

  // wallet entries (smart wallets in this token)
  const smartIn = React.useMemo(() => {
    // pick deterministic-ish wallets
    return STAR_WALLETS.slice(0, Math.min(STAR_WALLETS.length, token.smartCount)).map((w, i) => ({
      wallet: w,
      entryMC: Math.round(token.mc * (0.15 + i * 0.08) * (0.6 + Math.random() * 0.3)),
      entryAgeMin: Math.max(1, token.ageMin - i * 4),
      size: 2 + i * 1.5,
      stillIn: i < token.smartCount - Math.max(0, Math.floor(token.smartCount * 0.2)),
    }));
  }, [token.mint]);

  // recent trades on this token
  const trades = token === FEATURED_TOKEN ? tradeTape : tradeTape.map(t => ({ ...t }));

  const signalTotal = token.signals.reduce((s, x) => s + x.s, 0);

  // Outcome predictions (the "measurable predictions" principle)
  const measurables = [
    { label: `reaches $${fmtMC(token.mc * 1.5)} before $${fmtMC(token.mc * 0.6)}`, p: Math.round(Math.min(95, prob * 1.05)) },
    { label: `migrates to PumpSwap`, p: token.phase === 'MIGRATING' ? Math.round(75 + Math.random() * 20) : token.phase === 'PUMPSWAP' ? 100 : Math.round(prob * 0.8) },
    { label: `holds above $${fmtMC(token.mc)} for 30m`, p: Math.round(prob * 0.92) },
    { label: `2× from here`, p: Math.round(prob * 0.55) },
    { label: `local top within 10m`, p: Math.round(Math.max(8, 70 - prob * 0.7)) },
  ];

  return (
    <div className="view" style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%', background: 'var(--bg)' }}>
      {/* TOKEN HEADER */}
      <div style={{
        borderBottom: '1px solid var(--border)',
        padding: '14px 16px',
        display: 'grid',
        gridTemplateColumns: '1fr auto auto auto auto',
        gap: 24,
        alignItems: 'center',
        background: 'var(--bg-1)',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.01em' }}>${token.symbol}</span>
            <span className="dim" style={{ fontSize: 13 }}>{token.name}</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
            <span>mint <span className="fg">{shortAddr(token.mint)}</span></span>
            <span className="sep">│</span>
            <span>age <span className="fg">{fmtAge(token.ageMin)}</span></span>
            <span className="sep">│</span>
            <span>dev
              <span className="fg" style={{ marginLeft: 4, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border-2)' }}
                onClick={() => onNavigateDev(token.dev)}>
                {token.dev.alias || shortAddr(token.dev.addr)}
              </span>
              <span className={token.dev.score >= 70 ? 'up' : token.dev.score < 35 ? 'dn' : 'dim'} style={{ marginLeft: 4 }}>
                ★{token.dev.score}
              </span>
            </span>
            <span className="sep">│</span>
            <span>phase <span className={'badge ' + (token.phase === 'MIGRATING' ? 'a' : token.phase === 'PUMPSWAP' ? 'g' : token.phase === 'DEAD' ? 'r' : '')}>{token.phase}</span></span>
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="ascii-h">MARKET CAP</div>
          <div className="bignum">${fmtMC(token.mc)}</div>
          <div className="dim" style={{ fontSize: 11 }}>ATH ${fmtMC(token.ath)} · vol ${fmtMC(token.volume24h)}</div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="ascii-h">HOLDERS</div>
          <div className="bignum">{token.holders.toLocaleString()}</div>
          <div className={token.holderGrowth > 1 ? 'up' : 'dim'} style={{ fontSize: 11 }}>{token.holderGrowth >= 0 ? '+' : ''}{token.holderGrowth.toFixed(2)}/min</div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="ascii-h">SMART WALLETS</div>
          <div className="bignum">{token.smartCount}</div>
          <div className={token.smartNetFlow > 0 ? 'up' : 'dn'} style={{ fontSize: 11 }}>
            net {token.smartNetFlow >= 0 ? '+' : ''}{token.smartNetFlow} SOL
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <ScoreDonut value={prob} label="PROBABILITY" size={94} />
          <div>
            <div className="ascii-h">SIGNAL</div>
            <div className={signalTotal >= 0 ? 'up' : 'dn'} style={{ fontSize: 18, fontWeight: 500 }}>{signalTotal >= 0 ? '+' : ''}{signalTotal}</div>
            <div className="dim" style={{ fontSize: 10 }}>weighted score</div>
          </div>
        </div>
      </div>

      {/* MAIN BODY */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 380px', gap: 1, background: 'var(--border)', minHeight: 0 }}>
        {/* LEFT: probability timeline + MC */}
        <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 1, background: 'var(--border)', minHeight: 0 }}>
          <Panel title="PROBABILITY · 60m" right={<div className="legend">
            <span><i className="swatch" style={{ background: 'var(--green)' }} /> P(continuation)</span>
            <span className="dim">smoothed · 5s</span>
          </div>}>
            <div style={{ flex: 1, padding: 8 }}>
              <LineChart
                data={token.probHistory}
                color={probColor}
                yMin={0} yMax={100}
                suffix="%"
                annotations={[
                  ...(token.signals.slice(0, 1).map(() => ({ idx: 40, label: 'smart in', color: 'var(--green)' }))),
                  ...(token.phase === 'MIGRATING' ? [{ idx: 50, label: 'migration', color: 'var(--amber)' }] : []),
                ]}
                label="P"
              />
            </div>
          </Panel>

          <Panel title="MARKET CAP · 60m" right={<span className="dim">USD</span>}>
            <div style={{ flex: 1, padding: 8 }}>
              <LineChart
                data={token.mcHistory}
                color="var(--text-2)"
                suffix=""
                label="MC"
              />
            </div>
          </Panel>
        </div>

        {/* CENTER: signal composition + measurables */}
        <div style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 1, background: 'var(--border)', minHeight: 0 }}>
          <Panel title="PROBABILITY COMPOSITION · why this score?" bodyClass="p">
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>weighted signals · sum to score</div>
            {token.signals.map((sig, i) => (
              <div key={i} className="signal">
                <span className={'delta ' + (sig.s > 0 ? 'p' : 'n')}>{sig.s > 0 ? '+' : ''}{sig.s}</span>
                <span className="lbl"><em>{sig.label}</em> {sig.detail && <span className="dim">· {sig.detail}</span>}</span>
                <span className="dim" style={{ fontSize: 10 }}>w={Math.abs(sig.s)/100*100|0}%</span>
              </div>
            ))}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="dim" style={{ fontSize: 11 }}>NET SIGNAL</span>
              <span className={signalTotal >= 0 ? 'up' : 'dn'} style={{ fontSize: 16, fontWeight: 500 }}>{signalTotal >= 0 ? '+' : ''}{signalTotal}</span>
            </div>
          </Panel>

          <Panel title="MEASURABLE PREDICTIONS · backtestable" bodyClass="p" style={{ maxHeight: 220 }}>
            {measurables.map((m, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, padding: '5px 0', borderBottom: '1px dashed var(--border)', alignItems: 'center', fontSize: 12 }}>
                <span className="fg" style={{ fontSize: 11 }}>{m.label}</span>
                <ProbBar value={m.p} width={50} />
              </div>
            ))}
          </Panel>
        </div>

        {/* RIGHT: tabs (smart wallets, trades, holders) */}
        <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0 }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {[
              ['signals', 'SMART WALLETS', token.smartCount],
              ['trades', 'TRADE TAPE', null],
              ['holders', 'HOLDERS', null],
              ['curve', 'CURVE', null],
            ].map(([id, lbl, count]) => (
              <div key={id}
                onClick={() => setTab(id)}
                style={{
                  padding: '8px 12px',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                  color: tab === id ? 'var(--text)' : 'var(--text-3)',
                  borderBottom: tab === id ? '1px solid var(--green)' : '1px solid transparent',
                  marginBottom: -1,
                }}>
                {lbl}{count != null && <span className="dim" style={{ marginLeft: 6 }}>{count}</span>}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {tab === 'signals' && (
              <div style={{ padding: 10 }}>
                {smartIn.length === 0 && <div className="dim" style={{ padding: 20, textAlign: 'center', fontSize: 11 }}>no smart wallets detected</div>}
                {smartIn.map((s, i) => (
                  <div key={i} onClick={() => onNavigateWallet(s.wallet)} style={{
                    padding: 8,
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span className="fg">{shortAddr(s.wallet.addr)}</span>
                      <ClassBadge cls={s.wallet.cls} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-3)' }}>
                      <span>entry <span className="up">${fmtMC(s.entryMC)}</span> · {fmtAge(s.entryAgeMin)} ago</span>
                      <span>{s.size.toFixed(1)} SOL</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-3)' }}>
                      score <span className={scoreClass(s.wallet.score)}>{s.wallet.score}</span> · wr {(s.wallet.winRate * 100).toFixed(0)}% · avg {s.wallet.avgX.toFixed(1)}× · {s.stillIn ? <span className="up">HOLDING</span> : <span className="dn">EXITED</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'trades' && (
              <div className="tape">
                {trades.slice(0, 50).map((tr, i) => (
                  <div key={i} className={'row ' + tr.side} onClick={() => onNavigateWallet(tr.wallet)}>
                    <span className="t">{fmtSec(tr.secondsAgo)}</span>
                    <span className="side">{tr.side === 'buy' ? '▲ B' : '▼ S'}</span>
                    <span className="addr">{shortAddr(tr.wallet.addr)} <ClassBadge cls={tr.wallet.cls} /></span>
                    <span className="amt">{tr.sol.toFixed(2)} SOL</span>
                    <span className="mc">@${fmtMC(tr.mc)}</span>
                  </div>
                ))}
              </div>
            )}

            {tab === 'holders' && (
              <div style={{ padding: 12 }}>
                <div style={{ marginBottom: 12 }}>
                  <div className="ascii-h">TOP HOLDER CONCENTRATION</div>
                  <div style={{ height: 8, background: 'var(--bg-3)', marginTop: 6, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: (token.topHolderPct) + '%', background: token.topHolderPct > 10 ? 'var(--red)' : 'var(--green)' }} />
                  </div>
                  <div className="dim" style={{ fontSize: 10, marginTop: 4 }}>top wallet holds {token.topHolderPct.toFixed(1)}% of supply</div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="ascii-h">INSIDER CLUSTER</div>
                  <div style={{ height: 8, background: 'var(--bg-3)', marginTop: 6, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: (token.insiderConc * 100) + '%', background: token.insiderConc > 0.30 ? 'var(--red)' : 'var(--amber)' }} />
                  </div>
                  <div className="dim" style={{ fontSize: 10, marginTop: 4 }}>{(token.insiderConc * 100).toFixed(1)}% held by linked-funding wallets</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 11, marginTop: 16 }}>
                  <div>
                    <div className="dim" style={{ fontSize: 10 }}>SNIPERS EXITED</div>
                    <div style={{ fontSize: 18 }}>{token.snipersOut}</div>
                  </div>
                  <div>
                    <div className="dim" style={{ fontSize: 10 }}>BUY/SELL RATIO</div>
                    <div className={token.buyPressure > 1 ? 'up' : 'dn'} style={{ fontSize: 18 }}>{token.buyPressure.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'curve' && (
              <div style={{ padding: 14 }}>
                <div className="ascii-h">BONDING CURVE PROGRESS</div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                    <span className="dim">$0</span>
                    <span className={token.curveProgress > 60 ? 'up' : 'dim'}>{token.curveProgress.toFixed(1)}%</span>
                    <span className="dim">$69k</span>
                  </div>
                  <div style={{ height: 14, background: 'var(--bg-3)', border: '1px solid var(--border)', position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: Math.min(100, token.curveProgress) + '%', background: token.curveProgress > 95 ? 'var(--amber)' : 'var(--green)' }} />
                    <div style={{ position: 'absolute', left: '100%', top: -3, bottom: -3, width: 1, background: 'var(--amber)' }} />
                  </div>
                  <div className="dim" style={{ fontSize: 10, marginTop: 6 }}>migrates to PumpSwap at $69k MC threshold</div>
                </div>

                <div style={{ marginTop: 24 }}>
                  <div className="ascii-h">LIQUIDITY STATE</div>
                  <div className="kv" style={{ marginTop: 8 }}>
                    <span className="k">virtual SOL</span><span className="v">{(token.mc / 220).toFixed(1)} ◎</span>
                    <span className="k">real SOL</span><span className="v">{(token.mc / 350).toFixed(1)} ◎</span>
                    <span className="k">curve K</span><span className="v">32×10⁹</span>
                    <span className="k">bonded</span><span className="v">{token.bonded ? <span className="up">YES</span> : <span className="dim">NO</span>}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

window.TokenView = TokenView;
