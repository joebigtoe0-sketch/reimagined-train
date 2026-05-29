/**
 * Detects Pump.fun "Mayhem Mode" tokens.
 *
 * Mayhem Mode launches use the Token-2022 program (and a 2B supply with an AI
 * trading agent), whereas standard Pump.fun tokens use the classic SPL Token
 * program. So a mint owned by the Token-2022 program is a Mayhem launch.
 *
 * We check this with a single batched `getMultipleAccounts` RPC call, so the
 * cost is one request per ingest tick regardless of how many tokens launched.
 * On any RPC failure we fail OPEN (return an empty set) so launches are never
 * lost just because the RPC hiccuped.
 */

import { env } from "../../config/env.js";

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const MAX_ACCOUNTS_PER_CALL = 100;

function rpcUrl(): string {
  if (env.HELIUS_API_KEY && env.HELIUS_RPC_URL) {
    return `${env.HELIUS_RPC_URL}${env.HELIUS_API_KEY}`;
  }
  return PUBLIC_RPC;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Returns the subset of `mints` that are Mayhem Mode (Token-2022) launches. */
export async function detectMayhemMints(mints: string[]): Promise<Set<string>> {
  const mayhem = new Set<string>();
  if (mints.length === 0) return mayhem;

  const url = rpcUrl();

  for (const group of chunk(mints, MAX_ACCOUNTS_PER_CALL)) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [group, { encoding: "base64" }]
        }),
        signal: AbortSignal.timeout(8_000)
      });
      if (!res.ok) {
        console.warn(`[mayhem] RPC HTTP ${res.status} — skipping filter for this batch`);
        continue;
      }
      const json = (await res.json()) as {
        result?: { value: Array<{ owner: string } | null> };
        error?: unknown;
      };
      if (json.error || !json.result) {
        console.warn("[mayhem] RPC error — skipping filter for this batch");
        continue;
      }
      json.result.value.forEach((acc, i) => {
        if (acc?.owner === TOKEN_2022_PROGRAM) mayhem.add(group[i]);
      });
    } catch (err) {
      console.warn("[mayhem] detect error:", err instanceof Error ? err.message : err);
    }
  }

  return mayhem;
}
