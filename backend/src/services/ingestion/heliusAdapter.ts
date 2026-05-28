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

  // High-water mark per address: the newest signature we've already processed.
  // On first poll we set this without processing anything (skips historical backlog).
  // On subsequent polls we stop processing once we reach this signature.
  private highWaterMarks = new Map<string, string>();
  private initialized = new Set<string>(); // addresses whose first poll has completed

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
    // First poll per address just sets the high-water mark (skips historical backlog).
    // Every subsequent poll only returns genuinely new events since the last poll.
    for (const programId of this.globalAddresses) {
      try {
        const batch = await this.fetchNewTransactions(programId, LAUNCH_TYPES);
        for (const ev of batch) {
          if (ev.type === "launch" && ev.mint && ev.mint !== "UNKNOWN_MINT") {
            this.addDiscoveredMint(ev.mint);
          }
          for (const m of ev.mints ?? []) this.addDiscoveredMint(m);
        }
        results.push(...batch);
      } catch { /* skip */ }
    }

    // Step 2 — fetch buys/sells only for mints we discovered via launches.
    const mintSlice = [...this.trackedMints].slice(-Math.min(30, this.trackedMints.size));
    for (const mint of mintSlice) {
      try {
        const batch = await this.fetchNewTransactions(mint, TRADE_TYPES);
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

  /**
   * Fetch transactions for `address` of the given `types`.
   *
   * On the very first call per address: records the newest signature as the
   * high-water mark and returns NOTHING — this skips the historical backlog.
   *
   * On every subsequent call: fetches the page and returns only transactions
   * that are newer than the stored high-water mark, then advances the mark.
   */
  private async fetchNewTransactions(address: string, types: string): Promise<HeliusRawEvent[]> {
    const params = new URLSearchParams({
      "api-key": env.HELIUS_API_KEY!,
      limit: String(env.HELIUS_SIGNATURE_LIMIT),
      type: types
    });

    const url = `${HELIUS_REST_BASE}/addresses/${address}/transactions?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];

    const txns = (await res.json()) as Array<{ signature?: string }>;
    if (!Array.isArray(txns) || txns.length === 0) return [];

    // Helius returns newest-first. The first item is the most recent transaction.
    const newestSig = txns[0]?.signature ?? "";

    if (!this.initialized.has(address)) {
      // First poll: set the mark to current chain tip, don't process anything.
      this.initialized.add(address);
      if (newestSig) this.highWaterMarks.set(address, newestSig);
      return [];
    }

    // Subsequent polls: Helius returns newest-first, so slice at the watermark.
    // Everything BEFORE the watermark index is newer than the last poll.
    const waterMark = this.highWaterMarks.get(address);
    const waterMarkIdx = waterMark
      ? txns.findIndex((tx) => tx.signature === waterMark)
      : -1;
    // waterMarkIdx === -1 means ALL items are new (more than one page of new events)
    // waterMarkIdx === 0 means nothing is new yet
    const fresh = waterMarkIdx > 0 ? txns.slice(0, waterMarkIdx) : waterMarkIdx === -1 ? txns : [];

    // Advance the high-water mark to the newest signature in this page.
    if (newestSig) this.highWaterMarks.set(address, newestSig);

    const decoded = decodeEnhancedTransactions(fresh);
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
