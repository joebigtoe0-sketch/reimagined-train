/**
 * Runtime bundle sniper settings — adjustable from the dashboard without restart.
 * Defaults come from env; changes apply immediately to detection + live trader.
 */
import { env } from "../../config/env.js";

export interface BundleSettings {
  /** Minimum single buy (SOL) to count as a Jito-bundle trigger. */
  minTriggerSol: number;
  /** Take-profit exit: sell when MC reaches entry × (1 + takeProfitPct/100). */
  takeProfitPct: number;
  /** Max hold time (ms) before market sell if TP not hit; 0 = disabled. */
  timeoutMs: number;
  /** SOL per live trade. */
  betSize: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

const defaults: BundleSettings = {
  minTriggerSol: env.BUNDLE_MIN_TRIGGER_SOL ?? 7,
  takeProfitPct: env.BUNDLE_TAKE_PROFIT_PCT ?? 40,
  timeoutMs: env.BUNDLE_TIMEOUT_MS ?? 180_000,
  betSize: env.BUNDLE_BET_SIZE ?? 0.4,
};

let current: BundleSettings = { ...defaults };

export function getBundleSettings(): Readonly<BundleSettings> {
  return current;
}

export function setBundleSettings(patch: Partial<BundleSettings>): BundleSettings {
  if (patch.minTriggerSol !== undefined) {
    current.minTriggerSol = clamp(patch.minTriggerSol, 1, 50);
  }
  if (patch.takeProfitPct !== undefined) {
    current.takeProfitPct = clamp(patch.takeProfitPct, 5, 200);
  }
  if (patch.timeoutMs !== undefined) {
    current.timeoutMs = clamp(patch.timeoutMs, 0, 3_600_000);
  }
  if (patch.betSize !== undefined) {
    current.betSize = clamp(patch.betSize, 0.01, 10);
  }
  console.log(
    `[BundleSettings] min=${current.minTriggerSol}◎ TP=${current.takeProfitPct}% ` +
    `timeout=${current.timeoutMs ? current.timeoutMs / 1000 + "s" : "off"} bet=${current.betSize}◎`,
  );
  return { ...current };
}

export function resetBundleSettings(): BundleSettings {
  current = { ...defaults };
  return { ...current };
}
