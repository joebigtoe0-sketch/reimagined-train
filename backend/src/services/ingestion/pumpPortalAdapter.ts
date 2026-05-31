/**
 * PumpPortal real-time adapter for Pump.fun.
 *
 * Connects to a single PumpPortal WebSocket and subscribes to:
 *   - subscribeNewToken   → token creation events            (FREE, no key)
 *   - subscribeTokenTrade → buy/sell events for tracked mints (METERED: 0.01 SOL
 *                            per 10k messages, requires PUMPPORTAL_API_KEY + a
 *                            linked wallet funded with >= 0.02 SOL)
 *
 * The WebSocket pushes events; we buffer them and hand them to the engine via
 * the same pollNewLaunches()/pollTrades() interface the Bitquery adapter uses,
 * so the engine doesn't care which provider is active.
 *
 * Endpoint: wss://pumpportal.fun/api/data
 * Docs:     https://pumpportal.fun/data-api/real-time
 */

import { WebSocket } from "ws";
import { env } from "../../config/env.js";
import type { IngestionSource, LaunchInfo, TradeInfo, MigrationInfo } from "./ingestionSource.js";

const BASE_URL = "wss://pumpportal.fun/api/data";
const PUMP_TOKEN_SUPPLY = 1_000_000_000;
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_MS = 30_000;

interface PumpPortalMessage {
  message?: string;
  signature?: string;
  mint?: string;
  traderPublicKey?: string;
  txType?: string; // "create" | "buy" | "sell"
  solAmount?: number;
  tokenAmount?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  pool?: string;
  // Social metadata — present on txType="create" events
  website?: string;
  twitter?: string;
  telegram?: string;
  description?: string;
}

export class PumpPortalAdapter implements IngestionSource {
  readonly name = "pumpportal";

  private ws: WebSocket | null = null;
  private connecting = false;
  private launchBuffer: LaunchInfo[] = [];
  private tradeBuffer: TradeInfo[] = [];
  private migrationBuffer: MigrationInfo[] = [];
  private subscribedMints = new Set<string>();
  // Mints we auto-subscribed on create — tracked separately so we can
  // unsubscribe them after EARLY_UNSUB_MS if the engine doesn't promote them.
  private earlySubMints = new Map<string, number>(); // mint → subscribedAt
  private seenMints = new Set<string>();
  private seenTradeSigs = new Set<string>();
  private seenMigrations = new Set<string>();
  private warnedNoKey = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  // Debug: tracks recently-created mints so we can log what arrives within 3s
  private _debugWindows = new Map<string, { createdAt: number; devWallet: string }>();

  /** Launches are free, so this provider is always usable. */
  get available(): boolean {
    return true;
  }

  async verify(): Promise<void> {
    this.connect();
    if (!env.PUMPPORTAL_API_KEY) {
      console.warn(
        "[PumpPortal] No PUMPPORTAL_API_KEY set — launches (free) will stream, " +
          "but trade tracking is disabled (it is metered and needs a funded key)."
      );
    }
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.connecting) return;
    this.connecting = true;

    const url = env.PUMPPORTAL_API_KEY ? `${BASE_URL}?api-key=${env.PUMPPORTAL_API_KEY}` : BASE_URL;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.connecting = false;
      console.log("[PumpPortal] ✓ WebSocket connected");
      this.send({ method: "subscribeNewToken" });
      // Global graduation feed — fires for EVERY migration regardless of whether
      // we hold a per-token trade subscription. This is our authoritative
      // `migrated` label (free, no key required).
      this.send({ method: "subscribeMigration" });
      // Re-subscribe to any mints we were tracking before a reconnect.
      // earlySubMints get stale fast — prune them on reconnect to avoid re-paying.
      const reconnectNow = Date.now();
      for (const [mint, subAt] of this.earlySubMints) {
        if (reconnectNow - subAt > 25_000) {
          this.earlySubMints.delete(mint);
          this.subscribedMints.delete(mint);
        }
      }
      if (this.subscribedMints.size > 0 && env.PUMPPORTAL_API_KEY) {
        this.send({ method: "subscribeTokenTrade", keys: [...this.subscribedMints] });
      }
      this.startHeartbeat();
    });

    ws.on("message", (raw: Buffer | string) => {
      this.handleMessage(raw.toString());
    });

    ws.on("pong", () => {
      this.awaitingPong = false;
    });

    ws.on("error", (err: Error) => {
      console.error("[PumpPortal] WebSocket error:", err.message);
    });

    ws.on("close", () => {
      this.connecting = false;
      this.ws = null;
      this.stopHeartbeat();
      console.warn(`[PumpPortal] WebSocket closed — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      this.scheduleReconnect();
    });
  }

  // Detect silent/half-open connections: if a ping goes unanswered for one
  // interval, terminate so we reconnect instead of missing launches forever.
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        console.warn("[PumpPortal] heartbeat timeout — terminating stale connection");
        this.ws.terminate();
        return;
      }
      this.awaitingPong = true;
      this.ws.ping();
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(raw: string): void {
    let msg: PumpPortalMessage;
    try {
      msg = JSON.parse(raw) as PumpPortalMessage;
    } catch {
      return;
    }

    // Subscription acknowledgements look like { message: "Successfully subscribed..." }.
    if (msg.message && !msg.txType) return;

    const solUsd = env.SOL_USD_ESTIMATE;

    // Bonding-curve graduation. PumpPortal labels these txType "migrate"; we also
    // accept a bare pool-only message defensively in case the schema shifts.
    const isMigration =
      msg.txType === "migrate" ||
      msg.txType === "migration" ||
      (!!msg.pool && msg.txType !== "buy" && msg.txType !== "sell" && msg.txType !== "create");
    if (isMigration && msg.mint) {
      const key = msg.signature || msg.mint;
      if (this.seenMigrations.has(key)) return;
      this.seenMigrations.add(key);
      const mcUsd = (msg.marketCapSol ?? 0) * solUsd;
      this.migrationBuffer.push({
        mint: msg.mint,
        signature: msg.signature || `migrate:${msg.mint}`,
        pool: msg.pool,
        marketCap: mcUsd > 0 ? Math.round(mcUsd) : undefined,
        timestamp: new Date().toISOString()
      });
      this.capSet(this.seenMigrations, 20_000, 10_000);
      return;
    }

    if (msg.txType === "create" && msg.mint) {
      if (this.seenMints.has(msg.mint)) return;
      this.seenMints.add(msg.mint);
      const mcUsd = (msg.marketCapSol ?? 0) * solUsd;
      this.launchBuffer.push({
        mint: msg.mint,
        name: msg.name?.trim() || `Token ${msg.mint.slice(0, 6)}`,
        symbol: msg.symbol?.trim() || msg.mint.slice(0, 6).toUpperCase(),
        createdAt: new Date().toISOString(),
        devWallet: msg.traderPublicKey ?? "",
        initialMarketCapUsd: mcUsd > 0 ? Math.round(mcUsd) : undefined,
        initialBuySol: msg.solAmount ?? 0,
        website:  msg.website?.trim()  || undefined,
        twitter:  msg.twitter?.trim()  || undefined,
        telegram: msg.telegram?.trim() || undefined,
      });
      this.capSet(this.seenMints, 50_000, 25_000);

      // IMMEDIATELY subscribe to this token's trade feed so we catch the whale
      // buy that may land in the same block (400ms later). Waiting for the next
      // ingest tick (up to 1200ms) would cause us to miss it entirely.
      if (env.PUMPPORTAL_API_KEY && !this.subscribedMints.has(msg.mint)) {
        this.subscribedMints.add(msg.mint);
        this.earlySubMints.set(msg.mint, Date.now());
        this.send({ method: "subscribeTokenTrade", keys: [msg.mint] });
      }

      // Jito bundle safety net: same-block buys (create + gang buy in one bundle)
      // are NEVER delivered via subscribeTokenTrade because our subscription
      // doesn't exist yet when PumpPortal broadcasts that block. Patch the gap
      // by querying the Solana RPC 800 ms later, using balance-diff parsing
      // to detect any large early buy we missed. No enhanced-API credits needed.
      {
        const mintSnap      = msg.mint;
        const devWalletSnap = msg.traderPublicKey ?? "";
        const createdAtMs   = Date.now();
        setTimeout(
          () => void this.heliusCatchEarlyBuy(mintSnap, devWalletSnap, createdAtMs),
          800
        );
      }

      // DEBUG: log every message that arrives within 3s of this token's creation
      // so we can see if PumpPortal delivers same-block buys from other wallets.
      if (process.env.BUNDLE_DEBUG === "true") {
        const mintShort = msg.mint.slice(0, 8);
        const createdAt = Date.now();
        console.log(`[BundleDebug] CREATE ${mintShort} sol=${msg.solAmount ?? 0} dev=${(msg.traderPublicKey ?? "").slice(0,8)}`);
        // Attach a short-lived listener to log anything that arrives for this mint in next 3s
        this._debugWindows.set(msg.mint, { createdAt, devWallet: msg.traderPublicKey ?? "" });
        setTimeout(() => { if (msg.mint) this._debugWindows.delete(msg.mint); }, 3000);
      }
      return;
    }

    if ((msg.txType === "buy" || msg.txType === "sell") && msg.mint && msg.signature) {
      // DEBUG: if this trade arrives within the 3s window of a token creation, log it
      if (process.env.BUNDLE_DEBUG === "true") {
        const dbg = this._debugWindows.get(msg.mint);
        if (dbg) {
          const delayMs = Date.now() - dbg.createdAt;
          const isDevWallet = msg.traderPublicKey === dbg.devWallet;
          const tag = isDevWallet ? "DEV" : "OTHER";
          console.log(`[BundleDebug]   ${msg.txType.toUpperCase()} ${msg.mint.slice(0,8)} +${delayMs}ms sol=${msg.solAmount ?? 0} wallet=${tag}(${(msg.traderPublicKey ?? "").slice(0,8)}) via=subscribeNewToken`);
        }
      }

      const dedupKey = `${msg.signature}:${msg.mint}:${msg.txType}`;
      if (this.seenTradeSigs.has(dedupKey)) return;
      this.seenTradeSigs.add(dedupKey);
      const mcUsd = (msg.marketCapSol ?? 0) * solUsd;
      this.tradeBuffer.push({
        mint: msg.mint,
        traderWallet: msg.traderPublicKey ?? "",
        side: msg.txType,
        amountSol: msg.solAmount ?? 0,
        tokenAmount: msg.tokenAmount ?? 0,
        priceUsd: mcUsd > 0 ? mcUsd / PUMP_TOKEN_SUPPLY : 0,
        marketCap: mcUsd > 0 ? Math.round(mcUsd) : 0,
        signature: msg.signature,
        timestamp: new Date().toISOString()
      });
      this.capSet(this.seenTradeSigs, 80_000, 40_000);
    }
  }

  async pollNewLaunches(): Promise<LaunchInfo[]> {
    this.connect();
    const out = this.launchBuffer;
    this.launchBuffer = [];
    if (out.length > 0) {
      console.log(`[PumpPortal] +${out.length} new token(s): ${out.map((r) => `$${r.symbol}`).join(", ")}`);
    }
    return out;
  }

  async pollMigrations(): Promise<MigrationInfo[]> {
    this.connect();
    const out = this.migrationBuffer;
    this.migrationBuffer = [];
    if (out.length > 0) {
      console.log(`[PumpPortal] ⬆ ${out.length} migration(s): ${out.map((m) => m.mint.slice(0, 6)).join(", ")}`);
    }
    return out;
  }

  async pollTrades(trackedMints: string[]): Promise<TradeInfo[]> {
    this.connect();

    // Reconcile trade subscriptions with the desired active set (metered, needs
    // a key). Subscribe to new mints, unsubscribe from ones that aged out so we
    // don't keep paying for trades on dead tokens.
    if (env.PUMPPORTAL_API_KEY) {
      const desired = new Set(trackedMints);
      const now = Date.now();

      // Prune early-subscribed mints that the engine didn't promote to its
      // tracked set after EARLY_UNSUB_MS. These are tokens where no bundle buy
      // was detected — no reason to keep paying for their trades.
      const EARLY_UNSUB_MS = 25_000;
      for (const [mint, subAt] of this.earlySubMints) {
        if (now - subAt > EARLY_UNSUB_MS && !desired.has(mint)) {
          this.earlySubMints.delete(mint);
          this.subscribedMints.delete(mint);
          this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
        }
      }

      const fresh = trackedMints.filter((m) => !this.subscribedMints.has(m));
      if (fresh.length > 0) {
        for (const m of fresh) this.subscribedMints.add(m);
        this.send({ method: "subscribeTokenTrade", keys: fresh });
      }
      const stale = [...this.subscribedMints].filter(
        (m) => !desired.has(m) && !this.earlySubMints.has(m)
      );
      if (stale.length > 0) {
        for (const m of stale) this.subscribedMints.delete(m);
        this.send({ method: "unsubscribeTokenTrade", keys: stale });
      }
    } else if (!this.warnedNoKey && trackedMints.length > 0) {
      this.warnedNoKey = true;
      console.warn("[PumpPortal] Skipping trade subscription — PUMPPORTAL_API_KEY not set.");
    }

    const out = this.tradeBuffer;
    this.tradeBuffer = [];
    return out;
  }

  /**
   * Called 800 ms after a create event to catch Jito-bundle same-block buys that
   * PumpPortal's subscribeTokenTrade missed (subscription didn't exist yet when
   * PumpPortal broadcast that block).
   *
   * Uses standard Solana JSON-RPC getSignaturesForAddress + getTransaction and
   * inspects pre/post account-balance diffs to find wallets that spent ≥ 7 SOL.
   * No Helius enhanced-API credits needed — tries HELIUS_RPC_URL first, then
   * ALCHEMY_API, then the public mainnet endpoint.
   */
  private async heliusCatchEarlyBuy(
    mint: string,
    devWallet: string,
    createdAtMs: number
  ): Promise<void> {
    const rpcCandidates: string[] = [];
    if (env.HELIUS_RPC_URL && !env.HELIUS_RPC_URL.endsWith("api-key=")) {
      rpcCandidates.push(env.HELIUS_RPC_URL);
    }
    if (env.ALCHEMY_API) rpcCandidates.push(env.ALCHEMY_API);
    rpcCandidates.push("https://api.mainnet-beta.solana.com");

    for (const rpcUrl of rpcCandidates) {
      try {
        await this._rpcRetrocheck(rpcUrl, mint, devWallet, createdAtMs);
        return;
      } catch {
        // try next endpoint
      }
    }
  }

  private async _rpcRetrocheck(
    rpcUrl: string,
    mint: string,
    devWallet: string,
    createdAtMs: number
  ): Promise<void> {
    const rpcCall = async (body: object) => {
      const r = await fetch(rpcUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const d = await r.json() as { result?: unknown; error?: { message: string } };
      if (d.error) throw new Error(d.error.message);
      return d.result;
    };

    const rawSigs = (await rpcCall({
      jsonrpc: "2.0", id: 1,
      method:  "getSignaturesForAddress",
      params:  [mint, { limit: 10 }],
    })) as Array<{ signature: string; blockTime?: number }> | null;

    if (!rawSigs || rawSigs.length === 0) return;

    // Returned newest-first; reverse so we process oldest (creation block) first
    const sigs = [...rawSigs].reverse();

    for (const sigInfo of sigs) {
      if (sigInfo.blockTime && sigInfo.blockTime * 1000 > createdAtMs + 3_000) continue;

      // Small pause to respect RPC rate limits between getTransaction calls
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      const tx = (await rpcCall({
        jsonrpc: "2.0", id: 2,
        method:  "getTransaction",
        params:  [
          sigInfo.signature,
          { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ],
      })) as {
        transaction?: { message?: { accountKeys?: string[] } };
        meta?: { preBalances?: number[]; postBalances?: number[] };
      } | null;

      if (!tx) continue;

      const keys  = tx.transaction?.message?.accountKeys ?? [];
      const pre   = tx.meta?.preBalances  ?? [];
      const post  = tx.meta?.postBalances ?? [];

      for (let i = 0; i < keys.length; i++) {
        const account       = keys[i] ?? "";
        const deltaLamports = (post[i] ?? 0) - (pre[i] ?? 0);

        // A large negative delta = wallet spent ≥ 7 SOL (buy + fee + Jito tip)
        if (deltaLamports >= -7_000_000_000) continue;
        if (!account || account === devWallet) continue;

        // Subtract typical overhead (~0.01 SOL for fee + tip) to get buy amount
        const sol = Math.abs(deltaLamports) / 1e9 - 0.01;
        if (sol < 7) continue;

        const dedupKey = `${sigInfo.signature}:${mint}:buy`;
        if (this.seenTradeSigs.has(dedupKey)) continue;
        this.seenTradeSigs.add(dedupKey);

        const blockTs = sigInfo.blockTime
          ? new Date(sigInfo.blockTime * 1000).toISOString()
          : new Date(createdAtMs).toISOString();

        this.tradeBuffer.push({
          mint,
          traderWallet: account,
          side:         "buy",
          amountSol:    sol,
          tokenAmount:  0,
          priceUsd:     0,
          marketCap:    0,
          signature:    sigInfo.signature,
          timestamp:    blockTs,
          isJitoBundle: true,
        });

        console.log(
          `[PumpPortal] ⚡ RPC retrocheck: ${mint.slice(0, 8)} ` +
          `+${sol.toFixed(2)} SOL from ${account.slice(0, 8)} ` +
          `(same-block Jito — was missed by WS subscription)`
        );
        break; // one detection per transaction is enough to trigger the signal
      }
    }
  }

  private capSet(set: Set<string>, max: number, keep: number): void {
    if (set.size > max) {
      const trimmed = [...set].slice(-keep);
      set.clear();
      for (const v of trimmed) set.add(v);
    }
  }
}
