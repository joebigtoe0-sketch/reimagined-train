import { env } from "../../config/env.js";
import type { HeliusRawEvent } from "../../domain/events/normalizer.js";
import { decodeEnhancedTransactions, PUMPFUN_PROGRAM_ADDRESSES } from "./heliusDecoder.js";

interface SignatureRow {
  signature: string;
  slot: number;
  blockTime?: number;
}

export interface CoverageSnapshot {
  trackedWallets: number;
  trackedMints: number;
  globalAddresses: number;
  signaturesSeen: number;
  lastPollAt?: string;
  lastEventCount: number;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export class HeliusAdapter {
  private lastSignatures = new Set<string>();
  private trackedWallets = new Set<string>(parseList(env.HELIUS_MONITORED_WALLETS));
  private trackedMints = new Set<string>();
  private readonly globalAddresses: string[];
  private lastPollAt?: string;
  private lastEventCount = 0;

  constructor() {
    const userGlobals = parseList(env.HELIUS_GLOBAL_ADDRESSES);
    const merged = new Set<string>([...PUMPFUN_PROGRAM_ADDRESSES, ...userGlobals]);
    this.globalAddresses = [...merged];
  }

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

  addDiscoveredWallets(wallets: Iterable<string>): void {
    for (const wallet of wallets) this.addDiscoveredWallet(wallet);
  }

  addDiscoveredMint(mint: string): void {
    const normalized = mint.trim();
    if (!normalized || normalized === "UNKNOWN_MINT") return;
    this.trackedMints.add(normalized);
    if (this.trackedMints.size > env.HELIUS_MAX_TRACKED_MINTS) {
      this.trackedMints = new Set([...this.trackedMints].slice(-env.HELIUS_MAX_TRACKED_MINTS));
    }
  }

  addDiscoveredMints(mints: Iterable<string>): void {
    for (const mint of mints) this.addDiscoveredMint(mint);
  }

  coverage(): CoverageSnapshot {
    return {
      trackedWallets: this.trackedWallets.size,
      trackedMints: this.trackedMints.size,
      globalAddresses: this.globalAddresses.length,
      signaturesSeen: this.lastSignatures.size,
      lastPollAt: this.lastPollAt,
      lastEventCount: this.lastEventCount
    };
  }

  async poll(): Promise<HeliusRawEvent[]> {
    if (!env.HELIUS_API_KEY) return [];
    const signatures = await this.fetchSignatures();
    if (signatures.length === 0) {
      this.lastPollAt = new Date().toISOString();
      this.lastEventCount = 0;
      return [];
    }
    const enhanced = await this.fetchEnhancedTransactions(signatures.map((s) => s.signature));
    const decoded = decodeEnhancedTransactions(enhanced);
    this.lastPollAt = new Date().toISOString();
    this.lastEventCount = decoded.length;
    return decoded;
  }

  private async fetchSignatures(): Promise<SignatureRow[]> {
    const rpcUrl = `${env.HELIUS_RPC_URL}${env.HELIUS_API_KEY}`;
    const output: SignatureRow[] = [];

    const pollAddresses = new Set<string>([
      ...this.globalAddresses,
      ...this.trackedWallets,
      ...this.trackedMints
    ]);
    if (pollAddresses.size === 0) return [];

    for (const address of pollAddresses) {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `sig-${address}`,
            method: "getSignaturesForAddress",
            params: [address, { limit: env.HELIUS_SIGNATURE_LIMIT }]
          })
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { result?: SignatureRow[] };
        for (const row of json.result ?? []) {
          if (this.lastSignatures.has(row.signature)) continue;
          this.lastSignatures.add(row.signature);
          output.push(row);
        }
      } catch {
        continue;
      }
    }

    if (this.lastSignatures.size > 5000) {
      this.lastSignatures = new Set([...this.lastSignatures].slice(-3000));
    }
    return output;
  }

  private async fetchEnhancedTransactions(signatures: string[]): Promise<unknown> {
    const unique = [...new Set(signatures)];
    if (unique.length === 0) return [];
    const url = `https://api.helius.xyz/v0/transactions?api-key=${env.HELIUS_API_KEY}`;
    const all: unknown[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactions: batch })
        });
        if (!res.ok) continue;
        const chunk = (await res.json()) as unknown[];
        if (Array.isArray(chunk)) all.push(...chunk);
      } catch {
        continue;
      }
    }
    return all;
  }
}
