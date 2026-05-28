import type { ProbabilityRecord } from "../../types.js";

export interface AnalyticsSink {
  write(records: ProbabilityRecord[]): Promise<void>;
}

export class LocalAnalyticsSink implements AnalyticsSink {
  async write(_records: ProbabilityRecord[]): Promise<void> {
    // no-op for local MVP
  }
}

export class ClickHouseReadySink implements AnalyticsSink {
  constructor(private readonly fallback: AnalyticsSink) {}
  async write(records: ProbabilityRecord[]): Promise<void> {
    await this.fallback.write(records);
  }
}
