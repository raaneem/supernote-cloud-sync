import type { DesktopProcessObserver } from "../shared/desktop-command";
import {
  type RunLogDelta,
  RunStreamLineBuffer,
  SequencedRunLog,
} from "./run-log";

export type RunKind = "sync" | "automation" | "transcription";
export type RunEngine = "cloud" | "claude" | "codex" | "command" | "api";
export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled";
export type RunStream = "stdout" | "stderr";

export interface RunRecord {
  id: string;
  kind: RunKind;
  label: string;
  engine: RunEngine;
  model: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  exitCode?: number | null;
  logBytes: number;
  logCursor: number;
  batchPath?: string;
  cancellable: boolean;
}

export interface RunIndicator {
  state: "idle" | "running" | "failure" | "success";
  activeCount: number;
  activeLabel?: string;
  attentionCount?: number;
  attentionLabel?: string;
}

export type RunRegistrySignal =
  | { type: "metadata"; runId: string }
  | { type: "indicator"; indicator: RunIndicator }
  | { type: "log"; runId: string; cursor: number };

interface StartRunInput {
  kind: RunKind;
  label: string;
  engine: RunEngine;
  model: string;
}

interface FinishRunOptions {
  exitCode?: number | null;
  batchPath?: string;
}

interface RunRegistryOptions {
  now?: () => number;
  id?: () => string;
  maxLogBytes?: number;
  maxCompleted?: number;
  successVisibleMs?: number;
}

interface MutableRun extends Omit<RunRecord, "logBytes" | "logCursor"> {
  cancel: (() => void) | undefined;
  log: SequencedRunLog;
  pending: Record<RunStream, RunStreamLineBuffer>;
}

const defaultId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const indicatorKey = (indicator: RunIndicator): string =>
  [
    indicator.state,
    indicator.activeCount,
    indicator.activeLabel ?? "",
    indicator.attentionCount ?? 0,
    indicator.attentionLabel ?? "",
  ].join(":");

export class RunHandle {
  constructor(
    readonly id: string,
    private readonly registry: RunRegistry,
  ) {}

  append(stream: RunStream, chunk: string): void {
    this.registry.append(this.id, stream, chunk);
  }

  setCancel(cancel: () => void): void {
    this.registry.setCancel(this.id, cancel);
  }

  setLabel(label: string): void {
    this.registry.setLabel(this.id, label);
  }

  processObserver(): DesktopProcessObserver {
    return {
      onStdout: (chunk) => this.append("stdout", chunk),
      onStderr: (chunk) => this.append("stderr", chunk),
      setCancel: (cancel) => this.setCancel(cancel),
    };
  }

  finish(
    status: Exclude<RunStatus, "running">,
    options: FinishRunOptions = {},
  ): void {
    this.registry.finish(this.id, status, options);
  }
}

export class RunRegistry {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxLogBytes: number;
  private readonly maxCompleted: number;
  private readonly successVisibleMs: number;
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<(signal: RunRegistrySignal) => void>();
  private unacknowledgedFailure = false;
  private attentionCount = 0;
  private attentionLabel = "";
  private lastIndicatorKey = indicatorKey({
    state: "idle",
    activeCount: 0,
  });

  constructor(options: RunRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.id ?? defaultId;
    this.maxLogBytes = Math.max(1, options.maxLogBytes ?? 256 * 1024);
    this.maxCompleted = Math.max(1, options.maxCompleted ?? 20);
    this.successVisibleMs = Math.max(0, options.successVisibleMs ?? 5_000);
  }

  start(input: StartRunInput): RunHandle {
    const id = this.createId();
    this.runs.set(id, {
      ...input,
      id,
      startedAt: this.now(),
      status: "running",
      cancellable: false,
      cancel: undefined,
      log: new SequencedRunLog(this.maxLogBytes),
      pending: {
        stdout: new RunStreamLineBuffer(this.maxLogBytes),
        stderr: new RunStreamLineBuffer(this.maxLogBytes),
      },
    });
    this.emit({ type: "metadata", runId: id });
    this.emitIndicatorIfChanged();
    return new RunHandle(id, this);
  }

  record(id: string): RunRecord | undefined {
    const run = this.runs.get(id);
    return run ? this.publicRecord(run) : undefined;
  }

  records(): readonly RunRecord[] {
    return [...this.runs.values()]
      .sort((left, right) => {
        if (left.status === "running" && right.status !== "running") {
          return -1;
        }
        if (left.status !== "running" && right.status === "running") {
          return 1;
        }
        const leftTime = left.finishedAt ?? left.startedAt;
        const rightTime = right.finishedAt ?? right.startedAt;
        return rightTime - leftTime;
      })
      .map((run) => this.publicRecord(run));
  }

  readLog(id: string, afterSequence = 0): RunLogDelta {
    return (
      this.runs.get(id)?.log.read(afterSequence) ?? {
        cursor: 0,
        entries: [],
        oldestSequence: 1,
        truncated: false,
      }
    );
  }

  logText(id: string): string {
    return this.runs.get(id)?.log.text() ?? "";
  }

  subscribe(listener: (signal: RunRegistrySignal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run?.cancel || run.status !== "running") {
      return false;
    }
    const cancel = run.cancel;
    run.cancel = undefined;
    run.cancellable = false;
    this.emit({ type: "metadata", runId: id });
    cancel();
    return true;
  }

  acknowledgeFailures(): void {
    if (!this.unacknowledgedFailure) {
      return;
    }
    this.unacknowledgedFailure = false;
    this.emitIndicatorIfChanged();
  }

  setAttention(label: string, count: number): void {
    const nextCount = Math.max(0, Math.floor(count));
    const nextLabel = nextCount > 0 ? label : "";
    if (
      nextCount === this.attentionCount &&
      nextLabel === this.attentionLabel
    ) {
      return;
    }
    this.attentionCount = nextCount;
    this.attentionLabel = nextLabel;
    this.emitIndicatorIfChanged();
  }

  indicator(now = this.now()): RunIndicator {
    const records = this.records();
    const active = records.filter((record) => record.status === "running");
    const activeCount = active.length;
    if (activeCount > 0) {
      return {
        state: "running",
        activeCount,
        ...(activeCount === 1 ? { activeLabel: active[0]!.label } : {}),
      };
    }
    if (this.attentionCount > 0) {
      return {
        state: "failure",
        activeCount: 0,
        attentionCount: this.attentionCount,
        attentionLabel: this.attentionLabel,
      };
    }
    if (this.unacknowledgedFailure) {
      return { state: "failure", activeCount: 0 };
    }
    const recentSuccess = records.some(
      (record) =>
        record.status === "succeeded" &&
        record.finishedAt !== undefined &&
        now - record.finishedAt <= this.successVisibleMs,
    );
    return {
      state: recentSuccess ? "success" : "idle",
      activeCount: 0,
    };
  }

  nextIndicatorChangeIn(now = this.now()): number | null {
    if (this.indicator(now).state !== "success") {
      return null;
    }
    const latestSuccess = this.records().reduce(
      (latest, record) =>
        record.status === "succeeded" && record.finishedAt !== undefined
          ? Math.max(latest, record.finishedAt)
          : latest,
      0,
    );
    return Math.max(0, latestSuccess + this.successVisibleMs - now);
  }

  append(id: string, stream: RunStream, chunk: string): void {
    const run = this.runs.get(id);
    if (!run || run.status !== "running" || !chunk) {
      return;
    }
    const lines = run.pending[stream].push(chunk);
    if (lines.length === 0) {
      return;
    }
    for (const line of lines) {
      this.appendLine(run, stream, line);
    }
    this.emit({
      type: "log",
      runId: id,
      cursor: run.log.cursor,
    });
  }

  setCancel(id: string, cancel: () => void): void {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return;
    }
    run.cancel = cancel;
    run.cancellable = true;
    this.emit({ type: "metadata", runId: id });
  }

  setLabel(id: string, label: string): void {
    const run = this.runs.get(id);
    if (!run || run.status !== "running" || run.label === label) {
      return;
    }
    run.label = label;
    this.emit({ type: "metadata", runId: id });
    this.emitIndicatorIfChanged();
  }

  finish(
    id: string,
    status: Exclude<RunStatus, "running">,
    options: FinishRunOptions,
  ): void {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return;
    }
    let appended = false;
    for (const stream of ["stdout", "stderr"] as const) {
      const line = run.pending[stream].flush();
      if (line !== null) {
        this.appendLine(run, stream, line);
        appended = true;
      }
    }
    if (appended) {
      this.emit({
        type: "log",
        runId: id,
        cursor: run.log.cursor,
      });
    }
    run.status = status;
    run.finishedAt = this.now();
    run.cancel = undefined;
    run.cancellable = false;
    if (options.exitCode !== undefined) {
      run.exitCode = options.exitCode;
    }
    if (options.batchPath) {
      run.batchPath = options.batchPath;
    }
    if (
      status === "failed" ||
      status === "timed-out" ||
      status === "cancelled"
    ) {
      this.unacknowledgedFailure = true;
    }
    this.evictCompleted();
    this.emit({ type: "metadata", runId: id });
    this.emitIndicatorIfChanged();
  }

  private appendLine(run: MutableRun, stream: RunStream, line: string): void {
    const elapsed = ((this.now() - run.startedAt) / 1_000).toFixed(3);
    const marker = stream === "stderr" ? "[stderr] " : "";
    run.log.append(`[+${elapsed}s] ${marker}${line}\n`);
  }

  private publicRecord(run: MutableRun): RunRecord {
    const { cancel: _cancel, log, pending: _pending, ...record } = run;
    return {
      ...record,
      logBytes: log.byteLength,
      logCursor: log.cursor,
    };
  }

  private evictCompleted(): void {
    const completed = [...this.runs.values()]
      .filter((run) => run.status !== "running")
      .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
    for (const run of completed.slice(this.maxCompleted)) {
      this.runs.delete(run.id);
    }
  }

  private emitIndicatorIfChanged(): void {
    const indicator = this.indicator();
    const key = indicatorKey(indicator);
    if (key === this.lastIndicatorKey) {
      return;
    }
    this.lastIndicatorKey = key;
    this.emit({ type: "indicator", indicator });
  }

  private emit(signal: RunRegistrySignal): void {
    for (const listener of this.listeners) {
      listener(signal);
    }
  }
}
