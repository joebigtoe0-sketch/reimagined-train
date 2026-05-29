import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tuned strategy config — the bridge between offline backtesting and the live
 * entry/exit signals. scripts/tune.mjs sweeps parameter combos against the
 * matured-token backtest, validates on a holdout, and writes the winning config
 * to config/strategy.json. The live engine reads it here so improvements found
 * by the tuner flow into production WITHOUT code changes — but only configs that
 * passed out-of-sample validation are marked `promoted` and adopted.
 */

export type ExitStrategy = "hold_to_death" | "tp_2x" | "tp_3x" | "trail_30" | "trail_50";

export interface StrategyConfig {
  version: string;
  generatedAt: string | null;
  promoted: boolean;
  entry: { minBuyers: number; minAvgBuySol: number; maxSellBuyRatio: number };
  exit: { strategy: ExitStrategy; tpMultiple: number; trailPct: number };
  backtest?: Record<string, unknown>;
}

const DEFAULTS: StrategyConfig = {
  version: "default-0",
  generatedAt: null,
  promoted: false,
  entry: { minBuyers: 12, minAvgBuySol: 0.1, maxSellBuyRatio: 1.0 },
  exit: { strategy: "trail_30", tpMultiple: 2, trailPct: 0.3 },
};

let cache: StrategyConfig | null = null;

export function loadStrategyConfig(): StrategyConfig {
  if (cache) return cache;
  cache = readFromDisk();
  return cache;
}

export function reloadStrategyConfig(): StrategyConfig {
  cache = readFromDisk();
  return cache;
}

function readFromDisk(): StrategyConfig {
  for (const p of [resolve(process.cwd(), "config/strategy.json"), resolve(process.cwd(), "../config/strategy.json")]) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<StrategyConfig>;
      // Only adopt a generated config once it has cleared validation.
      if (raw.generatedAt && raw.promoted === false) {
        return { ...DEFAULTS, version: `${raw.version ?? "unpromoted"}(using-defaults)` };
      }
      return {
        ...DEFAULTS,
        ...raw,
        entry: { ...DEFAULTS.entry, ...(raw.entry ?? {}) },
        exit: { ...DEFAULTS.exit, ...(raw.exit ?? {}) },
      } as StrategyConfig;
    } catch {
      // try next path
    }
  }
  return DEFAULTS;
}
