/**
 * Real-time Jito-bundle detection via Solana logsSubscribe on the bonding-curve PDA.
 *
 * getBlock for a slot is often unavailable for 10–30s; individual txs and log
 * notifications arrive much sooner (typically 400ms–2s with commitment "confirmed").
 */
import { WebSocket } from "ws";
import { env } from "../../config/env.js";

export interface BundleLogHit {
  mint: string;
  signature: string;
  slot: number;
  bondingCurve: string;
  devWallet: string;
  createdAtMs: number;
}

interface ActiveWatch {
  mint: string;
  bondingCurve: string;
  devWallet: string;
  createSlot: number | null;
  createdAtMs: number;
  rpcSubId?: number;
  timeout: NodeJS.Timeout;
  done: boolean;
}

export function resolveBundleRpcHttp(): string | null {
  if (env.BUNDLE_RPC_URL) return env.BUNDLE_RPC_URL;
  if (env.HELIUS_RPC_URL && !env.HELIUS_RPC_URL.endsWith("api-key=")) {
    return env.HELIUS_RPC_URL;
  }
  if (env.ALCHEMY_API) return env.ALCHEMY_API;
  return null;
}

function httpToWs(url: string): string {
  if (url.startsWith("wss:") || url.startsWith("ws:")) return url;
  return url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export class BundleLogsWatcher {
  private ws: WebSocket | null = null;
  private connecting = false;
  private readonly onHit: (hit: BundleLogHit) => void;
  private readonly watchesBySubId = new Map<number, ActiveWatch>();
  private readonly watchesByMint = new Map<string, ActiveWatch>();
  /** req id → watch until server returns subscription id */
  private readonly pendingByReqId = new Map<number, ActiveWatch>();
  private nextReqId = 1;
  private reconnectTimer: NodeJS.Timeout | null = null;
  readonly wsUrl: string | null;

  constructor(onHit: (hit: BundleLogHit) => void) {
    this.onHit = onHit;
    const http = resolveBundleRpcHttp();
    this.wsUrl = http ? httpToWs(http) : null;
  }

  get enabled(): boolean {
    return env.BUNDLE_LOGS_WS_ENABLED && this.wsUrl !== null;
  }

  /** Called once create-slot is known from getTransaction(createSig). */
  setCreateSlot(mint: string, slot: number): void {
    const w = this.watchesByMint.get(mint);
    if (w) w.createSlot = slot;
  }

  watch(mint: string, bondingCurve: string, devWallet: string, createdAtMs: number): void {
    if (!this.enabled) return;
    this.endWatch(mint);

    const watch: ActiveWatch = {
      mint,
      bondingCurve,
      devWallet,
      createSlot: null,
      createdAtMs,
      done: false,
      timeout: setTimeout(() => this.endWatch(mint), 18_000),
    };
    this.watchesByMint.set(mint, watch);
    this.ensureConnected(() => this._sendSubscribe(watch));
  }

  endWatch(mint: string): void {
    const w = this.watchesByMint.get(mint);
    if (!w || w.done) return;
    w.done = true;
    clearTimeout(w.timeout);
    this.watchesByMint.delete(mint);
    if (w.rpcSubId !== undefined) {
      this._sendUnsubscribe(w.rpcSubId);
      this.watchesBySubId.delete(w.rpcSubId);
    }
  }

  private ensureConnected(onReady?: () => void): void {
    if (!this.wsUrl) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      onReady?.();
      return;
    }
    if (this.connecting) return;
    this.connecting = true;

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.connecting = false;
      console.log("[BundleLogs] WebSocket connected — logsSubscribe active");
      // Re-subscribe any watches that lost their server sub id on reconnect
      for (const w of this.watchesByMint.values()) {
        if (!w.done && w.rpcSubId === undefined) this._sendSubscribe(w);
      }
      onReady?.();
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          id?: number;
          result?: number;
          method?: string;
          params?: {
            subscription?: number;
            result?: {
              context?: { slot?: number };
              value?: { signature?: string; err?: unknown };
            };
          };
        };

        if (msg.id !== undefined && msg.result !== undefined) {
          const w = this.pendingByReqId.get(msg.id);
          if (w) {
            w.rpcSubId = msg.result;
            this.watchesBySubId.set(msg.result, w);
            this.pendingByReqId.delete(msg.id);
          }
          return;
        }

        if (msg.method !== "logsNotification" || !msg.params?.result) return;
        const subId = msg.params.subscription;
        const w = subId !== undefined ? this.watchesBySubId.get(subId) : undefined;
        if (!w || w.done) return;

        const slot = msg.params.result.context?.slot;
        const signature = msg.params.result.value?.signature;
        if (!signature || slot === undefined) return;
        if (msg.params.result.value?.err) return;

        if (w.createSlot !== null && slot !== w.createSlot) return;

        this.onHit({
          mint: w.mint,
          signature,
          slot,
          bondingCurve: w.bondingCurve,
          devWallet: w.devWallet,
          createdAtMs: w.createdAtMs,
        });
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on("close", () => {
      this.connecting = false;
      this.ws = null;
      for (const w of this.watchesByMint.values()) {
        w.rpcSubId = undefined;
      }
      this.watchesBySubId.clear();
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.watchesByMint.size > 0) this.ensureConnected();
        }, 2_000);
      }
    });

    ws.on("error", () => {
      /* close handler reconnects */
    });
  }

  private _sendSubscribe(w: ActiveWatch): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.nextReqId++;
    this.pendingByReqId.set(reqId, w);
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "logsSubscribe",
      params: [
        { mentions: [w.bondingCurve] },
        { commitment: "confirmed" },
      ],
    }));
  }

  private _sendUnsubscribe(rpcSubId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.nextReqId++;
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "logsUnsubscribe",
      params: [rpcSubId],
    }));
  }
}
