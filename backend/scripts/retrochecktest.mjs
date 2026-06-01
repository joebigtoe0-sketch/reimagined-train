/**
 * retrochecktest.mjs — replicate the EXACT live _rpcRetrocheck logic to find why
 * a known Jito bundle was missed. Tests two scenarios:
 *   (1) limit:1000 newest-first (what live does) — does the create slot survive?
 *   (2) paginated-to-oldest (ideal) — does the parsing detect the ≥7 SOL buy?
 *
 * Usage: node scripts/retrochecktest.mjs <MINT>
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const MINT = process.argv[2];
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPC = process.env.HELIUS_RPC_URL || process.env.ALCHEMY_API || "https://api.mainnet-beta.solana.com";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const rpc = async (b)=>{ for(let i=0;i<5;i++){const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const d=await r.json();if(d.error){if(String(d.error.message||"").includes("Too many")){await sleep(700);continue;}throw new Error(JSON.stringify(d.error));}return d.result;}throw new Error("rl");};

const [pdaKey] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(MINT).toBytes()], PUMP_PROGRAM);
const bc = pdaKey.toBase58();
console.log(`Bonding curve: ${bc}\n`);

// Scenario 1: exactly what live does — getSignaturesForAddress(bc, {limit:1000})
const newest = await rpc({ jsonrpc:"2.0",id:1,method:"getSignaturesForAddress",params:[bc,{limit:1000}] });
console.log(`Scenario 1 (live, limit:1000 newest-first): returned ${newest.length} sigs`);
const reversed = [...newest].reverse();
// fetch slot of first (what live calls createSlot)
const firstTx = await rpc({ jsonrpc:"2.0",id:2,method:"getTransaction",params:[reversed[0].signature,{encoding:"json",maxSupportedTransactionVersion:0}] });
const liveCreateSlot = firstTx?.slot;
console.log(`  Live would set createSlot = ${liveCreateSlot}`);
console.log(`  Oldest sig blockTime = ${reversed[0].blockTime?new Date(reversed[0].blockTime*1000).toISOString():"?"}`);

// find the TRUE create slot by pagination
let before, oldest, total=0;
while(true){
  const p = before?[bc,{limit:1000,before}]:[bc,{limit:1000}];
  const s = await rpc({jsonrpc:"2.0",id:3,method:"getSignaturesForAddress",params:p});
  if(!s||!s.length)break; total+=s.length; oldest=s[s.length-1];
  if(s.length<1000)break; before=oldest.signature; await sleep(120);
}
const trueTx = await rpc({ jsonrpc:"2.0",id:4,method:"getTransaction",params:[oldest.signature,{encoding:"json",maxSupportedTransactionVersion:0}] });
const trueCreateSlot = trueTx?.slot;
console.log(`\n  TRUE create slot (paginated): ${trueCreateSlot}  (total ${total} txs)`);
if (liveCreateSlot !== trueCreateSlot) {
  console.log(`  ❌❌ BUG: live createSlot (${liveCreateSlot}) ≠ true create slot (${trueCreateSlot})!`);
  console.log(`     With ${total} txs > 1000, limit:1000 returns only NEWEST 1000, EXCLUDING the creation block.`);
  console.log(`     → Retrocheck scans recent slots, never sees the bundle. THIS is why it missed it.`);
} else {
  console.log(`  ✓ live createSlot matches true create slot.`);
}

// Scenario 2: parse the TRUE create slot via getBlock + live parsing rules
console.log(`\nScenario 2: apply live balance-parsing to TRUE create slot ${trueCreateSlot}:`);
const block = await rpc({ jsonrpc:"2.0",id:5,method:"getBlock",params:[trueCreateSlot,{encoding:"json",maxSupportedTransactionVersion:0,transactionDetails:"full",rewards:false}] });
let detected = 0;
for (const t of block.transactions) {
  const m=t.transaction?.message;
  const staticKeys=(m?.staticAccountKeys??m?.accountKeys??[]).map(k=>typeof k==="string"?k:k.pubkey);
  const lw=t.meta?.loadedAddresses?.writable??[], lr=t.meta?.loadedAddresses?.readonly??[];
  const keys=[...staticKeys,...lw,...lr];
  if(!keys.includes(bc))continue;
  const pre=t.meta?.preBalances??[],post=t.meta?.postBalances??[];
  for(let i=0;i<pre.length;i++){
    const delta=(post[i]??0)-(pre[i]??0);
    if(delta>=-7_000_000_000)continue;
    const sol=Math.abs(delta)/1e9-0.01;
    if(sol<7)continue;
    console.log(`  ✅ would detect: ${(keys[i]||`idx${i}`).slice(0,12)} spent ${sol.toFixed(2)} SOL (sig ${t.transaction.signatures[0].slice(0,12)})`);
    detected++; break;
  }
}
console.log(`\n  Parsing detects ${detected} Jito buy(s) in the true create slot.`);
console.log(detected>0 ? "  → Parsing logic is FINE. The miss is the limit:1000 / wrong-createSlot bug above." : "  → Parsing FAILED even on correct slot — different bug.");
