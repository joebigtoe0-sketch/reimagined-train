import type { CalibrationReport } from "../../contracts/dto.js";
import type { ProbabilityRecord } from "../../types.js";

export function runBacktest(probabilities: ProbabilityRecord[]): CalibrationReport {
  if (probabilities.length === 0) {
    return { sampleSize: 0, brierScore: 0, precision: 0, recall: 0 };
  }

  let brier = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const record of probabilities) {
    const predicted = record.continuation / 100;
    const observed = predicted > 0.6 ? 1 : 0;
    const realized = record.hit30kBefore10k > 55 ? 1 : 0;
    brier += (predicted - realized) ** 2;
    if (observed === 1 && realized === 1) tp += 1;
    if (observed === 1 && realized === 0) fp += 1;
    if (observed === 0 && realized === 1) fn += 1;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    sampleSize: probabilities.length,
    brierScore: Number((brier / probabilities.length).toFixed(4)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4))
  };
}
