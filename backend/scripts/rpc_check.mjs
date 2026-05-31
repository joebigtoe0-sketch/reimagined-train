/**
 * Test: use public Solana RPC to detect early large buys for a new mint
 * by looking at balance changes in the first transactions.
 */
const mint    = process.argv[2] || "GRHJFHpG7uUNDmUXesQiyaDpB3wWvTDx9mgW8ZGNpump";
const RPC_URL = "https://api.mainnet-beta.solana.com";

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.result;
}

// 1. Get first 5 signatures for this mint
const sigs = await rpc("getSignaturesForAddress", [mint, { limit: 5 }]);
console.log(`Signatures for ${mint.slice(0,8)}: ${sigs.length}`);

for (const sigInfo of sigs) {
  const ts = new Date((sigInfo.blockTime || 0) * 1000).toISOString();
  console.log(`\n--- sig: ${sigInfo.signature.slice(0, 20)}...  blockTime: ${ts} ---`);

  const tx = await rpc("getTransaction", [
    sigInfo.signature,
    { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ]);
  if (!tx) { console.log("  tx not found"); continue; }

  const keys    = tx.transaction?.message?.accountKeys ?? [];
  const pre     = tx.meta?.preBalances  ?? [];
  const post    = tx.meta?.postBalances ?? [];
  const changes = keys.map((k, i) => ({
    account: k,
    deltaLamports: (post[i] ?? 0) - (pre[i] ?? 0),
  }));

  // Wallets that SPENT >= 7 SOL (their balance decreased >= 7 SOL)
  const bigSpenders = changes.filter(c => c.deltaLamports < -7_000_000_000);
  if (bigSpenders.length > 0) {
    console.log("  🚨 BIG SPENDERS (>= 7 SOL):");
    bigSpenders.forEach(c => console.log(`    ${c.account.slice(0,8)}  delta=${(c.deltaLamports/1e9).toFixed(4)} SOL`));
  } else {
    console.log("  no big spenders");
    changes.filter(c => c.deltaLamports < -1_000_000_000)
      .forEach(c => console.log(`  spender: ${c.account.slice(0,8)} delta=${(c.deltaLamports/1e9).toFixed(4)} SOL`));
  }
}
