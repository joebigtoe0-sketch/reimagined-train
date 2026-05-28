import { env } from "../../config/env.js";
import type { HeliusRawEvent } from "../../domain/events/normalizer.js";
import { decodeEnhancedTransactions, PUMPFUN_PROGRAM_ADDRESSES } from "./heliusDecoder.js";

const HELIUS_REST_BASE = "https://api.helius.xyz/v0";

// When scanning the Pump.fun program we only want to find brand-new launches.
// Buys/sells are fetched per-mint AFTER we've discovered the mint from a launch event.
const LAUNCH_TYPES = "CREATE,TOKEN_MINT,UNKNOWN";
const TRADE_TYPES = "SWAP,TRANSFER";

export interface CoverageSnapshot {
  trackedWallets: number;
  trackedMints: number;
  globalAddresses: number;
  signaturesSeen: number;
  lastPollAt?: string;
  lastEventCount: number;
  mode: "launch-discovery + per-mint-trades";
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function dedup<T extends { signature: string }>(arr: T[], seen: Set<string>): T[] {
  const out: T[] = [];
  for (const item of arr) {
    if (!seen.has(item.signature)) {
      seen.add(item.signature);
      out.push(item);
    }
  }
  return out;
}

export class HeliusAdapter {
  private seenSignatures = new Set<string>();
  private trackedWallets = new Set<string>(parseList(env.HELIUS_MONITORED_WALLETS));
  private trackedMints = new Set<string>();
  private readonly globalAddresses: string[];
  private lastPollAt?: string;
  private lastEventCount = 0;

  // Cursor per program address for paginated polling
  private beforeSignatures = new Map<string, string | undefined>();

  constructor() {
    const userGlobals = parseList(env.HELIUS_GLOBAL_ADDRESSES);
    const merged = new Set<string>([...PUMPFUN_PROGRAM_ADDRESSES, ...userGlobals]);
    this.globalAddresses = [...merged];
  }

  decodeWebhookPayload(payload: unknown): HeliusRawEvent[] {
    return decodeEnhancedTransactions(payload);
  }

  addDiscoveredWallet(wallet: string): void {
    const w = wallet.trim();
    if (!w || w === "UNKNOWN_WALLET") return;
    this.trackedWallets.add(w);
    if (this.trackedWallets.size > env.HELIUS_MAX_TRACKED_WALLETS) {
      this.trackedWallets = new Set([...this.trackedWallets].slice(-env.HELIUS_MAX_TRACKED_WALLETS));
    }
  }

  addDiscoveredWallets(wallets: Iterable<string>): void {
    for (const w of wallets) this.addDiscoveredWallet(w);
  }

  addDiscoveredMint(mint: string): void {
    const m = mint.trim();
    if (!m || m === "UNKNOWN_MINT") return;
    this.trackedMints.add(m);
    if (this.trackedMints.size > env.HELIUS_MAX_TRACKED_MINTS) {
      this.trackedMints = new Set([...this.trackedMints].slice(-env.HELIUS_MAX_TRACKED_MINTS));
    }
  }

  addDiscoveredMints(mints: Iterable<string>): void {
    for (const m of mints) this.addDiscoveredMint(m);
  }

  coverage(): CoverageSnapshot {
    return {
      trackedWallets: this.trackedWallets.size,
      trackedMints: this.trackedMints.size,
      globalAddresses: this.globalAddresses.length,
      signaturesSeen: this.seenSignatures.size,
      lastPollAt: this.lastPollAt,
      lastEventCount: this.lastEventCount,
      mode: "launch-discovery + per-mint-trades"
    };
  }

  async poll(): Promise<HeliusRawEvent[]> {
    if (!env.HELIUS_API_KEY) return [];

    const results: HeliusRawEvent[] = [];

    // Step 1 — scan Pump.fun program addresses for LAUNCH events only.
    // This finds tokens the moment they are created, not their ongoing trades.
    for (const programId of this.globalAddresses) {
      try {
        const batch = await this.fetchAddressTransactions(programId, LAUNCH_TYPES);
        results.push(...batch);
        // Every discovered mint gets added to tracked mints so we start following its trades.
        for (const ev of batch) {
          if (ev.type === "launch" && ev.mint && ev.mint !== "UNKNOWN_MINT") {
            this.addDiscoveredMint(ev.mint);
          }
          for (const m of ev.mints ?? []) this.addDiscoveredMint(m);
        }
      } catch { /* skip */ }
    }

    // Step 2 — fetch buys/sells for each tracked mint (tokens we've already discovered).
    // This is how we track price action and holder behaviour from launch onward.
    // We poll the most recently active mints first to stay within rate limits.
    const mintSlice = [...this.trackedMints].slice(-Math.min(30, this.trackedMints.size));
    for (const mint of mintSlice) {
      try {
        const batch = await this.fetchAddressTransactions(mint, TRADE_TYPES);
        results.push(...batch);
      } catch { /* skip */ }
    }

    this.lastPollAt = new Date().toISOString();
    this.lastEventCount = results.length;

    if (this.seenSignatures.size > 10_000) {
      this.seenSignatures = new Set([...this.seenSignatures].slice(-6_000));
    }

    return results;
  }

  private async fetchAddressTransactions(address: string, types: string): Promise<HeliusRawEvent[]> {
    const params = new URLSearchParams({
      "api-key": env.HELIUS_API_KEY!,
      limit: String(env.HELIUS_SIGNATURE_LIMIT),
      type: types
    });
    const before = this.beforeSignatures.get(address);
    if (before) params.set("before", before);

    const url = `${HELIUS_REST_BASE}/addresses/${address}/transactions?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];

    const txns = (await res.json()) as unknown[];
    if (!Array.isArray(txns) || txns.length === 0) return [];

    const lastTx = txns[txns.length - 1] as { signature?: string };
    if (lastTx?.signature) this.beforeSignatures.set(address, lastTx.signature);

    const decoded = decodeEnhancedTransactions(txns);
    return dedup(decoded, this.seenSignatures);
  }

  /**
   * Verify that the given API key has access and that the Pump.fun programs are
   * reachable. Returns a status object surfaced at /api/ops/webhook-check.
   */
  async selfCheck(): Promise<{ apiKeyOk: boolean; programsReachable: Record<string, boolean>; note: string }> {
    const programsReachable: Record<string, boolean> = {};
    let apiKeyOk = false;

    for (const programId of this.globalAddresses) {
      try {
        const params = new URLSearchParams({ "api-key": env.HELIUS_API_KEY ?? "", limit: "1", type: LAUNCH_TYPES });
        const res = await fetch(`${HELIUS_REST_BASE}/addresses/${programId}/transactions?${params.toString()}`, {
          signal: AbortSignal.timeout(6000)
        });
        if (res.status === 401) { programsReachable[programId] = false; continue; }
        apiKeyOk = res.ok || res.status === 429;
        programsReachable[programId] = res.ok;
      } catch {
        programsReachable[programId] = false;
      }
    }

    const allReachable = Object.values(programsReachable).every(Boolean);
    const note = !env.HELIUS_API_KEY
      ? "HELIUS_API_KEY not set — set it in Railway env vars"
      : !apiKeyOk
      ? "API key rejected — check HELIUS_API_KEY value"
      : !allReachable
      ? "Some Pump.fun programs unreachable — check Helius plan limits"
      : `Polling ${this.globalAddresses.length} program(s) + ${this.trackedMints.size} discovered mints. Webhook URL must be set in Helius dashboard → Enhanced Webhooks → add address 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`;

    return { apiKeyOk, programsReachable, note };
  }
}
