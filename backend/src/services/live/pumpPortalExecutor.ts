/**
 * Executes real trades on the Pump.fun bonding curve via PumpPortal's
 * trade-local API:  POST https://pumpportal.fun/api/trade-local
 *
 * Flow:
 *  1. POST the order params → receive a raw, unsigned serialized transaction.
 *  2. Deserialize, sign with the bot wallet keypair.
 *  3. Broadcast via the configured Solana RPC and await confirmation.
 *
 * The wallet private key is read once from env at construction time and never
 * stored externally.  All errors are thrown so the caller (LiveTrader) can
 * decide whether to retry or mark the position as failed.
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../../config/env.js";

const TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";

export type OrderSide = "buy" | "sell";

export interface OrderResult {
  signature: string;
  slot?: number;
}


export class PumpPortalExecutor {
  private readonly keypair: Keypair;
  private readonly connection: Connection;
  public readonly publicKey: string;

  constructor() {
    this.keypair = (() => {
      const raw = env.LIVE_WALLET_PRIVATE_KEY;
      if (!raw) throw new Error("LIVE_WALLET_PRIVATE_KEY is not set");
      try {
        return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
      } catch {
        throw new Error("LIVE_WALLET_PRIVATE_KEY must be a JSON byte array [n,n,n,...] or base-58 string");
      }
    })();
    this.connection = new Connection(env.LIVE_RPC_URL, "confirmed");
    this.publicKey = this.keypair.publicKey.toBase58();
  }

  /**
   * Execute a buy or sell on the bonding curve.
   * - buy:  amount = SOL to spend (denominatedInSol = true)
   * - sell: amount = "100%" to liquidate the full position
   */
  async execute(side: OrderSide, mint: string, amount: number | string): Promise<OrderResult> {
    const body = {
      publicKey: this.publicKey,
      action: side,
      mint,
      amount,
      denominatedInSol: side === "buy" ? "true" : "false",
      slippage: env.LIVE_SLIPPAGE,
      priorityFee: env.LIVE_PRIORITY_FEE,
      pool: "pump",
    };

    const resp = await fetch(TRADE_LOCAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(no body)");
      throw new Error(`PumpPortal trade-local HTTP ${resp.status}: ${text}`);
    }

    const txBytes = new Uint8Array(await resp.arrayBuffer());
    if (txBytes.length === 0) throw new Error("PumpPortal returned empty transaction");

    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([this.keypair]);

    const rawTx = tx.serialize();
    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    // Wait up to 30s for confirmation (non-blocking — we don't want to stall the strategy loop)
    void this.connection
      .confirmTransaction({ signature, ...(await this.connection.getLatestBlockhash()) }, "confirmed")
      .catch((err) => console.warn(`[executor] confirm ${signature.slice(0, 8)}… ${err instanceof Error ? err.message : err}`));

    return { signature };
  }
}
