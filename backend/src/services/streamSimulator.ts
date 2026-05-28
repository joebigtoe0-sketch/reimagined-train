import { currentMints, launchToken, processTrade } from "../state/store.js";
import type { TokenState } from "../types.js";

export interface SimulationCallbacks {
  onTokenUpdate: (token: TokenState) => void;
  onLaunch: (token: TokenState) => void;
}

export interface StreamSimulator {
  start: () => void;
  stop: () => void;
}

export function createStreamSimulator(callbacks: SimulationCallbacks): StreamSimulator {
  let launchTimer: NodeJS.Timeout | null = null;
  let tradeTimer: NodeJS.Timeout | null = null;

  return {
    start: () => {
      if (launchTimer || tradeTimer) return;

      launchTimer = setInterval(() => {
        const launched = launchToken();
        callbacks.onLaunch(launched);
      }, 7000);

      tradeTimer = setInterval(() => {
        const mints = currentMints();
        if (mints.length === 0) return;
        const mint = mints[Math.floor(Math.random() * mints.length)];
        const updated = processTrade(mint);
        if (updated) callbacks.onTokenUpdate(updated);
      }, 900);
    },
    stop: () => {
      if (launchTimer) clearInterval(launchTimer);
      if (tradeTimer) clearInterval(tradeTimer);
      launchTimer = null;
      tradeTimer = null;
    }
  };
}
