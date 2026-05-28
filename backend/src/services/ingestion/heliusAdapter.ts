import { env } from "../../config/env.js";
import type { HeliusRawEvent } from "../../domain/events/normalizer.js";
import { decodeEnhancedTransactions } from "./heliusDecoder.js";

interface SignatureRow {
  signature: string;
  slot: number;
  blockTime?: number;
}

export class HeliusAdapter {
  private lastSignatures = new Set<string>();
  private readonly monitoredWallets = env.HELIUS_MONITORED_WALLETS.split(",").map((v) => v.trim()).filter(Boolean);

  decodeWebhookPayload(payload: unknown): HeliusRawEvent[] {
    return decodeEnhancedTransactions(payload);
  }

  async poll(): Promise<HeliusRawEvent[]> {
    if (!env.HELIUS_API_KEY || this.monitoredWallets.length === 0) return [];
    const signatures = await this.fetchSignatures();
    if (signatures.length === 0) return [];
    const enhanced = await this.fetchEnhancedTransactions(signatures.map((s) => s.signature));
    return decodeEnhancedTransactions(enhanced);
  }

  private async fetchSignatures(): Promise<SignatureRow[]> {
    const rpcUrl = `${env.HELIUS_RPC_URL}${env.HELIUS_API_KEY}`;
    const output: SignatureRow[] = [];

    for (const wallet of this.monitoredWallets) {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `sig-${wallet}`,
          method: "getSignaturesForAddress",
          params: [wallet, { limit: 25 }]
        })
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: SignatureRow[] };
      for (const row of json.result ?? []) {
        if (this.lastSignatures.has(row.signature)) continue;
        this.lastSignatures.add(row.signature);
        output.push(row);
      }
    }

    if (this.lastSignatures.size > 2000) {
      this.lastSignatures = new Set([...this.lastSignatures].slice(-1200));
    }
    return output;
  }

  private async fetchEnhancedTransactions(signatures: string[]): Promise<unknown> {
    const unique = [...new Set(signatures)].slice(0, 100);
    if (unique.length === 0) return [];
    const url = `https://api.helius.xyz/v0/transactions?api-key=${env.HELIUS_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: unique })
    });
    if (!res.ok) return [];
    return res.json();
  }
}
