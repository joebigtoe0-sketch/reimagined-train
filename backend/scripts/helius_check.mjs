import { config } from "dotenv";
config();

const mint = process.argv[2] || "GRHJFHpG7uUNDmUXesQiyaDpB3wWvTDx9mgW8ZGNpump";
const key  = process.env.HELIUS_API_KEY;

console.log("Querying Helius for:", mint);
const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${key}&limit=10`;
const resp = await fetch(url);
const body = await resp.text();

if (!resp.ok) {
  console.error("HTTP", resp.status, body);
  process.exit(1);
}

let txs;
try { txs = JSON.parse(body); } catch { console.error("Bad JSON:", body.slice(0,200)); process.exit(1); }

if (!Array.isArray(txs)) {
  console.error("Not an array:", JSON.stringify(txs).slice(0,400));
  process.exit(1);
}

console.log(`\nTotal transactions: ${txs.length}\n`);

for (const [i, tx] of txs.entries()) {
  const ts    = tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : "no-ts";
  const payer = (tx.feePayer || "?");
  // sum SOL going OUT from feePayer via nativeTransfers
  const solOut = (tx.nativeTransfers || []).reduce((acc, t) => {
    return t.fromUserAccount === payer ? acc + (t.amount || 0) / 1e9 : acc;
  }, 0);
  const tokenMints = (tx.tokenTransfers || []).map(t => t.mint).filter(Boolean);
  const uniqueMints = [...new Set(tokenMints)].filter(m =>
    m !== "So11111111111111111111111111111111111111112" &&
    m !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  console.log(`[${i}] type=${tx.type} ts=${ts} feePayer=${payer.slice(0,8)} solOut=${solOut.toFixed(4)} mints=${uniqueMints.map(m=>m.slice(0,8)).join(",") || "none"} sig=${(tx.signature||"").slice(0,12)}`);
}
