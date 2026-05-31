/**
 * websignal.mjs — test whether having a website/twitter/telegram correlates
 * with token success by sampling tokens from our historical data.
 *
 * Method:
 *   1. Take N random "runners" (ath_mc >= 30k) and N "duds" (ath_mc < 10k)
 *      from tokens.jsonl that were also triggered by a >=7 SOL early buy.
 *   2. Fetch pump.fun metadata for each via their public API.
 *   3. Compare: what % of runners had website/twitter vs duds?
 *
 * Usage: node scripts/websignal.mjs
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, "..", "exports", "pumpfundata-pump_fun", "tokens.jsonl");
const TRADES_FILE = path.join(__dirname, "..", "exports", "pumpfundata-pump_fun", "trades.jsonl");

const TRIGGER_SOL  = 7;
const PRE_MC       = 18_000;
const RUNNER_MC    = 30_000;
const DUD_MC       = 8_000;
const SAMPLE_N     = 60;  // per bucket — enough for a clear signal

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Step 1: load token outcomes ──────────────────────────────────────────────
console.log("Step 1: loading token outcomes from tokens.jsonl…");
const tokenOutcomes = new Map(); // mint -> {athMc, lifecycle}
const rl1 = readline.createInterface({ input: fs.createReadStream(TOKENS_FILE), crlfDelay: Infinity });
for await (const line of rl1) {
  try {
    const r = JSON.parse(line);
    if (r.mint && r.ath_mc != null) tokenOutcomes.set(r.mint, { athMc: r.ath_mc, lifecycle: r.lifecycle });
  } catch {}
}
console.log(`  Loaded ${tokenOutcomes.size.toLocaleString()} token outcomes\n`);

// ─── Step 2: find >=7 SOL triggered tokens ─────────────────────────────────────
console.log("Step 2: scanning trades for >=7 SOL triggers…");
const triggered = new Set();
const rl2 = readline.createInterface({ input: fs.createReadStream(TRADES_FILE), crlfDelay: Infinity });
let lineCount = 0;
for await (const line of rl2) {
  lineCount++;
  if (lineCount % 10_000_000 === 0) process.stdout.write(`  ${(lineCount/1e6).toFixed(0)}M lines\r`);
  try {
    const r = JSON.parse(line);
    const sol   = Number(r.amount_sol ?? r.sol ?? 0);
    const mc    = Number(r.market_cap ?? r.mc ?? r.usd_market_cap ?? 0);
    const isBuy = r.is_buy !== false && r.is_buy !== 0 && r.side !== "sell";
    if (isBuy && sol >= TRIGGER_SOL && mc < PRE_MC) {
      triggered.add(r.mint ?? r.token);
    }
  } catch {}
}
console.log(`\n  Found ${triggered.size.toLocaleString()} triggered tokens\n`);

// ─── Step 3: categorise into runners and duds ──────────────────────────────────
const runners = [];
const duds = [];
for (const [mint, out] of tokenOutcomes) {
  if (!triggered.has(mint)) continue;
  if (out.athMc >= RUNNER_MC) runners.push(mint);
  else if (out.athMc < DUD_MC) duds.push(mint);
}
console.log(`Runners (ath >= $${RUNNER_MC/1000}k): ${runners.length}`);
console.log(`Duds    (ath <  $${DUD_MC/1000}k): ${duds.length}\n`);

// Sample randomly
function sample(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
const runnerSample = sample(runners, SAMPLE_N);
const dudSample    = sample(duds, SAMPLE_N);

// ─── Step 4: fetch pump.fun metadata for each ─────────────────────────────────
async function fetchMeta(mint) {
  // pump.fun's public coin API
  const url = `https://frontend-api.pump.fun/coins/${mint}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.status === 404) return null;
      if (!resp.ok) { await sleep(1000); continue; }
      return await resp.json();
    } catch { await sleep(1500); }
  }
  return null;
}

async function checkBatch(mints, label) {
  const stats = { total: 0, hasWebsite: 0, hasTwitter: 0, hasTelegram: 0, hasAnySocial: 0, fetched: 0, errors: 0 };
  console.log(`Fetching metadata for ${mints.length} ${label}…`);
  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const meta = await fetchMeta(mint);
    stats.total++;
    if (!meta) { stats.errors++; await sleep(300); continue; }
    stats.fetched++;
    const hasWeb  = !!(meta.website && meta.website.trim().length > 3);
    const hasTw   = !!(meta.twitter && meta.twitter.trim().length > 3);
    const hasTg   = !!(meta.telegram && meta.telegram.trim().length > 3);
    const hasAny  = hasWeb || hasTw || hasTg;
    if (hasWeb) stats.hasWebsite++;
    if (hasTw)  stats.hasTwitter++;
    if (hasTg)  stats.hasTelegram++;
    if (hasAny) stats.hasAnySocial++;
    if (i % 10 === 0) process.stdout.write(`  ${i+1}/${mints.length}  socials: ${stats.hasAnySocial}/${stats.fetched}\r`);
    await sleep(250); // be gentle with the API
  }
  console.log(`\n  Done: fetched=${stats.fetched} errors=${stats.errors}`);
  return stats;
}

const runnerStats = await checkBatch(runnerSample, "RUNNERS");
const dudStats    = await checkBatch(dudSample,    "DUDS");

// ─── Results ──────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(60));
console.log("RESULTS — website/social presence comparison");
console.log("═".repeat(60));
const rf = runnerStats.fetched || 1;
const df = dudStats.fetched || 1;

console.log(`\n              Runners (ath>=$${RUNNER_MC/1000}k)   Duds (ath<$${DUD_MC/1000}k)`);
console.log(`Fetched:       ${runnerStats.fetched.toString().padStart(6)}             ${dudStats.fetched}`);
console.log(`Any social:    ${(runnerStats.hasAnySocial/rf*100).toFixed(1).padStart(5)}%            ${(dudStats.hasAnySocial/df*100).toFixed(1)}%`);
console.log(`Has website:   ${(runnerStats.hasWebsite/rf*100).toFixed(1).padStart(5)}%            ${(dudStats.hasWebsite/df*100).toFixed(1)}%`);
console.log(`Has twitter:   ${(runnerStats.hasTwitter/rf*100).toFixed(1).padStart(5)}%            ${(dudStats.hasTwitter/df*100).toFixed(1)}%`);
console.log(`Has telegram:  ${(runnerStats.hasTelegram/rf*100).toFixed(1).padStart(5)}%            ${(dudStats.hasTelegram/df*100).toFixed(1)}%`);

const socialLift = (runnerStats.hasAnySocial/rf) / (dudStats.hasAnySocial/df || 0.001);
console.log(`\nSocial presence lift: ${socialLift.toFixed(2)}× (runners vs duds)`);
if (socialLift >= 1.5) {
  console.log("→ STRONG signal: social links predict success, worth adding to scoring");
} else if (socialLift >= 1.2) {
  console.log("→ MODERATE signal: some correlation, minor scoring weight");
} else {
  console.log("→ WEAK signal: not predictive enough to act on");
}
console.log("\nDone.");
