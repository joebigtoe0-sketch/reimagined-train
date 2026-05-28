// data.jsx — mock data layer for SAIRAS//PROBE
// All data is fictional, plausible-looking Solana on-chain activity.

// ---------- pseudo-RNG (seeded for stable refresh) ----------
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xBADC0DE);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const randf = (a, b) => a + rand() * (b - a);
const chance = (p) => rand() < p;

// ---------- Solana-style addresses (base58, ~44 chars) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function mkAddr(len = 44) {
  let s = '';
  for (let i = 0; i < len; i++) s += B58[Math.floor(rand() * B58.length)];
  return s;
}
function shortAddr(a) {
  if (!a) return '';
  return a.slice(0, 4) + '…' + a.slice(-4);
}

// ---------- ticker name generators ----------
const TICKER_PREFIX = ['MEGA', 'BASED', 'NEON', 'GIGA', 'TURBO', 'HYPER', 'SOL', 'DEGEN', 'PEPE', 'CHAD', 'WIF', 'MOON', 'PUMP', 'APE', 'INU', 'SHIB', 'BORK', 'FOMO', 'COPE', 'JEET', 'RUG', 'KEK', 'WOJAK', 'BOND', 'QUANT', 'NODE', 'GHOST', 'DARK', 'CYBER', 'NULL', 'VOID', 'PROBE', 'AXIS', 'ORB', 'LINK'];
const TICKER_SUFFIX = ['CAT', 'DOG', 'COIN', 'AI', '69', '420', 'X', 'V2', 'INU', 'BABY', 'KING', 'PRIME', 'MAX', 'SOL', 'GOD', 'MEME', 'LORD', 'PROTOCOL', 'CHAIN', 'NET', 'CORE'];

function mkTicker() {
  const p = pick(TICKER_PREFIX);
  const s = pick(TICKER_SUFFIX);
  if (chance(0.4)) return p;
  return p + s;
}

const NAME_WORDS = ['Probability', 'Continuation', 'Distribution', 'Reflexive', 'Asymmetric', 'Cascade', 'Liquidity', 'Velocity', 'Discovery', 'Convex', 'Mirror', 'Anomaly', 'Catalyst', 'Resonance', 'Convergence', 'Drift', 'Pulse', 'Ledger', 'Synthesis', 'Echelon', 'Vector', 'Orbit', 'Mantle', 'Apex'];
function mkName() {
  return pick(NAME_WORDS) + ' ' + pick(NAME_WORDS);
}

// ---------- wallet classifications ----------
const WALLET_CLASSES = [
  { id: 'elite', label: 'ELITE EARLY', tone: 'g', weight: 0.04 },
  { id: 'cont',  label: 'CONTINUATION', tone: 'g', weight: 0.08 },
  { id: 'sniper', label: 'SNIPER', tone: 'a', weight: 0.12 },
  { id: 'scalp', label: 'SCALPER', tone: '', weight: 0.18 },
  { id: 'dist',  label: 'DISTRIBUTION', tone: 'r', weight: 0.10 },
  { id: 'insider', label: 'INSIDER', tone: 'r', weight: 0.06 },
  { id: 'bad', label: 'BAD WALLET', tone: 'r', weight: 0.12 },
  { id: 'unknown', label: 'UNKNOWN', tone: '', weight: 0.30 },
];

function rollWalletClass() {
  const r = rand();
  let acc = 0;
  for (const c of WALLET_CLASSES) { acc += c.weight; if (r <= acc) return c; }
  return WALLET_CLASSES[WALLET_CLASSES.length - 1];
}

// ---------- WALLETS ----------
const wallets = [];
const walletByAddr = {};
for (let i = 0; i < 220; i++) {
  const cls = rollWalletClass();
  let winRate, avgX, holdMin, entryMC, ath;
  if (cls.id === 'elite') {
    winRate = randf(0.42, 0.68); avgX = randf(3.2, 12.0); holdMin = randint(20, 240); entryMC = randint(2000, 9000);
  } else if (cls.id === 'cont') {
    winRate = randf(0.36, 0.55); avgX = randf(2.2, 6.5); holdMin = randint(40, 360); entryMC = randint(8000, 28000);
  } else if (cls.id === 'sniper') {
    winRate = randf(0.18, 0.34); avgX = randf(1.2, 2.4); holdMin = randint(1, 8); entryMC = randint(1000, 4000);
  } else if (cls.id === 'scalp') {
    winRate = randf(0.28, 0.46); avgX = randf(1.4, 2.2); holdMin = randint(3, 20); entryMC = randint(5000, 20000);
  } else if (cls.id === 'dist') {
    winRate = randf(0.30, 0.50); avgX = randf(1.6, 3.0); holdMin = randint(8, 60); entryMC = randint(10000, 40000);
  } else if (cls.id === 'insider') {
    winRate = randf(0.55, 0.85); avgX = randf(2.0, 8.0); holdMin = randint(2, 30); entryMC = randint(800, 4000);
  } else if (cls.id === 'bad') {
    winRate = randf(0.05, 0.18); avgX = randf(0.4, 0.9); holdMin = randint(5, 90); entryMC = randint(15000, 80000);
  } else {
    winRate = randf(0.15, 0.40); avgX = randf(0.6, 1.8); holdMin = randint(5, 120); entryMC = randint(5000, 60000);
  }

  const tokensTraded = cls.id === 'elite' ? randint(140, 480)
    : cls.id === 'insider' ? randint(20, 110)
    : cls.id === 'unknown' ? randint(1, 18)
    : randint(40, 520);

  wallets.push({
    addr: mkAddr(),
    cls,
    score: Math.round(
      cls.id === 'elite' ? randf(82, 97)
      : cls.id === 'insider' ? randf(60, 85)
      : cls.id === 'cont' ? randf(70, 88)
      : cls.id === 'scalp' ? randf(40, 60)
      : cls.id === 'dist' ? randf(38, 58)
      : cls.id === 'sniper' ? randf(25, 45)
      : cls.id === 'bad' ? randf(8, 25)
      : randf(35, 55)
    ),
    winRate,
    avgX,
    tokens: tokensTraded,
    holdMin,
    entryMC,
    realizedPnl: Math.round(randf(-40, 800) * 1000),
    funded: chance(0.3) ? 'BINANCE' : chance(0.2) ? 'COINBASE' : chance(0.3) ? 'KRAKEN' : 'OTHER',
    age: randint(8, 540), // days
    lastSeen: randint(0, 720), // seconds ago
    skill: {
      early: Math.round(randf(20, cls.id === 'elite' ? 95 : cls.id === 'insider' ? 92 : 60)),
      continuation: Math.round(randf(15, cls.id === 'cont' ? 95 : 70)),
      holding: Math.round(randf(10, cls.id === 'elite' ? 88 : 65)),
      exit: Math.round(randf(15, cls.id === 'dist' ? 92 : cls.id === 'elite' ? 88 : 60)),
      migration: Math.round(randf(10, cls.id === 'elite' ? 90 : 65)),
      risk: Math.round(randf(20, cls.id === 'elite' ? 90 : 60)),
      consistency: Math.round(randf(15, cls.id === 'elite' ? 92 : 60)),
    },
  });
}
wallets.forEach(w => { walletByAddr[w.addr] = w; });

// curated stars we reference by index
const STAR_WALLETS = wallets.filter(w => w.cls.id === 'elite' || w.cls.id === 'cont').slice(0, 12);

// ---------- DEVS ----------
const devs = [];
const devLabels = ['the-architect', 'mempool-king', 'sol-degen-42', 'liquidity-loki', 'curve-witch', 'rebase-rambo', 'silent-mint', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'];
for (let i = 0; i < 60; i++) {
  const launches = randint(3, 38);
  const migrations = Math.min(launches, Math.floor(launches * randf(0.05, 0.55)));
  const rugs = Math.min(launches - migrations, Math.floor(launches * randf(0.05, 0.4)));
  devs.push({
    addr: mkAddr(),
    alias: chance(0.35) ? pick(devLabels) : null,
    launches,
    migrations,
    rugs,
    medianATH: randint(8000, 480000),
    avgLifespanHrs: randf(0.8, 96),
    elitOverlap: Math.round(randf(0, 8)),
    score: 0, // will set
    holderGrowth: randf(0.4, 8.0),
    repeatBuyers: randint(0, 240),
    devSellFlag: chance(0.18),
    insiderCluster: chance(0.20),
    lastLaunchHrs: randf(0.1, 48),
  });
}
devs.forEach(d => {
  // weighted score
  const migrRate = d.migrations / Math.max(1, d.launches);
  const rugRate = d.rugs / Math.max(1, d.launches);
  let s = 50 + migrRate * 60 - rugRate * 70 + d.elitOverlap * 2 - (d.devSellFlag ? 15 : 0) - (d.insiderCluster ? 10 : 0);
  s = Math.max(2, Math.min(99, s + randf(-6, 6)));
  d.score = Math.round(s);
});

// ---------- TOKENS ----------
const tokens = [];
const tokenByMint = {};
const PHASES = ['LAUNCH', 'CURVE', 'CURVE', 'CURVE', 'CURVE', 'MIGRATING', 'PUMPSWAP', 'PUMPSWAP', 'DEAD'];

for (let i = 0; i < 64; i++) {
  const phase = pick(PHASES);
  const dev = pick(devs);

  let mc, ath, holders, ageMin;
  if (phase === 'LAUNCH') { mc = randint(2000, 8000); holders = randint(8, 60); ageMin = randint(0, 4); }
  else if (phase === 'CURVE') { mc = randint(6000, 65000); holders = randint(60, 800); ageMin = randint(3, 240); }
  else if (phase === 'MIGRATING') { mc = randint(60000, 72000); holders = randint(400, 1200); ageMin = randint(40, 320); }
  else if (phase === 'PUMPSWAP') { mc = randint(70000, 2400000); holders = randint(700, 12000); ageMin = randint(60, 4800); }
  else { mc = randint(800, 18000); holders = randint(30, 600); ageMin = randint(60, 1440); }

  ath = Math.round(mc * (phase === 'DEAD' ? randf(3, 28) : randf(1.0, 2.6)));
  if (phase === 'LAUNCH') ath = mc;

  const smartCount = phase === 'LAUNCH' ? randint(0, 4)
    : phase === 'CURVE' ? randint(0, 14)
    : phase === 'MIGRATING' ? randint(3, 22)
    : phase === 'PUMPSWAP' ? randint(2, 34)
    : randint(0, 6);

  const insiderConc = phase === 'DEAD' ? randf(0.25, 0.7) : randf(0.02, 0.45);

  // probability calculation
  let prob;
  if (phase === 'DEAD') prob = randf(2, 14);
  else if (phase === 'LAUNCH') prob = randf(10, 78);
  else if (phase === 'CURVE') prob = randf(8, 86);
  else if (phase === 'MIGRATING') prob = randf(58, 92);
  else if (phase === 'PUMPSWAP') prob = randf(20, 84);
  prob = Math.round(prob * 10) / 10;

  // build probability history (1 point per minute, last 60)
  const ph = [];
  let p = Math.max(5, prob - randf(0, 25));
  for (let j = 0; j < 60; j++) {
    p += randf(-3, 3);
    p = Math.max(3, Math.min(97, p));
    ph.push(Math.round(p * 10) / 10);
  }
  ph[ph.length - 1] = prob;

  // MC history (60 points)
  const mh = [];
  let m = mc * randf(0.2, 0.9);
  for (let j = 0; j < 60; j++) {
    m *= randf(0.94, 1.07);
    mh.push(Math.round(m));
  }
  mh[mh.length - 1] = mc;

  // signal composition (the why)
  const signals = [];
  if (dev.score > 70) signals.push({ s: +randint(12, 22), label: 'High-rep dev', detail: dev.alias || shortAddr(dev.addr) });
  if (dev.score < 30) signals.push({ s: -randint(10, 18), label: 'Low-rep dev', detail: `${dev.rugs}/${dev.launches} rugs` });
  if (smartCount >= 3) signals.push({ s: +randint(10, 24), label: `${smartCount} smart wallets in`, detail: 'avg entry ' + (randint(2, 14) + 'k MC') });
  if (smartCount === 0 && phase !== 'LAUNCH') signals.push({ s: -8, label: 'No smart money', detail: '' });
  if (insiderConc > 0.30) signals.push({ s: -randint(18, 28), label: 'Insider concentration', detail: (insiderConc * 100).toFixed(0) + '% top-10' });
  if (insiderConc < 0.10) signals.push({ s: +randint(4, 10), label: 'Low insider conc.', detail: (insiderConc * 100).toFixed(1) + '%' });
  const holderGrowth = randf(-0.2, 8.0);
  if (holderGrowth > 2.0) signals.push({ s: +randint(6, 14), label: 'Strong holder growth', detail: '+' + holderGrowth.toFixed(1) + '/min' });
  if (holderGrowth < 0.2 && phase !== 'LAUNCH') signals.push({ s: -randint(4, 10), label: 'Stagnant holders', detail: holderGrowth.toFixed(2) + '/min' });
  const buyPressure = randf(0.3, 2.4);
  if (buyPressure > 1.4) signals.push({ s: +randint(5, 12), label: 'Buy pressure dominant', detail: 'B/S ' + buyPressure.toFixed(2) });
  if (buyPressure < 0.7) signals.push({ s: -randint(5, 12), label: 'Sell pressure dominant', detail: 'B/S ' + buyPressure.toFixed(2) });
  if (dev.devSellFlag) signals.push({ s: -randint(12, 22), label: 'Dev sold', detail: 'reduced exposure' });
  if (chance(0.18) && phase !== 'LAUNCH') signals.push({ s: -randint(6, 14), label: 'Smart wallet exits', detail: randint(1, 4) + ' exited' });
  if (phase === 'MIGRATING') signals.push({ s: +randint(8, 16), label: 'Approaching migration', detail: ((mc - 60000) / 9000 * 100).toFixed(0) + '%' });

  const symbol = mkTicker();
  const tk = {
    mint: mkAddr(),
    symbol,
    name: chance(0.7) ? mkName() : symbol.toLowerCase() + ' protocol',
    dev,
    phase,
    mc,
    ath,
    holders,
    ageMin,
    smartCount,
    smartNetFlow: Math.round(randf(-180, 480) * (smartCount > 0 ? 1 : 0.2)),
    insiderConc,
    holderGrowth,
    buyPressure,
    volume24h: Math.round(mc * randf(0.3, 8.0)),
    prob,
    probHistory: ph,
    mcHistory: mh,
    signals: signals.sort((a, b) => Math.abs(b.s) - Math.abs(a.s)),
    curveProgress: phase === 'CURVE' ? Math.min(100, (mc / 69000) * 100) : (phase === 'MIGRATING' ? randf(92, 99) : (phase === 'PUMPSWAP' ? 100 : (mc/69000)*100)),
    bonded: phase === 'PUMPSWAP',
    snipersOut: randint(0, 14),
    topHolderPct: randf(2, 18),
  };
  tokens.push(tk);
  tokenByMint[tk.mint] = tk;
}

// pick a "featured" token to deep-dive (high prob, CURVE/MIGRATING)
tokens.sort((a, b) => b.prob - a.prob);
const FEATURED_TOKEN = tokens.find(t => t.phase === 'MIGRATING' || t.phase === 'CURVE') || tokens[0];

// re-sort by age so feed feels fresh
tokens.sort((a, b) => a.ageMin - b.ageMin);

// ---------- TRADES (recent tape for featured token) ----------
function mkTrade(token, secondsAgo) {
  const w = pick(wallets);
  const side = chance(0.62) ? 'buy' : 'sell';
  const sol = randf(0.2, 28);
  const mc = token.mcHistory[Math.max(0, token.mcHistory.length - 1 - Math.floor(secondsAgo / 30))] || token.mc;
  return {
    side, sol,
    wallet: w,
    mc,
    secondsAgo,
  };
}
const tradeTape = [];
{
  let t = 0;
  for (let i = 0; i < 80; i++) {
    t += randint(1, 14);
    tradeTape.push(mkTrade(FEATURED_TOKEN, t));
  }
}

// ---------- ALERTS ----------
const ALERT_TEMPLATES = [
  { tone: 'good', icon: '↑', tpl: (t) => `Elite wallet ${shortAddr(pick(STAR_WALLETS).addr)} entered $${t.symbol} at ${fmtMC(t.mc * 0.6)}` },
  { tone: 'good', icon: '↑', tpl: (t) => `${randint(2,5)} smart wallets accumulating $${t.symbol} — net +${randint(80, 420)} SOL` },
  { tone: 'good', icon: '★', tpl: (t) => `High-reputation dev ${t.dev.alias || shortAddr(t.dev.addr)} launched $${t.symbol}` },
  { tone: 'good', icon: 'P', tpl: (t) => `$${t.symbol} probability crossed ${randint(70, 90)}% threshold` },
  { tone: 'warn', icon: '!', tpl: (t) => `Insider concentration ${randint(35, 58)}% on $${t.symbol} — caution` },
  { tone: 'warn', icon: '⇣', tpl: (t) => `Smart wallet distribution beginning on $${t.symbol} — ${randint(1,3)} exits in last 90s` },
  { tone: 'crit', icon: '✕', tpl: (t) => `Dev sold ${randint(20, 70)}% on $${t.symbol}` },
  { tone: 'crit', icon: '⇣', tpl: (t) => `$${t.symbol} probability collapsed ${randint(15, 35)}pp in 60s` },
  { tone: 'good', icon: 'M', tpl: (t) => `$${t.symbol} approaching migration — curve at ${randint(88, 99)}%` },
  { tone: 'warn', icon: '?', tpl: (t) => `Wallet cluster of ${randint(3, 7)} synced entries on $${t.symbol}` },
];

const alerts = [];
{
  let t = 0;
  for (let i = 0; i < 80; i++) {
    t += randint(4, 95);
    const tpl = pick(ALERT_TEMPLATES);
    const tk = pick(tokens);
    alerts.push({
      id: i,
      secondsAgo: t,
      tone: tpl.tone,
      icon: tpl.icon,
      msg: tpl.tpl(tk),
      token: tk,
    });
  }
}
alerts.sort((a, b) => a.secondsAgo - b.secondsAgo);

// ---------- FORMATTING ----------
function fmtMC(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 1 : 2) + 'k';
  return n.toFixed(0);
}
function fmtSol(n) {
  if (n == null) return '—';
  if (n >= 1000) return (n/1000).toFixed(2) + 'k';
  return n.toFixed(n < 10 ? 2 : 1);
}
function fmtAge(min) {
  if (min < 1) return '< 1m';
  if (min < 60) return Math.floor(min) + 'm';
  if (min < 1440) return Math.floor(min / 60) + 'h ' + Math.floor(min % 60) + 'm';
  return Math.floor(min / 1440) + 'd ' + Math.floor((min % 1440)/60) + 'h';
}
function fmtSec(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function fmtPct(n, digits=1) {
  return (n).toFixed(digits) + '%';
}
function fmtClock(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC';
}

// ---------- export to window ----------
Object.assign(window, {
  // data
  wallets, walletByAddr, devs, tokens, tokenByMint,
  FEATURED_TOKEN, STAR_WALLETS, tradeTape, alerts,
  WALLET_CLASSES,
  // helpers
  mkAddr, shortAddr,
  fmtMC, fmtSol, fmtAge, fmtSec, fmtPct, fmtClock,
  rand, pick, randint, randf, chance,
});
