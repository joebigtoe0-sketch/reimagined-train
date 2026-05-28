import type { EventType, TradeSide } from "../../types.js";
import type { HeliusRawEvent } from "../../domain/events/normalizer.js";

type Json = Record<string, unknown>;

const PUMPFUN_PROGRAM_IDS = new Set<string>([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP"
]);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLE_MINTS = new Set<string>([SOL_MINT, USDC_MINT, USDT_MINT]);

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function instructionTouchesPumpfun(tx: Json): boolean {
  const instructions = asArray<Json>(tx.instructions);
  for (const ix of instructions) {
    const programId = asString(ix.programId);
    if (PUMPFUN_PROGRAM_IDS.has(programId)) return true;
    const inner = asArray<Json>(ix.innerInstructions);
    for (const innerIx of inner) {
      if (PUMPFUN_PROGRAM_IDS.has(asString(innerIx.programId))) return true;
    }
  }
  return false;
}

function detectType(tx: Json): EventType {
  const txType = asString(tx.type).toUpperCase();
  if (txType.includes("CREATE") || txType.includes("INITIALIZE_MINT") || txType.includes("TOKEN_MINT")) return "launch";
  if (txType.includes("MIGRATION") || txType.includes("RAYDIUM") || txType.includes("POOL_CREATED")) return "migration";
  if (txType.includes("ADD_LIQUIDITY") || txType.includes("REMOVE_LIQUIDITY")) return "liquidity";
  if (txType.includes("SWAP") || txType.includes("NFT_SALE")) return "trade";
  if (txType.includes("TRANSFER")) return "transfer";

  const events = tx.events as Json | undefined;
  if (events && typeof events === "object" && "swap" in events) return "trade";

  const tokenTransfers = asArray<Json>(tx.tokenTransfers);
  if (tokenTransfers.length > 0) return "trade";
  const nativeTransfers = asArray<Json>(tx.nativeTransfers);
  if (nativeTransfers.length > 0) return "funding";

  return "trade";
}

function pickPrimaryMint(tokenTransfers: Json[]): string {
  for (const t of tokenTransfers) {
    const mint = asString(t.mint);
    if (mint && !STABLE_MINTS.has(mint)) return mint;
  }
  const fallback = asString(tokenTransfers[0]?.mint);
  return fallback || "UNKNOWN_MINT";
}

function collectMints(tokenTransfers: Json[]): string[] {
  const set = new Set<string>();
  for (const t of tokenTransfers) {
    const mint = asString(t.mint);
    if (mint && !STABLE_MINTS.has(mint)) set.add(mint);
  }
  return [...set];
}

function detectSide(tx: Json, primaryMint: string, feePayer: string): TradeSide | undefined {
  const description = asString(tx.description).toLowerCase();
  if (description.includes("bought") || description.includes(" buy ")) return "buy";
  if (description.includes("sold") || description.includes(" sell ")) return "sell";

  const tokenTransfers = asArray<Json>(tx.tokenTransfers);
  for (const t of tokenTransfers) {
    if (asString(t.mint) !== primaryMint) continue;
    if (asString(t.toUserAccount) === feePayer) return "buy";
    if (asString(t.fromUserAccount) === feePayer) return "sell";
  }

  const incoming = tokenTransfers.some((t) => !!t.toUserAccount && !STABLE_MINTS.has(asString(t.mint)));
  return incoming ? "buy" : "sell";
}

function collectParticipants(tx: Json, feePayer: string): string[] {
  const set = new Set<string>();
  if (feePayer) set.add(feePayer);

  const tokenTransfers = asArray<Json>(tx.tokenTransfers);
  for (const t of tokenTransfers) {
    const from = asString(t.fromUserAccount);
    const to = asString(t.toUserAccount);
    if (from) set.add(from);
    if (to) set.add(to);
  }

  const nativeTransfers = asArray<Json>(tx.nativeTransfers);
  for (const n of nativeTransfers) {
    const from = asString(n.fromUserAccount);
    const to = asString(n.toUserAccount);
    if (from) set.add(from);
    if (to) set.add(to);
  }

  const accountData = asArray<Json>(tx.accountData);
  for (const a of accountData) {
    const account = asString(a.account);
    if (account) set.add(account);
  }

  return [...set];
}

function detectDevWallet(tx: Json, type: EventType, feePayer: string): string | undefined {
  if (type !== "launch") return undefined;
  return feePayer || undefined;
}

function extractAmountSol(tx: Json, feePayer: string): number {
  const nativeTransfers = asArray<Json>(tx.nativeTransfers);
  let netLamports = 0;
  for (const n of nativeTransfers) {
    const amount = asNumber(n.amount, 0);
    if (asString(n.fromUserAccount) === feePayer) netLamports += amount;
    else if (asString(n.toUserAccount) === feePayer) netLamports -= amount;
  }
  if (netLamports !== 0) return Math.abs(netLamports) / 1_000_000_000;
  if (nativeTransfers.length > 0) return asNumber(nativeTransfers[0].amount, 0) / 1_000_000_000;
  return 0;
}

export function decodeEnhancedTransactions(payload: unknown): HeliusRawEvent[] {
  const txs = Array.isArray(payload) ? payload : [];
  const events: HeliusRawEvent[] = [];

  for (const tx of txs) {
    if (!tx || typeof tx !== "object") continue;
    const row = tx as Json;
    const signature = asString(row.signature);
    if (!signature) continue;

    const feePayer = asString(row.feePayer);
    const tokenTransfers = asArray<Json>(row.tokenTransfers);
    const mint = pickPrimaryMint(tokenTransfers);
    const mints = collectMints(tokenTransfers);
    let type = detectType(row);

    if (type !== "launch" && instructionTouchesPumpfun(row) && mints.length === 0) {
      type = "launch";
    }

    const participants = collectParticipants(row, feePayer);
    const devWallet = detectDevWallet(row, type, feePayer);
    const side = type === "trade" ? detectSide(row, mint, feePayer) : undefined;

    events.push({
      signature,
      slot: asNumber(row.slot),
      timestamp: asNumber(row.timestamp, Date.now() / 1000) * 1000,
      mint,
      wallet: feePayer || (participants[0] ?? "UNKNOWN_WALLET"),
      type,
      side,
      amountSol: extractAmountSol(row, feePayer),
      marketCap: 0,
      participants,
      mints,
      devWallet
    });
  }

  return events;
}

export const PUMPFUN_PROGRAM_ADDRESSES = [...PUMPFUN_PROGRAM_IDS];
