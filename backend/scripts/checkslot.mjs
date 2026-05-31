/**
 * checkslot.mjs — fetch a specific block and find all txs touching a token's
 * bonding curve, reporting 7+ SOL spenders (same-block Jito bundle buyers).
 *
 * Usage: node scripts/checkslot.mjs <MINT> <SLOT>
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const MINT = process.argv[2];
const SLOT = Number(process.argv[3]);
if (!MINT || !SLOT) { console.error("Usage: node scripts/checkslot.mjs <MINT> <SLOT>"); process.exit(1); }

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPC = process.env.HELIUS_RPC_URL || process.env.ALCHEMY_API || "https://api.mainnet-beta.solana.com";
console.log(`RPC: ${RPC.includes("helius") ? "Helius" : RPC.includes("alchemy") ? "Alchemy" : "Public"}\n`);

const rpc = async (body) => {
  const r = await fetch(RPC, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.result;
};

const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("bonding-curve"), new PublicKey(MINT).toBytes()], PUMP_PROGRAM);
const bc = pda.toBase58();
console.log(`Mint:          ${MINT}`);
console.log(`Bonding curve: ${bc}`);
console.log(`Slot:          ${SLOT}\n`);

const block = await rpc({ jsonrpc:"2.0", id:1, method:"getBlock", params:[SLOT, {
  encoding:"json", maxSupportedTransactionVersion:0, transactionDetails:"full", rewards:false,
}]});

if (!block) { console.log("Block not found / not available."); process.exit(1); }
console.log(`Block ${SLOT} has ${block.transactions.length} transactions. Scanning for bonding-curve touches…\n`);

let found = 0;
for (const t of block.transactions) {
  const m = t.transaction?.message;
  const staticKeys = (m?.staticAccountKeys ?? m?.accountKeys ?? []).map(k => typeof k==="string"?k:k.pubkey);
  const lw = t.meta?.loadedAddresses?.writable ?? [];
  const lr = t.meta?.loadedAddresses?.readonly ?? [];
  const keys = [...staticKeys, ...lw, ...lr];

  if (!keys.includes(bc)) continue;  // tx doesn't touch this bonding curve
  found++;

  const pre = t.meta?.preBalances ?? [];
  const post = t.meta?.postBalances ?? [];
  const sig = t.transaction?.signatures?.[0] ?? "?";

  const spenders = [];
  for (let i = 0; i < pre.length; i++) {
    const delta = (post[i]??0) - (pre[i]??0);
    if (delta < -7_000_000_000) {
      const addr = keys[i] || `idx-${i}`;
      spenders.push({ addr, sol: Math.abs(delta)/1e9, isAlt: i >= staticKeys.length });
    }
  }

  if (spenders.length > 0) {
    console.log(`TX ${sig.slice(0,16)}... (touches bonding curve)`);
    for (const s of spenders) {
      console.log(`   🔥 ${s.addr} spent ${s.sol.toFixed(3)} SOL${s.isAlt ? " [ALT-loaded]" : ""}`);
    }
  } else {
    const small = [];
    for (let i = 0; i < pre.length; i++) {
      const delta = (post[i]??0) - (pre[i]??0);
      if (delta < 0) small.push(Math.abs(delta)/1e9);
    }
    const max = small.length ? Math.max(...small) : 0;
    console.log(`TX ${sig.slice(0,16)}... touches BC — max spend ${max.toFixed(4)} SOL (no 7+ buyer)`);
  }
}

console.log(`\n${found} transaction(s) in slot ${SLOT} touched this bonding curve.`);
