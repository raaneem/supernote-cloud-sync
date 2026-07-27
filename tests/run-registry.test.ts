import { describe, expect, it, vi } from "vitest";

import { RunRegistry } from "../src/run/run-registry";

describe("RunRegistry", () => {
  it("line-buffers timestamped output and truncates the oldest log", () => {
    let now = 1_000;
    const registry = new RunRegistry({
      now: () => now,
      maxLogBytes: 60,
    });
    const run = registry.start({
      kind: "automation",
      label: "Scratch dispatch",
      engine: "claude",
      model: "sonnet",
    });

    run.append("stdout", "first");
    now = 1_250;
    run.append("stdout", " line\nsecond line\n");
    now = 1_500;
    run.append("stderr", "failure detail\n");
    run.finish("failed", { exitCode: 1, batchPath: "/tmp/batch" });

    const record = registry.records()[0]!;
    const log = registry.logText(record.id);
    expect(record.logBytes).toBeLessThanOrEqual(60);
    expect(new TextEncoder().encode(log).byteLength).toBe(record.logBytes);
    expect(log).not.toContain("first line");
    expect(log).toContain("[+0.500s] [stderr] failure detail");
    expect(record.batchPath).toBe("/tmp/batch");
  });

  it("keeps active runs first and only the latest completed runs", () => {
    let id = 0;
    let now = 0;
    const registry = new RunRegistry({
      id: () => `run-${++id}`,
      now: () => ++now,
      maxCompleted: 2,
    });
    const oldest = registry.start({
      kind: "transcription",
      label: "Oldest",
      engine: "api",
      model: "default",
    });
    oldest.finish("succeeded");
    const middle = registry.start({
      kind: "transcription",
      label: "Middle",
      engine: "api",
      model: "default",
    });
    middle.finish("succeeded");
    const newest = registry.start({
      kind: "transcription",
      label: "Newest",
      engine: "api",
      model: "default",
    });
    newest.finish("succeeded");
    registry.start({
      kind: "automation",
      label: "Active",
      engine: "codex",
      model: "default",
    });

    expect(registry.records().map((record) => record.label)).toEqual([
      "Active",
      "Newest",
      "Middle",
    ]);
  });

  it("bounds output even when a process never emits a newline", () => {
    const registry = new RunRegistry({ maxLogBytes: 256 });
    const run = registry.start({
      kind: "automation",
      label: "Runaway",
      engine: "command",
      model: "custom command",
    });

    run.append("stdout", "x".repeat(10_000));

    const record = registry.records()[0]!;
    expect(record.logBytes).toBeLessThanOrEqual(256);
    expect(registry.logText(record.id)).toContain("x");
  });

  it("publishes typed log signals without changing metadata or indicator", () => {
    const registry = new RunRegistry({ id: () => "typed-run" });
    const signals: string[] = [];
    registry.subscribe((signal) => signals.push(signal.type));
    const run = registry.start({
      kind: "automation",
      label: "Typed",
      engine: "command",
      model: "custom",
    });

    run.append("stdout", "one\n");
    run.append("stderr", "two\n");

    expect(signals).toEqual(["metadata", "indicator", "log", "log"]);
    expect(registry.readLog(run.id)).toMatchObject({
      cursor: 2,
      oldestSequence: 1,
      truncated: false,
    });
  });

  it("serves retained deltas from a cursor and reports eviction", () => {
    const registry = new RunRegistry({
      id: () => "delta-run",
      maxLogBytes: 80,
      now: () => 0,
    });
    const run = registry.start({
      kind: "transcription",
      label: "Delta",
      engine: "api",
      model: "vision",
    });
    run.append("stdout", "first retained line\n");
    const cursor = registry.readLog(run.id).cursor;
    run.append("stdout", "second retained line\n");
    run.append("stdout", "third retained line\n");
    run.append("stdout", "fourth retained line\n");

    const delta = registry.readLog(run.id, cursor);
    expect(delta.truncated).toBe(true);
    expect(delta.oldestSequence).toBeGreaterThan(1);
    expect(delta.entries.map((entry) => entry.text).join("")).not.toContain(
      "first retained line",
    );
  });

  it("preserves CRLF boundaries split across process chunks", () => {
    const registry = new RunRegistry({
      id: () => "crlf-run",
      now: () => 0,
    });
    const run = registry.start({
      kind: "automation",
      label: "Chunks",
      engine: "command",
      model: "custom",
    });

    run.append("stdout", "first\r");
    run.append("stdout", "\nsecond\r\n");

    expect(registry.logText(run.id)).toBe(
      "[+0.000s] first\n[+0.000s] second\n",
    );
  });

  it("exposes cancellation and failure acknowledgement to the indicator", () => {
    let now = 5_000;
    const cancel = vi.fn();
    const registry = new RunRegistry({ now: () => now });
    const run = registry.start({
      kind: "automation",
      label: "Journal",
      engine: "codex",
      model: "default",
    });
    run.setCancel(cancel);

    expect(registry.indicator(now)).toEqual({
      state: "running",
      activeCount: 1,
      activeLabel: "Journal",
    });
    expect(registry.cancel(run.id)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registry.cancel(run.id)).toBe(false);

    run.finish("cancelled", { batchPath: "/tmp/journal" });
    expect(registry.indicator(now)).toEqual({
      state: "failure",
      activeCount: 0,
    });
    registry.acknowledgeFailures();
    expect(registry.indicator(now)).toEqual({
      state: "idle",
      activeCount: 0,
    });

    now += 1_000;
    const success = registry.start({
      kind: "transcription",
      label: "Notes",
      engine: "api",
      model: "vision",
    });
    success.finish("succeeded");
    expect(registry.indicator(now)).toEqual({
      state: "success",
      activeCount: 0,
    });
    expect(registry.nextIndicatorChangeIn(now)).toBe(5_000);
    now += 5_001;
    expect(registry.indicator(now)).toEqual({
      state: "idle",
      activeCount: 0,
    });
    expect(registry.nextIndicatorChangeIn(now)).toBeNull();
  });

  it("represents sync work in the shared Supernote activity indicator", () => {
    const registry = new RunRegistry({ id: () => "sync-run" });
    registry.start({
      kind: "sync",
      label: "Syncing mirrored files",
      engine: "cloud",
      model: "mirror",
    });

    expect(registry.indicator()).toEqual({
      state: "running",
      activeCount: 1,
      activeLabel: "Syncing mirrored files",
    });
    expect(registry.records()[0]).toMatchObject({
      kind: "sync",
      engine: "cloud",
      model: "mirror",
    });
  });

  it("keeps unresolved Pair conflicts visible after failures are acknowledged", () => {
    const registry = new RunRegistry();

    registry.setAttention("2 Pair conflicts need attention", 2);
    registry.acknowledgeFailures();

    expect(registry.indicator()).toEqual({
      state: "failure",
      activeCount: 0,
      attentionCount: 2,
      attentionLabel: "2 Pair conflicts need attention",
    });

    registry.setAttention("", 0);
    expect(registry.indicator()).toEqual({
      state: "idle",
      activeCount: 0,
    });
  });

  it("updates the active label as a sync moves through phases", () => {
    const registry = new RunRegistry({ id: () => "sync-run" });
    const run = registry.start({
      kind: "sync",
      label: "Scanning Supernote Cloud",
      engine: "cloud",
      model: "mirror",
    });

    run.setLabel("Reconciling Pair");

    expect(registry.record(run.id)?.label).toBe("Reconciling Pair");
    expect(registry.indicator().activeLabel).toBe("Reconciling Pair");
  });
});
