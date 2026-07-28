import { describe, expect, it } from "vitest";

import {
  PerformanceDiagnostics,
  performanceFailureCategory,
  type PerformanceDiagnosticsSnapshot,
} from "../src/onboarding/performance-diagnostics";

describe("PerformanceDiagnostics", () => {
  it("bounds completed operation evidence without storing user paths", () => {
    let now = 1_000;
    const diagnostics = new PerformanceDiagnostics(undefined, {
      now: () => now,
      capacity: 2,
    });

    for (const kind of ["notebook-open", "sync", "export"] as const) {
      const operation = diagnostics.begin(kind);
      now += 25;
      diagnostics.finish(operation, {
        outcome: "succeeded",
        peakTrackedBytes: 100,
        settledTrackedBytes: 10,
      });
    }

    expect(diagnostics.snapshot()).toEqual({
      active: [],
      recent: [
        {
          kind: "sync",
          outcome: "succeeded",
          durationMs: 25,
          peakTrackedBytes: 100,
          settledTrackedBytes: 10,
          cleanup: "retained",
          failureCategory: null,
        },
        {
          kind: "export",
          outcome: "succeeded",
          durationMs: 25,
          peakTrackedBytes: 100,
          settledTrackedBytes: 10,
          cleanup: "retained",
          failureCategory: null,
        },
      ],
    });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("/");
  });

  it("turns unfinished persisted work into one consumable interruption", () => {
    const persisted: PerformanceDiagnosticsSnapshot = {
      active: [
        {
          id: "operation-1",
          kind: "notebook-open",
          scope: "scope-1",
          startedAtMs: 900,
        },
      ],
      recent: [],
    };
    const diagnostics = new PerformanceDiagnostics(persisted, {
      now: () => 1_000,
    });

    expect(diagnostics.consumeInterrupted("notebook-open", "scope-1")).toBe(
      true,
    );
    expect(diagnostics.consumeInterrupted("notebook-open", "scope-1")).toBe(
      false,
    );
    expect(diagnostics.snapshot()).toEqual({
      active: [],
      recent: [
        {
          kind: "notebook-open",
          outcome: "interrupted",
          durationMs: 100,
          peakTrackedBytes: null,
          settledTrackedBytes: null,
          cleanup: "unknown",
          failureCategory: "host-interrupted",
        },
      ],
    });
  });

  it("does not consume an interrupted marker for a different notebook scope", () => {
    const diagnostics = new PerformanceDiagnostics(
      {
        active: [
          {
            id: "operation-1",
            kind: "notebook-open",
            scope: "scope-1",
            startedAtMs: 900,
          },
        ],
        recent: [],
      },
      { now: () => 1_000 },
    );

    expect(diagnostics.consumeInterrupted("notebook-open", "scope-2")).toBe(
      false,
    );
    expect(diagnostics.consumeInterrupted("notebook-open", "scope-1")).toBe(
      true,
    );
  });

  it("does not classify an explicitly cancelled operation as interrupted", () => {
    const diagnostics = new PerformanceDiagnostics(undefined, {
      now: () => 1_000,
    });
    const operation = diagnostics.begin("notebook-open");

    diagnostics.finish(operation, {
      outcome: "cancelled",
      peakTrackedBytes: null,
      settledTrackedBytes: null,
    });

    expect(diagnostics.consumeInterrupted("notebook-open")).toBe(false);
    expect(diagnostics.snapshot().recent[0]).toMatchObject({
      outcome: "cancelled",
      failureCategory: null,
    });
  });

  it("clears active markers during a normal plugin shutdown", () => {
    const diagnostics = new PerformanceDiagnostics(undefined, {
      now: () => 1_000,
    });
    diagnostics.begin("notebook-open");
    diagnostics.begin("sync");

    diagnostics.cancelActive();

    expect(diagnostics.snapshot().active).toEqual([]);
    expect(
      new PerformanceDiagnostics(diagnostics.snapshot(), {
        now: () => 2_000,
      }).consumeInterrupted("notebook-open"),
    ).toBe(false);
  });

  it("classifies failures without persisting their message", () => {
    expect(performanceFailureCategory(new Error("worker crashed"))).toBe(
      "worker",
    );
    expect(performanceFailureCategory(new Error("HTTP 503"))).toBe(
      "network-or-api",
    );
    expect(performanceFailureCategory(new Error("secret notebook title"))).toBe(
      "unexpected",
    );
  });
});
