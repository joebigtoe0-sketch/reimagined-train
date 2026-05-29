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
import type { IngestionSource, LaunchInfo, TradeInfo } from "./ingestionSource.js";

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
}

export class PumpPortalAdapter implements IngestionSource {
  readonly name = "pumpportal";

  private ws: WebSocket | null = null;
  private connecting = false;
  private launchBuffer: LaunchInfo[] = [];
  private tradeBuffer: TradeInfo[] = [];
  private subscribedMints = new Set<string>();
  private seenMints = new Set<string>();
  private seenTradeSigs = new Set<string>();
  private warnedNoKey = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;

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
      // Re-subscribe to any mints we were tracking before a reconnect.
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
        initialMarketCapUsd: mcUsd > 0 ? Math.round(mcUsd) : undefined
      });
      this.capSet(this.seenMints, 50_000, 25_000);
      return;
    }

    if ((msg.txType === "buy" || msg.txType === "sell") && msg.mint && msg.signature) {
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

  async pollTrades(trackedMints: string[]): Promise<TradeInfo[]> {
    this.connect();

    // Subscribe to trades for any newly tracked mints (metered, needs a key).
    if (env.PUMPPORTAL_API_KEY) {
      const fresh = trackedMints.filter((m) => !this.subscribedMints.has(m));
      if (fresh.length > 0) {
        for (const m of fresh) this.subscribedMints.add(m);
        this.send({ method: "subscribeTokenTrade", keys: fresh });
      }
    } else if (!this.warnedNoKey && trackedMints.length > 0) {
      this.warnedNoKey = true;
      console.warn("[PumpPortal] Skipping trade subscription — PUMPPORTAL_API_KEY not set.");
    }

    const out = this.tradeBuffer;
    this.tradeBuffer = [];
    return out;
  }

  private capSet(set: Set<string>, max: number, keep: number): void {
    if (set.size > max) {
      const trimmed = [...set].slice(-keep);
      set.clear();
      for (const v of trimmed) set.add(v);
    }
  }
}
