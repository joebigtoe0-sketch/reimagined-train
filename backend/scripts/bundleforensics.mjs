/**
 * bundleforensics.mjs — deep analysis of the creation block (Jito bundle) for a
 * set of tokens, to find features separating WINNERS from RUGS.
 *
 * For each mint it:
 *   1. Paginates getSignaturesForAddress(bondingCurve) to find the OLDEST tx (create).
 *   2. getBlock(creationSlot) and inspects every tx touching the bonding curve.
 *   3. Extracts bundle features (dev buy, # of 7+ buyers, total bundle SOL, sizes,
 *      known-gang count, # of small same-slot buys, buy-size spread).
 *
 * Usage: node scripts/bundleforensics.mjs
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPC = process.env.HELIUS_RPC_URL || process.env.ALCHEMY_API || "https://api.mainnet-beta.solana.com";
console.log(`RPC: ${RPC.includes("helius") ? "Helius" : RPC.includes("alchemy") ? "Alchemy" : "Public"}\n`);

// Known gang wallets
const gang = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "services", "bundle", "gangWallets.json"))));

const TOKENS = [
  { mint: "EztJNQ9xmi5Y4MUPwT7FxTQMEtSmNc5P2ixDqrf9pump", label: "WINNER (100k+)" },
  { mint: "AXQyN3Em5GH5im1sMXCde5Lyt7yqwCW2zZBYRi6ipump", label: "rug ~15k" },
  { mint: "FaeZLhTdKfM8ZSeRw5fW1sPMErGg4wv1FgN91BeQpump", label: "rug ~15k" },
  { mint: "6gL8yj7NDBTdLpXGchj82eQZ8Jo47n285KTxHJsNpump", label: "rug ~15k" },
  { mint: "878UGADy1ZA858wVugMfNNBbYEgEwuX4dQYPuhXkpump", label: "rug ~15k" },
  { mint: "3FGHW56HXagjANqVEe5U595DrZHfSVA5hovJ9YDrpump", label: "rug ~15k" },
  { mint: "8WTK8PhuWvc5Ki2SasqhAP74euUNkL5tfRuMgCP1pump", label: "rug ~15k" },
];

const rpc = async (body) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(RPC, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
    const d = await r.json();
    if (d.error) {
      if (String(d.error.message||"").includes("Too many") || r.status === 429) { await sleep(800); continue; }
      throw new Error(JSON.stringify(d.error));
    }
    return d.result;
  }
  throw new Error("rate limited after retries");
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function bcOf(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBytes()], PUMP_PROGRAM);
  return pda.toBase58();
}

// Paginate to the oldest signature for an address
async function oldestSig(addr) {
  let before = undefined;
  let oldest = null;
  for (let page = 0; page < 30; page++) {
    const params = before ? [addr, { limit: 1000, before }] : [addr, { limit: 1000 }];
    const sigs = await rpc({ jsonrpc:"2.0", id:1, method:"getSignaturesForAddress", params });
    if (!sigs || sigs.length === 0) break;
    oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000) break;        // last page
    before = oldest.signature;
    await sleep(150);
  }
  return oldest;
}

function analyzeBlockForBc(block, bc, devWallet) {
  const buys = [];   // {addr, sol, isGang}
  let devBuySol = 0;
  for (const t of block.transactions) {
    const m = t.transaction?.message;
    const staticKeys = (m?.staticAccountKeys ?? m?.accountKeys ?? []).map(k => typeof k==="string"?k:k.pubkey);
    const lw = t.meta?.loadedAddresses?.writable ?? [];
    const lr = t.meta?.loadedAddresses?.readonly ?? [];
    const keys = [...staticKeys, ...lw, ...lr];
    if (!keys.includes(bc)) continue;

    const pre = t.meta?.preBalances ?? [];
    const post = t.meta?.postBalances ?? [];
    for (let i = 0; i < pre.length; i++) {
      const delta = (post[i]??0) - (pre[i]??0);
      const sol = -delta / 1e9;
      if (sol < 0.05) continue;        // ignore tiny / non-spenders
      const addr = keys[i] || `idx-${i}`;
      if (addr === bc) continue;        // bonding curve itself receives
      if (addr === devWallet) { devBuySol += sol; continue; }
      // skip system/program accounts (no pump signer would be these)
      buys.push({ addr, sol });
    }
  }
  return { buys, devBuySol };
}

(async () => {
  const rows = [];
  for (const { mint, label } of TOKENS) {
    const bc = bcOf(mint);
    process.stdout.write(`Analyzing ${label.padEnd(16)} ${mint.slice(0,10)}… `);
    try {
      const created = await oldestSig(bc);
      if (!created) { console.log("no sigs"); continue; }
      const tx = await rpc({ jsonrpc:"2.0", id:2, method:"getTransaction",
        params:[created.signature, {encoding:"json", maxSupportedTransactionVersion:0}] });
      const slot = tx?.slot;
      const devWallet = (() => {
        const m = tx?.transaction?.message;
        const k = (m?.staticAccountKeys ?? m?.accountKeys ?? [])[0];
        return typeof k === "string" ? k : k?.pubkey;
      })();
      await sleep(150);
      const block = await rpc({ jsonrpc:"2.0", id:3, method:"getBlock",
        params:[slot, {encoding:"json", maxSupportedTransactionVersion:0, transactionDetails:"full", rewards:false}] });
      if (!block) { console.log("block unavailable"); continue; }

      const { buys, devBuySol } = analyzeBlockForBc(block, bc, devWallet);
      const big = buys.filter(b => b.sol >= 7).sort((a,b)=>b.sol-a.sol);
      const mid = buys.filter(b => b.sol >= 1 && b.sol < 7);
      const small = buys.filter(b => b.sol >= 0.05 && b.sol < 1);
      const gangBig = big.filter(b => gang.has(b.addr));
      const totalBundleSol = big.reduce((a,b)=>a+b.sol,0);
      const sizes = big.map(b=>b.sol);
      const spread = sizes.length > 1 ? (Math.max(...sizes) - Math.min(...sizes)) : 0;

      rows.push({
        label, mint: mint.slice(0,10), slot,
        devBuySol, bigCount: big.length, gangCount: gangBig.length,
        totalBundleSol, midCount: mid.length, smallCount: small.length,
        maxBuy: sizes.length?Math.max(...sizes):0, minBuy: sizes.length?Math.min(...sizes):0, spread,
        sizes: sizes.map(s=>s.toFixed(1)).join("/"),
      });
      console.log(`✓ slot=${slot} big=${big.length} gang=${gangBig.length} bundleSol=${totalBundleSol.toFixed(1)}`);
      await sleep(200);
    } catch (e) {
      console.log(`error: ${e.message}`);
    }
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════════");
  console.log("  BUNDLE FORENSICS — creation-block features");
  console.log("══════════════════════════════════════════════════════════════════════════════════");
  console.log("Label            │ DevBuy │ #7+buys │ #gang │ BundleSOL │ #1-7 │ #sub1 │ maxBuy │ sizes");
  console.log("─".repeat(98));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(16)} │ ${r.devBuySol.toFixed(2).padStart(6)} │ ${String(r.bigCount).padStart(7)} │ ${String(r.gangCount).padStart(5)} │ ${r.totalBundleSol.toFixed(1).padStart(9)} │ ${String(r.midCount).padStart(4)} │ ${String(r.smallCount).padStart(5)} │ ${r.maxBuy.toFixed(1).padStart(6)} │ ${r.sizes}`
    );
  }
  console.log("─".repeat(98));

  // Winner vs rug averages
  const W = rows.filter(r => r.label.startsWith("WINNER"));
  const R = rows.filter(r => r.label.startsWith("rug"));
  const avg = (arr, k) => arr.length ? (arr.reduce((a,x)=>a+x[k],0)/arr.length) : 0;
  if (W.length && R.length) {
    console.log("\n  Feature averages:  WINNER  vs  RUG");
    const feats = ["devBuySol","bigCount","gangCount","totalBundleSol","midCount","smallCount","maxBuy","spread"];
    for (const f of feats) {
      console.log(`    ${f.padEnd(16)}: ${avg(W,f).toFixed(2).padStart(8)}  vs  ${avg(R,f).toFixed(2).padStart(8)}`);
    }
  }
})();
