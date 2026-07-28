export type PerformanceOperationKind =
  | "notebook-open"
  | "sync"
  | "export"
  | "transcription";

export type PerformanceOperationOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ActivePerformanceOperation {
  readonly id: string;
  readonly kind: PerformanceOperationKind;
  readonly scope: string | null;
  readonly startedAtMs: number;
}

export interface PerformanceDiagnosticRecord {
  readonly kind: PerformanceOperationKind;
  readonly outcome: PerformanceOperationOutcome;
  readonly durationMs: number;
  readonly peakTrackedBytes: number | null;
  readonly settledTrackedBytes: number | null;
  readonly cleanup: "released" | "retained" | "unknown";
  readonly failureCategory: string | null;
}

export interface PerformanceDiagnosticsSnapshot {
  readonly active: readonly ActivePerformanceOperation[];
  readonly recent: readonly PerformanceDiagnosticRecord[];
}

interface PerformanceDiagnosticsOptions {
  readonly now?: () => number;
  readonly capacity?: number;
}

export interface FinishPerformanceOperation {
  readonly outcome: Exclude<PerformanceOperationOutcome, "interrupted">;
  readonly peakTrackedBytes: number | null;
  readonly settledTrackedBytes: number | null;
  readonly failureCategory?: string | null;
}

const operationKinds = new Set<PerformanceOperationKind>([
  "notebook-open",
  "sync",
  "export",
  "transcription",
]);

const operationOutcomes = new Set<PerformanceOperationOutcome>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const finiteNonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

export const normalizePerformanceDiagnostics = (
  value: unknown,
): PerformanceDiagnosticsSnapshot => {
  if (typeof value !== "object" || value === null) {
    return { active: [], recent: [] };
  }
  const candidate = value as {
    active?: unknown;
    recent?: unknown;
  };
  const active = Array.isArray(candidate.active)
    ? candidate.active.flatMap((item): ActivePerformanceOperation[] => {
        if (typeof item !== "object" || item === null) {
          return [];
        }
        const operation = item as {
          id?: unknown;
          kind?: unknown;
          scope?: unknown;
          startedAtMs?: unknown;
        };
        return typeof operation.id === "string" &&
          operationKinds.has(operation.kind as PerformanceOperationKind) &&
          finiteNonnegative(operation.startedAtMs) !== null
          ? [
              {
                id: operation.id,
                kind: operation.kind as PerformanceOperationKind,
                scope:
                  typeof operation.scope === "string" ? operation.scope : null,
                startedAtMs: operation.startedAtMs as number,
              },
            ]
          : [];
      })
    : [];
  const recent = Array.isArray(candidate.recent)
    ? candidate.recent.flatMap((item): PerformanceDiagnosticRecord[] => {
        if (typeof item !== "object" || item === null) {
          return [];
        }
        const record = item as Record<string, unknown>;
        const durationMs = finiteNonnegative(record.durationMs);
        if (
          !operationKinds.has(record.kind as PerformanceOperationKind) ||
          !operationOutcomes.has(
            record.outcome as PerformanceOperationOutcome,
          ) ||
          durationMs === null ||
          (record.cleanup !== "released" &&
            record.cleanup !== "retained" &&
            record.cleanup !== "unknown")
        ) {
          return [];
        }
        return [
          {
            kind: record.kind as PerformanceOperationKind,
            outcome: record.outcome as PerformanceOperationOutcome,
            durationMs,
            peakTrackedBytes: finiteNonnegative(record.peakTrackedBytes),
            settledTrackedBytes: finiteNonnegative(record.settledTrackedBytes),
            cleanup: record.cleanup,
            failureCategory:
              typeof record.failureCategory === "string"
                ? record.failureCategory
                : null,
          },
        ];
      })
    : [];
  return { active, recent };
};

export class PerformanceDiagnostics {
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly active: ActivePerformanceOperation[];
  private readonly recent: PerformanceDiagnosticRecord[];
  private readonly interrupted = new Map<string, number>();
  private sequence = 0;

  constructor(
    snapshot?: PerformanceDiagnosticsSnapshot,
    options: PerformanceDiagnosticsOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.capacity = Math.max(1, Math.trunc(options.capacity ?? 10));
    const normalized = normalizePerformanceDiagnostics(snapshot);
    this.active = [];
    this.recent = [...normalized.recent].slice(-this.capacity);
    const interruptedAt = this.now();
    for (const operation of normalized.active) {
      const key = this.interruptionKey(operation.kind, operation.scope);
      this.interrupted.set(key, (this.interrupted.get(key) ?? 0) + 1);
      this.append({
        kind: operation.kind,
        outcome: "interrupted",
        durationMs: Math.max(0, interruptedAt - operation.startedAtMs),
        peakTrackedBytes: null,
        settledTrackedBytes: null,
        cleanup: "unknown",
        failureCategory: "host-interrupted",
      });
    }
  }

  begin(
    kind: PerformanceOperationKind,
    scope: string | null = null,
  ): ActivePerformanceOperation {
    const startedAtMs = this.now();
    const operation = {
      id: `${kind}-${startedAtMs}-${++this.sequence}`,
      kind,
      scope,
      startedAtMs,
    };
    this.active.push(operation);
    return operation;
  }

  finish(
    operation: ActivePerformanceOperation,
    result: FinishPerformanceOperation,
  ): void {
    const index = this.active.findIndex(
      (candidate) => candidate.id === operation.id,
    );
    if (index < 0) {
      return;
    }
    this.active.splice(index, 1);
    const settled = finiteNonnegative(result.settledTrackedBytes);
    this.append({
      kind: operation.kind,
      outcome: result.outcome,
      durationMs: Math.max(0, this.now() - operation.startedAtMs),
      peakTrackedBytes: finiteNonnegative(result.peakTrackedBytes),
      settledTrackedBytes: settled,
      cleanup:
        settled === null ? "unknown" : settled === 0 ? "released" : "retained",
      failureCategory: result.failureCategory ?? null,
    });
  }

  consumeInterrupted(
    kind: PerformanceOperationKind,
    scope: string | null = null,
  ): boolean {
    const key = this.interruptionKey(kind, scope);
    const count = this.interrupted.get(key) ?? 0;
    if (count === 0) {
      return false;
    }
    if (count === 1) {
      this.interrupted.delete(key);
    } else {
      this.interrupted.set(key, count - 1);
    }
    return true;
  }

  cancelActive(): void {
    for (const operation of [...this.active]) {
      this.finish(operation, {
        outcome: "cancelled",
        peakTrackedBytes: null,
        settledTrackedBytes: null,
      });
    }
  }

  snapshot(): PerformanceDiagnosticsSnapshot {
    return {
      active: this.active.map((operation) => ({ ...operation })),
      recent: this.recent.map((record) => ({ ...record })),
    };
  }

  private append(record: PerformanceDiagnosticRecord): void {
    this.recent.push(record);
    this.recent.splice(0, Math.max(0, this.recent.length - this.capacity));
  }

  private interruptionKey(
    kind: PerformanceOperationKind,
    scope: string | null,
  ): string {
    return `${kind}:${scope ?? ""}`;
  }
}

export const performanceFailureCategory = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "cancelled";
  }
  const name = error instanceof Error ? error.name.toLocaleLowerCase() : "";
  const message =
    error instanceof Error ? error.message.toLocaleLowerCase() : String(error);
  const evidence = `${name} ${message}`;
  if (/timeout|timed out/.test(evidence)) {
    return "timeout";
  }
  if (/memory|allocation|out of memory/.test(evidence)) {
    return "allocation";
  }
  if (/worker/.test(evidence)) {
    return "worker";
  }
  if (/parse|decode|invalid|corrupt|malformed/.test(evidence)) {
    return "parse-or-decode";
  }
  if (/canvas|bitmap|image|render/.test(evidence)) {
    return "rendering";
  }
  if (/network|fetch|http|api|auth|unauthor|forbidden/.test(evidence)) {
    return "network-or-api";
  }
  if (/permission|denied|not allowed/.test(evidence)) {
    return "permission";
  }
  return "unexpected";
};
