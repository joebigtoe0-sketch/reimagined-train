export interface MetricsSnapshot {
  ingestionLagMs: number;
  scoringLatencyMs: number;
  websocketFreshnessMs: number;
  alertDelayMs: number;
  eventsProcessed: number;
}

const metrics: MetricsSnapshot = {
  ingestionLagMs: 0,
  scoringLatencyMs: 0,
  websocketFreshnessMs: 0,
  alertDelayMs: 0,
  eventsProcessed: 0
};

export function updateMetrics(partial: Partial<MetricsSnapshot>): void {
  Object.assign(metrics, partial);
}

export function getMetrics(): MetricsSnapshot {
  return { ...metrics };
}
