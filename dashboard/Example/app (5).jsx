// app.jsx — Top-level app shell

const App = () => {
  const [tab, setTab] = React.useState('terminal');
  const [search, setSearch] = React.useState('');
  const [selectedToken, setSelectedToken] = React.useState(FEATURED_TOKEN);
  const [selectedWallet, setSelectedWallet] = React.useState(STAR_WALLETS[0]);
  const [selectedDev, setSelectedDev] = React.useState(devs.find(d => d.alias) || devs[0]);

  // === live state: tokens that mutate over time ===
  const [liveTokens, setLiveTokens] = React.useState(() => tokens.map(t => ({ ...t })));
  const [lastTick, setLastTick] = React.useState({});
  const [liveAlerts, setLiveAlerts] = React.useState(() => alerts);

  // synthetic market stats
  const [marketStats, setMarketStats] = React.useState({
    solPrice: 184.62,
    solDelta: 2.14,
    launchRate: 47,
    migrating: liveTokens.filter(t => t.phase === 'MIGRATING').length,
  });

  // live ticking
  React.useEffect(() => {
    const id = setInterval(() => {
      setLiveTokens(prev => {
        const flash = {};
        const next = prev.map(t => {
          if (t.phase === 'DEAD') return t;
          // mutate probability with small jitter, bias toward signals
          const drift = (Math.random() - 0.49) * 2.4;
          let p = t.prob + drift;
          p = Math.max(2, Math.min(98, p));
          if (Math.abs(drift) > 1.2) {
            flash[t.mint] = drift > 0 ? 'up' : 'dn';
          }
          // age advances by ~5s
          const ageMin = t.ageMin + 0.08;
          // MC drifts
          const mcDrift = 1 + (Math.random() - 0.495) * 0.018;
          const newMc = Math.round(t.mc * mcDrift);
          // shift histories
          const newPh = [...t.probHistory.slice(1), Math.round(p * 10) / 10];
          const newMh = [...t.mcHistory.slice(1), newMc];
          return {
            ...t,
            prob: Math.round(p * 10) / 10,
            ageMin,
            mc: newMc,
            probHistory: newPh,
            mcHistory: newMh,
            holders: t.holders + (Math.random() < t.holderGrowth / 60 ? 1 : 0),
            smartNetFlow: t.smartNetFlow + Math.round((Math.random() - 0.48) * 10),
          };
        });
        setLastTick(flash);
        return next;
      });

      // market stats jitter
      setMarketStats(s => ({
        ...s,
        solPrice: Math.max(50, s.solPrice + (Math.random() - 0.5) * 0.4),
        solDelta: s.solDelta + (Math.random() - 0.5) * 0.05,
        launchRate: 38 + Math.floor(Math.random() * 20),
      }));
    }, 1800);

    return () => clearInterval(id);
  }, []);

  // periodically inject new alerts
  React.useEffect(() => {
    const id = setInterval(() => {
      const tplPool = [
        { tone: 'good', icon: '↑', msg: (t) => `Elite wallet ${shortAddr(pick(STAR_WALLETS).addr)} entered $${t.symbol}` },
        { tone: 'good', icon: '★', msg: (t) => `${randint(2,4)} smart wallets accumulating $${t.symbol}` },
        { tone: 'warn', icon: '!', msg: (t) => `Insider concentration rising on $${t.symbol}` },
        { tone: 'crit', icon: '✕', msg: (t) => `$${t.symbol} probability collapsed ${randint(10,30)}pp` },
        { tone: 'good', icon: 'M', msg: (t) => `$${t.symbol} approaching migration · curve ${randint(88,98)}%` },
      ];
      const tpl = pick(tplPool);
      const t = pick(liveTokens.slice(0, 24));
      setLiveAlerts(prev => [
        { id: Date.now(), secondsAgo: 0, tone: tpl.tone, icon: tpl.icon, msg: tpl.msg(t), token: t },
        ...prev.map(a => ({ ...a, secondsAgo: a.secondsAgo + 1 })),
      ].slice(0, 200));
    }, 5000);
    return () => clearInterval(id);
  }, [liveTokens]);

  // Sync deep-dive token with live state
  const liveSelectedToken = React.useMemo(() => {
    if (!selectedToken) return null;
    return liveTokens.find(t => t.mint === selectedToken.mint) || selectedToken;
  }, [selectedToken, liveTokens]);

  // Keyboard navigation
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key >= '1' && e.key <= '7') {
        setTab(TAB_DEFS[parseInt(e.key) - 1].id);
      }
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector('.hdr-search input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSelectToken = (t) => {
    setSelectedToken(t);
    setTab('token');
  };
  const handleSelectWallet = (w) => {
    setSelectedWallet(w);
    setTab('wallets');
  };
  const handleSelectDev = (d) => {
    setSelectedDev(d);
    setTab('devs');
  };

  return (
    <div className="app">
      <Header search={search} setSearch={setSearch} marketStats={marketStats} />
      <Tabs active={tab} onChange={setTab} />
      <div className="view-host" style={{ minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {tab === 'terminal' && (
          <TerminalView
            onSelectToken={handleSelectToken}
            search={search}
            liveTokens={liveTokens}
            lastTick={lastTick}
          />
        )}
        {tab === 'token' && (
          <TokenView
            token={liveSelectedToken}
            onSelectToken={handleSelectToken}
            onNavigateWallet={handleSelectWallet}
            onNavigateDev={handleSelectDev}
          />
        )}
        {tab === 'wallets' && (
          <WalletsView
            selectedWallet={selectedWallet}
            onSelect={setSelectedWallet}
            search={search}
          />
        )}
        {tab === 'devs' && (
          <DevsView
            selectedDev={selectedDev}
            onSelect={setSelectedDev}
            onSelectToken={handleSelectToken}
            search={search}
          />
        )}
        {tab === 'flow' && (
          <FlowView
            onSelectToken={handleSelectToken}
            onNavigateWallet={handleSelectWallet}
          />
        )}
        {tab === 'alerts' && (
          <AlertsView
            onSelectToken={handleSelectToken}
            liveAlerts={liveAlerts}
          />
        )}
        {tab === 'backtest' && (
          <BacktestView onSelectToken={handleSelectToken} />
        )}
      </div>
      <StatusBar
        wsLatency={42 + Math.floor(Math.random() * 25)}
        ingestRate={1284 + Math.floor(Math.random() * 200)}
        snapshotsHeld={48_212_904}
        totalTokens={liveTokens.length}
        totalWallets={wallets.length * 412}
        errors={0}
      />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
