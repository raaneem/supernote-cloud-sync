export type BenchmarkPlatform = "desktop" | "mobile";
export type BenchmarkProfile = "smoke" | "standard" | "reference";

export interface TimingSummary {
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface MemorySummary {
  beforeBytes: number;
  peakBytes: number;
  afterGcBytes: number;
  peakWorkingBytes: number;
  retainedBytes: number;
}

export interface BudgetDefinition {
  metric: string;
  limit: number;
  unit: "bytes" | "count" | "ms";
  description: string;
}

export interface BudgetResult extends BudgetDefinition {
  actual: number;
  passed: boolean;
}

export interface ScenarioObservation {
  name: string;
  workload: Record<string, boolean | number | string>;
  timings: TimingSummary;
  memory: MemorySummary;
  metrics: Record<string, number>;
  budgets: BudgetDefinition[];
  counters: Record<string, number>;
  notes: string[];
  longTaskSamplesMs?: number[];
}

export interface ScenarioResult
  extends Omit<ScenarioObservation, "budgets" | "longTaskSamplesMs"> {
  budgets: BudgetResult[];
  longTasks: { durationMs: number; sample: number }[];
  passed: boolean;
}

export const percentile = (
  samples: readonly number[],
  percentileValue: number,
): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.min(rank, sorted.length - 1)]!;
};

export const summarizeTimings = (
  samplesMs: readonly number[],
): TimingSummary => ({
  samplesMs: [...samplesMs],
  p50Ms: percentile(samplesMs, 50),
  p95Ms: percentile(samplesMs, 95),
  maxMs: samplesMs.length === 0 ? 0 : Math.max(...samplesMs),
});

export const memorySummary = (
  beforeBytes: number,
  peakBytes: number,
  afterGcBytes: number,
): MemorySummary => ({
  beforeBytes,
  peakBytes,
  afterGcBytes,
  peakWorkingBytes: Math.max(0, peakBytes - beforeBytes),
  retainedBytes: Math.max(0, afterGcBytes - beforeBytes),
});

export const evaluateScenario = (
  observation: ScenarioObservation,
  forceBudgetFailure = false,
): ScenarioResult => {
  const { longTaskSamplesMs = observation.timings.samplesMs, ...reported } =
    observation;
  const budgets = observation.budgets.map((budget) => {
    const actual = observation.metrics[budget.metric];
    if (actual === undefined) {
      throw new Error(
        `Scenario ${observation.name} did not report budget metric ${budget.metric}`,
      );
    }
    return {
      ...budget,
      actual,
      passed: actual <= budget.limit,
    };
  });
  if (forceBudgetFailure) {
    budgets.push({
      metric: "forcedFailure",
      actual: 1,
      limit: 0,
      unit: "count",
      description: "Deliberate harness self-test",
      passed: false,
    });
  }
  return {
    ...reported,
    budgets,
    longTasks: longTaskSamplesMs.flatMap((durationMs, sample) =>
      durationMs > 50 ? [{ durationMs, sample }] : [],
    ),
    passed: budgets.every((budget) => budget.passed),
  };
};

export const collectMemory = (): number => {
  const memory = process.memoryUsage();
  return memory.heapUsed + memory.external;
};

export const collectAfterGc = (): number => {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  return collectMemory();
};

export const roundResult = <Value>(value: Value): Value =>
  JSON.parse(
    JSON.stringify(value, (_key, candidate: unknown) =>
      typeof candidate === "number" ? Number(candidate.toFixed(3)) : candidate,
    ),
  ) as Value;
