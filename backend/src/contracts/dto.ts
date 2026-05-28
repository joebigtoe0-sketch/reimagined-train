import type { AlertEvent, ProbabilityRecord, TokenState } from "../types.js";

export interface TokensResponse {
  tokens: TokenState[];
}

export interface AlertsResponse {
  alerts: AlertEvent[];
}

export interface ProbabilitiesResponse {
  probabilities: ProbabilityRecord[];
}

export interface CalibrationReport {
  sampleSize: number;
  brierScore: number;
  precision: number;
  recall: number;
  driftDelta: number;
}
