import type { AlertEvent, CanonicalEvent, DeveloperProfile, ProbabilityRecord, TokenState, WalletProfile } from "../types.js";
import type { WalletAccount } from "../services/intelligence/walletIntelligence.js";
import type { EarlyWindow } from "../services/intelligence/entryExit.js";

export class RuntimeState {
  readonly tokens = new Map<string, TokenState>();
  readonly wallets = new Map<string, WalletProfile>();
  readonly walletAccounts = new Map<string, WalletAccount>();
  // Current holders per mint: wallets that hold an open (>0) tracked position.
  readonly tokenHolders = new Map<string, Set<string>>();
  // First-5-min participation window per mint, for entry scoring.
  readonly earlyWindows = new Map<string, EarlyWindow>();
  readonly developers = new Map<string, DeveloperProfile>();
  readonly alerts: AlertEvent[] = [];
  readonly probabilities: ProbabilityRecord[] = [];
  readonly events: CanonicalEvent[] = [];
}
