/**
 * checkbonding.mjs — Verify bonding curve PDA derivation for a mint,
 * then fetch its signatures and check for large buys.
 *
 * Usage: node scripts/checkbonding.mjs <MINT>
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const MINT = process.argv[2];
if (!MINT) { console.error("Usage: node scripts/checkbonding.mjs <MINT>"); process.exit(1); }

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const RPC = process.env.HELIUS_RPC_URL || process.env.ALCHEMY_API || "https://api.mainnet-beta.solana.com";
console.log(`RPC: ${RPC.includes("helius") ? "Helius" : RPC.includes("alchemy") ? "Alchemy" : "Public"}\n`);

const rpc = async (body) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.result;
};

// 1. Derive PDA our way
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("bonding-curve"), new PublicKey(MINT).toBytes()],
  PUMP_PROGRAM,
);
console.log(`Mint:                ${MINT}`);
console.log(`Our bonding curve:   ${pda.toBase58()}`);

// 2. Get signatures for the MINT to find the create tx
console.log(`\n--- Fetching sigs for MINT (to find create tx) ---`);
const mintSigs = await rpc({ jsonrpc:"2.0",id:1, method:"getSignaturesForAddress", params:[MINT,{limit:20}] });
if (!mintSigs || mintSigs.length === 0) { console.log("No sigs found for mint address."); }
else {
  const createSig = mintSigs[mintSigs.length - 1]; // oldest = create
  console.log(`Create tx sig: ${createSig.signature.slice(0,20)}... blockTime=${new Date(createSig.blockTime*1000).toISOString()}`);
  
  // Get the create tx to find actual bonding curve from accounts
  const tx = await rpc({ jsonrpc:"2.0",id:2, method:"getTransaction",
    params:[createSig.signature, {encoding:"json", maxSupportedTransactionVersion:0}] });
  if (tx) {
    const keys = tx.transaction?.message?.staticAccountKeys ?? tx.transaction?.message?.accountKeys ?? [];
    console.log(`\nCreate tx accounts (${keys.length}):`);
    keys.forEach((k,i) => {
      const addr = typeof k === "string" ? k : k.pubkey;
      const tag = addr === MINT ? " ← MINT"
                : addr === pda.toBase58() ? " ← OUR PDA ✓"
                : addr === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" ? " ← PUMP PROGRAM"
                : "";
      console.log(`  [${i}] ${addr}${tag}`);
    });
  }
}

// 3. Fetch sigs for our derived bonding curve
console.log(`\n--- Fetching sigs for OUR bonding curve PDA (${pda.toBase58().slice(0,8)}...) ---`);
const bcSigs = await rpc({ jsonrpc:"2.0",id:3, method:"getSignaturesForAddress", params:[pda.toBase58(),{limit:20}] });
if (!bcSigs || bcSigs.length === 0) {
  console.log("❌ No signatures found for our PDA! PDA is likely wrong.");
} else {
  console.log(`✅ Found ${bcSigs.length} signatures for bonding curve.`);
  // Sort oldest first
  const sorted = [...bcSigs].reverse();
  for (const sig of sorted.slice(0, 10)) {
    const tx = await rpc({ jsonrpc:"2.0",id:4, method:"getTransaction",
      params:[sig.signature, {encoding:"json", maxSupportedTransactionVersion:0, commitment:"confirmed"}] });
    if (!tx) { console.log(`  ${sig.signature.slice(0,12)}... not found`); continue; }
    
    const keys = tx.transaction?.message?.staticAccountKeys ?? tx.transaction?.message?.accountKeys ?? [];
    const pre  = tx.meta?.preBalances  ?? [];
    const post = tx.meta?.postBalances ?? [];
    const changes = keys.map((k,i) => ({
      addr: typeof k === "string" ? k : k.pubkey,
      delta: (post[i]??0) - (pre[i]??0),
    }));
    const bigSpenders = changes.filter(c => c.delta < -1_000_000_000)
      .sort((a,b) => a.delta - b.delta)
      .slice(0,3);
    const ts = sig.blockTime ? new Date(sig.blockTime*1000).toISOString() : "?";
    if (bigSpenders.length > 0) {
      for (const s of bigSpenders) {
        const sol = (Math.abs(s.delta)/1e9).toFixed(3);
        console.log(`  ${sig.signature.slice(0,12)}... [${ts.slice(11,19)}]  💰 ${s.addr.slice(0,8)} spent ${sol} SOL`);
      }
    } else {
      const small = changes.filter(c=>c.delta<0).sort((a,b)=>a.delta-b.delta)[0];
      const sol = small ? (Math.abs(small.delta)/1e9).toFixed(4) : "0";
      console.log(`  ${sig.signature.slice(0,12)}... [${ts.slice(11,19)}]  small: -${sol} SOL`);
    }
    await new Promise(r=>setTimeout(r,200));
  }
}
