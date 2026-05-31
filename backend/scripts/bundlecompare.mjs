/**
 * bundlecompare.mjs — compare runners vs non-runners in the gang token dataset.
 * Run from backend/: node scripts/bundlecompare.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, "lib/gangTokens.json"), "utf8"));

const runners = tokens.filter(t => t.peakMc >= 50_000);
const midrun  = tokens.filter(t => t.peakMc >= 25_000 && t.peakMc < 50_000);
const norun   = tokens.filter(t => t.peakMc < 10_000);

function avg(arr, fn) { return arr.length ? arr.reduce((s, t) => s + fn(t), 0) / arr.length : 0; }
function pct(n, d) { return d ? ((n / d) * 100).toFixed(1) + "%" : "?"; }

console.log(`\nTotal: ${tokens.length}  runners(≥50k): ${runners.length}  mid(25-50k): ${midrun.length}  died(<10k): ${norun.length}\n`);

for (const [label, arr] of [
  ["RUNNERS (≥50k)", runners],
  ["MID (25-50k)", midrun],
  ["DIED (<10k)", norun],
]) {
  if (!arr.length) { console.log(`── ${label}  n=0\n`); continue; }
  console.log(`── ${label}  n=${arr.length} ─────────────────────────────────────`);
  console.log(`  avg gangWallets    : ${avg(arr, t => t.gangWalletCount).toFixed(2)}`);
  console.log(`  avg largestPreBuy  : ${avg(arr, t => t.largestPreBuy).toFixed(3)} SOL`);
  console.log(`  avg preBuyCnt      : ${avg(arr, t => t.preBuyCnt).toFixed(1)}`);
  console.log(`  avg buyToSell      : ${avg(arr, t => t.buyToSell).toFixed(2)}`);

  const big  = arr.filter(t => t.largestPreBuy >= 5).length;
  const med  = arr.filter(t => t.largestPreBuy >= 2 && t.largestPreBuy < 5).length;
  const tiny = arr.filter(t => t.largestPreBuy < 2).length;
  console.log(`  largestPreBuy ≥5   : ${big}  (${pct(big, arr.length)})`);
  console.log(`  largestPreBuy 2-5  : ${med}  (${pct(med, arr.length)})`);
  console.log(`  largestPreBuy <2   : ${tiny}  (${pct(tiny, arr.length)})`);

  const gw2  = arr.filter(t => t.gangWalletCount === 2).length;
  const gw3  = arr.filter(t => t.gangWalletCount === 3).length;
  const gw4p = arr.filter(t => t.gangWalletCount >= 4).length;
  console.log(`  gangWallets == 2   : ${gw2}  (${pct(gw2, arr.length)})`);
  console.log(`  gangWallets == 3   : ${gw3}  (${pct(gw3, arr.length)})`);
  console.log(`  gangWallets >= 4   : ${gw4p}  (${pct(gw4p, arr.length)})`);

  // buyToSell distribution
  const bsHigh  = arr.filter(t => t.buyToSell >= 8).length;
  const bsMed   = arr.filter(t => t.buyToSell >= 4 && t.buyToSell < 8).length;
  const bsLow   = arr.filter(t => t.buyToSell < 4).length;
  console.log(`  buyToSell ≥8       : ${bsHigh}  (${pct(bsHigh, arr.length)})`);
  console.log(`  buyToSell 4-8      : ${bsMed}  (${pct(bsMed, arr.length)})`);
  console.log(`  buyToSell <4       : ${bsLow}  (${pct(bsLow, arr.length)})`);
  console.log();
}

// Combination filter: what if we require largestPreBuy >= 5 AND gangWallets >= 3?
const filtered = tokens.filter(t => t.largestPreBuy >= 5 && t.gangWalletCount >= 3);
const filtRunners = filtered.filter(t => t.peakMc >= 50_000);
const filtMid     = filtered.filter(t => t.peakMc >= 25_000 && t.peakMc < 50_000);
const filtDied    = filtered.filter(t => t.peakMc < 10_000);
console.log("── FILTER: largestPreBuy≥5 AND gangWallets≥3 ─────────────────────────");
console.log(`  Tokens passing filter : ${filtered.length} / ${tokens.length}  (${pct(filtered.length, tokens.length)})`);
console.log(`  Runners ≥50k          : ${filtRunners.length}  (${pct(filtRunners.length, filtered.length)})`);
console.log(`  Mid 25-50k            : ${filtMid.length}  (${pct(filtMid.length, filtered.length)})`);
console.log(`  Died <10k             : ${filtDied.length}  (${pct(filtDied.length, filtered.length)})`);
console.log(`  avg peak MC           : $${Math.round(avg(filtered, t => t.peakMc)).toLocaleString()}`);
console.log();

// Another: largestPreBuy >= 7
const filtered2 = tokens.filter(t => t.largestPreBuy >= 7);
const filt2Run  = filtered2.filter(t => t.peakMc >= 50_000);
const filt2Mid  = filtered2.filter(t => t.peakMc >= 25_000 && t.peakMc < 50_000);
const filt2Died = filtered2.filter(t => t.peakMc < 10_000);
console.log("── FILTER: largestPreBuy≥7 (characteristic 8-9 SOL op size) ──────────");
console.log(`  Tokens passing filter : ${filtered2.length} / ${tokens.length}  (${pct(filtered2.length, tokens.length)})`);
console.log(`  Runners ≥50k          : ${filt2Run.length}  (${pct(filt2Run.length, filtered2.length)})`);
console.log(`  Mid 25-50k            : ${filt2Mid.length}  (${pct(filt2Mid.length, filtered2.length)})`);
console.log(`  Died <10k             : ${filt2Died.length}  (${pct(filt2Died.length, filtered2.length)})`);
console.log(`  avg peak MC           : $${Math.round(avg(filtered2, t => t.peakMc)).toLocaleString()}`);
console.log();

// Best combined filter
const filtered3 = tokens.filter(t => t.largestPreBuy >= 7 && t.gangWalletCount >= 3);
const filt3Run  = filtered3.filter(t => t.peakMc >= 50_000);
const filt3Mid  = filtered3.filter(t => t.peakMc >= 25_000 && t.peakMc < 50_000);
const filt3Died = filtered3.filter(t => t.peakMc < 10_000);
console.log("── FILTER: largestPreBuy≥7 AND gangWallets≥3 (strict) ──────────────────");
console.log(`  Tokens passing filter : ${filtered3.length} / ${tokens.length}  (${pct(filtered3.length, tokens.length)})`);
console.log(`  Runners ≥50k          : ${filt3Run.length}  (${pct(filt3Run.length, filtered3.length)})`);
console.log(`  Mid 25-50k            : ${filt3Mid.length}  (${pct(filt3Mid.length, filtered3.length)})`);
console.log(`  Died <10k             : ${filt3Died.length}  (${pct(filt3Died.length, filtered3.length)})`);
console.log(`  avg peak MC           : $${Math.round(avg(filtered3, t => t.peakMc)).toLocaleString()}`);
console.log();

// Sample runners (high peak)
console.log("── SAMPLE RUNNERS (highest peak) ───────────────────────────────────────");
for (const t of runners.sort((a, b) => b.peakMc - a.peakMc).slice(0, 10)) {
  console.log(`  ${t.mint}  $${t.symbol}  peak=$${Math.round(t.peakMc).toLocaleString()}  gW=${t.gangWalletCount}  bigBuy=${t.largestPreBuy}SOL  b/s=${t.buyToSell}`);
}

console.log("\n── SAMPLE DUDS (lowest peak, with ≥2 gang wallets) ────────────────────");
for (const t of norun.sort((a, b) => a.peakMc - b.peakMc).slice(0, 10)) {
  console.log(`  ${t.mint}  $${t.symbol}  peak=$${Math.round(t.peakMc).toLocaleString()}  gW=${t.gangWalletCount}  bigBuy=${t.largestPreBuy}SOL  b/s=${t.buyToSell}`);
}

console.log("\n── SAMPLE STRICT-FILTER RUNNERS (bigBuy≥7 + gangW≥3) ──────────────────");
for (const t of filtered3.sort((a, b) => b.peakMc - a.peakMc).slice(0, 5)) {
  console.log(`  ${t.mint}  $${t.symbol}  peak=$${Math.round(t.peakMc).toLocaleString()}  gW=${t.gangWalletCount}  bigBuy=${t.largestPreBuy}SOL`);
}
console.log();
