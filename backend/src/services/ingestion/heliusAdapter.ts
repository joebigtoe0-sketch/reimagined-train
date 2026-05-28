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
  private trackedWallets = new Set<string>(env.HELIUS_MONITORED_WALLETS.split(",").map((v) => v.trim()).filter(Boolean));
  private readonly globalAddresses = env.HELIUS_GLOBAL_ADDRESSES.split(",").map((v) => v.trim()).filter(Boolean);

  decodeWebhookPayload(payload: unknown): HeliusRawEvent[] {
    return decodeEnhancedTransactions(payload);
  }

  addDiscoveredWallet(wallet: string): void {
    const normalized = wallet.trim();
    if (!normalized || normalized === "UNKNOWN_WALLET") return;
    this.trackedWallets.add(normalized);
    if (this.trackedWallets.size > env.HELIUS_MAX_TRACKED_WALLETS) {
      this.trackedWallets = new Set([...this.trackedWallets].slice(-env.HELIUS_MAX_TRACKED_WALLETS));
    }
  }

  addDiscoveredWallets(wallets: string[]): void {
    for (const wallet of wallets) this.addDiscoveredWallet(wallet);
  }

  async poll(): Promise<HeliusRawEvent[]> {
    if (!env.HELIUS_API_KEY) return [];
    const signatures = await this.fetchSignatures();
    if (signatures.length === 0) return [];
    const enhanced = await this.fetchEnhancedTransactions(signatures.map((s) => s.signature));
    return decodeEnhancedTransactions(enhanced);
  }

  private async fetchSignatures(): Promise<SignatureRow[]> {
    const rpcUrl = `${env.HELIUS_RPC_URL}${env.HELIUS_API_KEY}`;
    const output: SignatureRow[] = [];
    const pollAddresses = [...this.globalAddresses, ...this.trackedWallets];
    if (pollAddresses.length === 0) return [];

    for (const wallet of pollAddresses) {
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
