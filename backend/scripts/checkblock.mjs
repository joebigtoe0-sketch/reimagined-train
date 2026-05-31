/**
 * checkblock.mjs — inspect ALL transactions in a Solana block
 * looking for large SOL spenders (Jito bundle buyers).
 *
 * Usage: node scripts/checkblock.mjs <MINT_ADDRESS>
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const MINT = process.argv[2];
if (!MINT) { console.error("Usage: node scripts/checkblock.mjs <MINT>"); process.exit(1); }

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPC = process.env.HELIUS_RPC_URL || process.env.ALCHEMY_API || "https://api.mainnet-beta.solana.com";
console.log(`RPC: ${RPC.includes("helius") ? "Helius" : RPC.includes("alchemy") ? "Alchemy" : "Public"}\n`);

const rpc = async (body) => {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.result;
};

// Derive bonding curve PDA
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("bonding-curve"), new PublicKey(MINT).toBytes()],
  PUMP_PROGRAM,
);
console.log(`Mint:           ${MINT}`);
console.log(`Bonding curve:  ${pda.toBase58()}\n`);

// Find the create transaction + its block
const mintSigs = await rpc({ jsonrpc:"2.0",id:1, method:"getSignaturesForAddress", params:[MINT,{limit:5}] });
const createSig = mintSigs?.[mintSigs.length - 1];
if (!createSig) { console.log("No create tx found."); process.exit(1); }
console.log(`Create tx: ${createSig.signature.slice(0,20)}...  block=${createSig.blockTime ? new Date(createSig.blockTime*1000).toISOString() : "?"}`);

// Fetch the create tx to find its slot
const createTx = await rpc({ jsonrpc:"2.0",id:2, method:"getTransaction",
  params:[createSig.signature, {encoding:"json", maxSupportedTransactionVersion:0}] });
const slot = createTx?.slot;
console.log(`Slot: ${slot}\n`);

// ── Key insight: check ALL balance entries (not just staticAccountKeys)
// V0 txs have ALT-loaded accounts at indices beyond staticAccountKeys.length
// preBalances/postBalances covers ALL accounts including ALT-loaded ones.
function largeSpenders(tx, minSol = 5) {
  const keys   = tx.transaction?.message?.staticAccountKeys ?? tx.transaction?.message?.accountKeys ?? [];
  const pre    = tx.meta?.preBalances  ?? [];
  const post   = tx.meta?.postBalances ?? [];
  const total  = pre.length; // includes ALT-loaded accounts

  const spenders = [];
  for (let i = 0; i < total; i++) {
    const delta = (post[i] ?? 0) - (pre[i] ?? 0);
    if (delta < -(minSol * 1e9)) {
      const addr = i < keys.length ? (typeof keys[i] === "string" ? keys[i] : keys[i].pubkey) : `[ALT-loaded idx ${i}]`;
      spenders.push({ addr, sol: Math.abs(delta) / 1e9, idx: i, isAlt: i >= keys.length });
    }
  }
  return spenders;
}

// Fetch bonding curve sigs and check each for large spenders
console.log(`--- All bonding curve transactions, showing ALL balance changes ---`);
const bcSigs = await rpc({ jsonrpc:"2.0",id:3, method:"getSignaturesForAddress", params:[pda.toBase58(),{limit:20}] });
if (!bcSigs || bcSigs.length === 0) {
  console.log("❌ No sigs for bonding curve at all!");
} else {
  const sorted = [...bcSigs].reverse();
  for (const sig of sorted) {
    await new Promise(r => setTimeout(r, 200));
    const tx = await rpc({ jsonrpc:"2.0",id:4, method:"getTransaction",
      params:[sig.signature, {encoding:"json", maxSupportedTransactionVersion:0, commitment:"confirmed"}] });
    if (!tx) { console.log(`  ${sig.signature.slice(0,12)}... not found`); continue; }

    const keys   = tx.transaction?.message?.staticAccountKeys ?? tx.transaction?.message?.accountKeys ?? [];
    const pre    = tx.meta?.preBalances  ?? [];
    const ts     = sig.blockTime ? new Date(sig.blockTime*1000).toISOString().slice(11,19) : "?";
    const sigSlot = tx.slot;

    const spenders = largeSpenders(tx, 0.5); // show anything > 0.5 SOL
    const big = spenders.filter(s => s.sol >= 7);

    if (big.length > 0) {
      for (const s of big) {
        console.log(`  ✅ ${sig.signature.slice(0,12)}... [${ts}] slot=${sigSlot}  🔥 ${s.addr.slice(0,12)} spent ${s.sol.toFixed(3)} SOL${s.isAlt ? " [ALT-loaded!]" : ""}`);
      }
    } else {
      const top = spenders[0];
      console.log(`  ${sig.signature.slice(0,12)}... [${ts}] slot=${sigSlot}  staticKeys=${keys.length} balEntries=${pre.length}${top ? `  max spend: ${top.sol.toFixed(4)} SOL` : ""}`);
    }
  }
}

// Also check the create tx itself for large spenders (bundle might be all in one tx)
console.log(`\n--- Create tx balance analysis (checking ALL ${createTx?.meta?.preBalances?.length ?? 0} balance entries) ---`);
const createSpenders = largeSpenders(createTx, 0.5);
if (createSpenders.length > 0) {
  for (const s of createSpenders) {
    const tag = s.isAlt ? " [⚠️ ALT-loaded — missed by old code!]" : "";
    console.log(`  ${s.addr.slice(0,16)} spent ${s.sol.toFixed(4)} SOL${tag}`);
  }
} else {
  const pre = createTx?.meta?.preBalances ?? [];
  const keys = createTx?.transaction?.message?.staticAccountKeys ?? [];
  console.log(`  No spenders >0.5 SOL. staticKeys=${keys.length}  balanceEntries=${pre.length}`);
}
