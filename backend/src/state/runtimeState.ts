import type { AlertEvent, CanonicalEvent, DeveloperProfile, ProbabilityRecord, TokenState, WalletProfile } from "../types.js";
import type { WalletAccount } from "../services/intelligence/walletIntelligence.js";

export class RuntimeState {
  readonly tokens = new Map<string, TokenState>();
  readonly wallets = new Map<string, WalletProfile>();
  readonly walletAccounts = new Map<string, WalletAccount>();
  readonly developers = new Map<string, DeveloperProfile>();
  readonly alerts: AlertEvent[] = [];
  readonly probabilities: ProbabilityRecord[] = [];
  readonly events: CanonicalEvent[] = [];
}
