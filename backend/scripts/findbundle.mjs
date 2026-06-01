/**
 * findbundle.mjs — paginate to the TRUE creation tx of a token (oldest bonding-curve
 * sig), then dump every tx in that creation slot with full balance analysis to find
 * the real Jito bundle buys.
 *
 * Usage: node scripts/findbundle.mjs <MINT>
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const MINT = process.argv[2];
if (!MINT) { console.error("Usage: node scripts/findbundle.mjs <MINT>"); process.exit(1); }

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPC = process.env.HELIUS_RPC_URL || process.env.ALCHEMY_API || "https://api.mainnet-beta.solana.com";
console.log(`RPC: ${RPC.includes("helius") ? "Helius" : RPC.includes("alchemy") ? "Alchemy" : "Public"}\n`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = async (body) => {
  for (let i=0;i<5;i++){
    const r = await fetch(RPC, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
    const d = await r.json();
    if (d.error) { if (String(d.error.message||"").includes("Too many")||r.status===429){await sleep(700);continue;} throw new Error(JSON.stringify(d.error)); }
    return d.result;
  }
  throw new Error("rate limited");
};

const [pdaKey] = PublicKey.findProgramAddressSync(
  [Buffer.from("bonding-curve"), new PublicKey(MINT).toBytes()], PUMP_PROGRAM);
const bc = pdaKey.toBase58();
console.log(`Mint:          ${MINT}`);
console.log(`Bonding curve: ${bc}\n`);

// Paginate to oldest BC sig
let before, oldest, total = 0, pages = 0;
while (pages < 50) {
  const params = before ? [bc, { limit:1000, before }] : [bc, { limit:1000 }];
  const sigs = await rpc({ jsonrpc:"2.0", id:1, method:"getSignaturesForAddress", params });
  if (!sigs || sigs.length === 0) break;
  total += sigs.length;
  oldest = sigs[sigs.length-1];
  pages++;
  if (sigs.length < 1000) break;
  before = oldest.signature;
  await sleep(120);
}
console.log(`Total bonding-curve txs (approx): ${total} across ${pages} page(s)`);
console.log(`Oldest (create) sig: ${oldest.signature.slice(0,20)}...  blockTime=${oldest.blockTime?new Date(oldest.blockTime*1000).toISOString():"?"}`);

const createTx = await rpc({ jsonrpc:"2.0", id:2, method:"getTransaction",
  params:[oldest.signature, {encoding:"json", maxSupportedTransactionVersion:0}] });
const createSlot = createTx?.slot;
console.log(`Creation slot: ${createSlot}\n`);

// Dump the whole creation block, find BC-touching txs and large spenders
const block = await rpc({ jsonrpc:"2.0", id:3, method:"getBlock",
  params:[createSlot, {encoding:"json", maxSupportedTransactionVersion:0, transactionDetails:"full", rewards:false}] });
console.log(`Block ${createSlot}: ${block.transactions.length} txs. BC-touching txs & spenders:\n`);

let bcTxs = 0, bigBuys = 0;
for (const t of block.transactions) {
  const m = t.transaction?.message;
  const staticKeys = (m?.staticAccountKeys ?? m?.accountKeys ?? []).map(k=>typeof k==="string"?k:k.pubkey);
  const lw = t.meta?.loadedAddresses?.writable ?? [];
  const lr = t.meta?.loadedAddresses?.readonly ?? [];
  const keys = [...staticKeys, ...lw, ...lr];
  if (!keys.includes(bc)) continue;
  bcTxs++;
  const pre = t.meta?.preBalances ?? [], post = t.meta?.postBalances ?? [];
  const sig = t.transaction?.signatures?.[0] ?? "?";
  const spenders = [];
  for (let i=0;i<pre.length;i++){
    const sol = -((post[i]??0)-(pre[i]??0))/1e9;
    if (sol >= 0.5) spenders.push({ addr: keys[i]||`idx${i}`, sol, isAlt: i>=staticKeys.length });
  }
  spenders.sort((a,b)=>b.sol-a.sol);
  const big = spenders.filter(s=>s.sol>=7);
  if (big.length) {
    bigBuys += big.length;
    for (const s of big) console.log(`  🔥 ${sig.slice(0,14)} ${s.addr.slice(0,12)} spent ${s.sol.toFixed(3)} SOL${s.isAlt?" [ALT]":""}`);
  } else {
    const top = spenders[0];
    console.log(`  ${sig.slice(0,14)} max spend ${top?top.sol.toFixed(3):"0"} SOL`);
  }
}
console.log(`\n${bcTxs} BC txs in creation slot, ${bigBuys} buys ≥7 SOL.`);
console.log(bigBuys>0 ? "✅ This WAS a Jito bundle — retrocheck should have caught it." : "❌ No ≥7 SOL same-slot buy — not a Jito bundle by our definition.");
