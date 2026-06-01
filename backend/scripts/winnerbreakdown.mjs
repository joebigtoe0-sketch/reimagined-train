/**
 * winnerbreakdown.mjs — analyze the generated CSV to show what MC the "winners"
 * actually reached, and clarify winner vs migration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(__dirname, "..", "exports", "jito_bundle_tokens.csv");

const lines = fs.readFileSync(CSV, "utf8").trim().split("\n").slice(1);
const rows = lines.map(l => {
  const [rank, result, mint, symbol, entryMc, peakMc, exitMc, growthX, pnlPct, pnlSol, gangBuyers, ...rest] = l.split(",");
  return { result, entryMc: +entryMc, peakMc: +peakMc, exitMc: +exitMc, growthX: +growthX, pnlPct: +pnlPct, pnlSol: +pnlSol };
});

const winners = rows.filter(r => r.result === "WIN");
const losers  = rows.filter(r => r.result === "LOSS");

console.log(`Total: ${rows.length}  Winners: ${winners.length}  Losers: ${losers.length}\n`);

// Peak MC distribution for WINNERS
const buckets = [
  ["< 10k",        r => r.peakMc < 10_000],
  ["10k – 15k",    r => r.peakMc >= 10_000 && r.peakMc < 15_000],
  ["15k – 20k",    r => r.peakMc >= 15_000 && r.peakMc < 20_000],
  ["20k – 30k",    r => r.peakMc >= 20_000 && r.peakMc < 30_000],
  ["30k – 40k",    r => r.peakMc >= 30_000 && r.peakMc < 40_000],
  ["40k – 50k",    r => r.peakMc >= 40_000 && r.peakMc < 50_000],
  ["50k – 60k",    r => r.peakMc >= 50_000 && r.peakMc < 60_000],
  ["60k+ (migrate)", r => r.peakMc >= 60_000],
];

console.log("WINNERS — what PEAK MC did they reach?");
console.log("─".repeat(64));
console.log("Peak MC bucket    │  count  │  % of winners │ avg PnL%");
console.log("─".repeat(64));
for (const [label, fn] of buckets) {
  const g = winners.filter(fn);
  if (!g.length) continue;
  const avgPnl = g.reduce((a,r)=>a+r.pnlPct,0)/g.length;
  console.log(`${label.padEnd(17)} │ ${String(g.length).padStart(6)}  │ ${(g.length/winners.length*100).toFixed(1).padStart(11)}%  │ +${avgPnl.toFixed(0)}%`);
}
console.log("─".repeat(64));

// Growth distribution
console.log("\nWINNERS — peak growth multiple vs entry:");
const gb = [["1.1–1.5x",r=>r.growthX<1.5],["1.5–2x",r=>r.growthX>=1.5&&r.growthX<2],["2–3x",r=>r.growthX>=2&&r.growthX<3],["3–5x",r=>r.growthX>=3&&r.growthX<5],["5–8x",r=>r.growthX>=5&&r.growthX<8],["8x+",r=>r.growthX>=8]];
for (const [label, fn] of gb) {
  const g = winners.filter(fn);
  console.log(`  ${label.padEnd(9)}: ${String(g.length).padStart(5)}  (${(g.length/winners.length*100).toFixed(1)}%)`);
}

// The key clarification
const wonButDidNotMigrate = winners.filter(r => r.peakMc < 60_000).length;
console.log(`\n── KEY POINT ──────────────────────────────────────────────`);
console.log(`Winners that did NOT reach migration (peak < 60k): ${wonButDidNotMigrate} (${(wonButDidNotMigrate/winners.length*100).toFixed(1)}% of winners)`);
console.log(`These won by pumping partway then exiting on the trailing stop.`);
console.log(`A "win" only needs exit > ~1.11x entry (peak ≥ ~1.48x to clear the 25% trail + slippage).`);

// median peak among winners
const medPeak = [...winners].sort((a,b)=>a.peakMc-b.peakMc)[Math.floor(winners.length/2)].peakMc;
const medGrowth = [...winners].sort((a,b)=>a.growthX-b.growthX)[Math.floor(winners.length/2)].growthX;
console.log(`\nMedian winner: peak MC = $${medPeak.toLocaleString()}, growth = ${medGrowth.toFixed(2)}x`);

// SOL price implication
console.log(`\n── SOL PRICE CHECK ────────────────────────────────────────`);
const migPeaks = winners.filter(r=>r.peakMc>=60000 && r.peakMc<63000).map(r=>r.peakMc);
const typicalMig = migPeaks.length ? migPeaks.sort((a,b)=>a-b)[Math.floor(migPeaks.length/2)] : 61632;
console.log(`Typical migration MC in data: $${typicalMig.toLocaleString()}`);
console.log(`Migration is a FIXED ~410 SOL of curve. Implied SOL price in data: $${(typicalMig/410).toFixed(0)}`);
console.log(`At today's SOL ~$83, that same migration = $${Math.round(410*83).toLocaleString()} (matches the ~35k you see now).`);
