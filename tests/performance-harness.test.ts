import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  compareScenarioToBaseline,
  evaluateScenario,
  memorySummary,
  percentile,
  regressionGatePassed,
  summarizeTimings,
  type ScenarioObservation,
} from "../benchmarks/harness";
import {
  parseArguments,
  validateBaselineIdentity,
  validateBaselineWorkload,
} from "../benchmarks/run";
import {
  blankRlePage,
  REFERENCE_GRID_PAGES,
  REFERENCE_NOTEBOOK_PAGES,
  REFERENCE_SYNC_BYTES,
  REFERENCE_SYNC_FILES,
  syncWorkload,
} from "../benchmarks/workloads";

const observation = (): ScenarioObservation => ({
  name: "test",
  workload: { generated: true },
  timings: summarizeTimings([1, 2, 3]),
  memory: memorySummary(100, 150, 110),
  metrics: { duration: 3 },
  budgets: [
    {
      metric: "duration",
      limit: 4,
      unit: "ms",
      description: "Test duration",
    },
  ],
  counters: {},
  notes: [],
});

describe("performance harness", () => {
  it("keeps numeric Performance-budget policy out of production operations", async () => {
    const production = (
      await Promise.all(
        [
          "../src/main.ts",
          "../src/note/notebook-service.ts",
          "../src/ocr/api-ocr.ts",
        ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
      )
    ).join("\n");

    expect(production).not.toMatch(
      /MOBILE_RENDER_BUDGET|DESKTOP_RENDER_BUDGET|DOCUMENT_REQUEST_BYTE_LIMIT|resource budget/i,
    );
  });

  it("uses nearest-rank percentiles and keeps raw samples", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(summarizeTimings([3, 1, 2])).toEqual({
      samplesMs: [3, 1, 2],
      p50Ms: 2,
      p95Ms: 3,
      maxMs: 3,
    });
  });

  it("reports memory deltas without allowing negative retained bytes", () => {
    expect(memorySummary(100, 180, 90)).toEqual({
      beforeBytes: 100,
      peakBytes: 180,
      afterGcBytes: 90,
      peakWorkingBytes: 80,
      retainedBytes: 0,
    });
  });

  it("can deliberately fail an otherwise passing budget", () => {
    expect(evaluateScenario(observation()).passed).toBe(true);
    const forced = evaluateScenario(observation(), true);
    expect(forced.passed).toBe(false);
    expect(forced.budgets.at(-1)).toMatchObject({
      metric: "forcedFailure",
      passed: false,
    });
  });

  it("gates CI only on matching-baseline regressions, not absolute targets", () => {
    expect(regressionGatePassed(false, [])).toBe(true);
    expect(
      regressionGatePassed(true, [
        {
          metric: "duration",
          baseline: 2,
          actual: 3,
          toleranceFraction: 0.2,
          limit: 2.4,
          passed: false,
        },
      ]),
    ).toBe(false);
  });

  it("fails a meaningful regression against a matching scenario baseline", () => {
    const current = evaluateScenario(observation());
    const comparisons = compareScenarioToBaseline(
      current,
      { name: "test", metrics: { duration: 2 } },
      0.2,
    );

    expect(comparisons).toEqual([
      {
        metric: "duration",
        baseline: 2,
        actual: 3,
        toleranceFraction: 0.2,
        limit: 2.4,
        passed: false,
      },
    ]);
  });

  it("does not silently drop a metric required by the reviewed baseline", () => {
    expect(() =>
      compareScenarioToBaseline(
        evaluateScenario(observation()),
        { name: "test", metrics: { missing: 2 } },
        0.2,
      ),
    ).toThrow(/did not report baseline metric missing/);
  });

  it("uses component timings for split startup long tasks", () => {
    const split = observation();
    split.timings = summarizeTimings([50.1]);
    split.longTaskSamplesMs = [49.8, 0.3];

    expect(evaluateScenario(split).longTasks).toEqual([]);
  });

  it("keeps the reference workload contracts explicit", () => {
    expect(REFERENCE_NOTEBOOK_PAGES).toBe(20);
    expect(REFERENCE_GRID_PAGES).toBe(1_000);
    expect(REFERENCE_SYNC_FILES).toBe(500);
    expect(REFERENCE_SYNC_BYTES).toBe(1_024 ** 3);
    expect(syncWorkload("reference")).toMatchObject({
      files: 500,
      totalBytes: 1_024 ** 3,
    });
  });

  it("generates deterministic blank Ratta pages", () => {
    const first = blankRlePage(192, 256);
    const second = blankRlePage(192, 256);
    expect(first).toEqual(second);
    expect(first.byteLength).toBe(6);
    expect([...first]).toEqual([0x62, 0xff, 0x62, 0xff, 0x62, 0xff]);
  });

  it("parses platform, profile, and scenario selection", () => {
    expect(
      parseArguments([
        "--platform",
        "mobile",
        "--profile",
        "smoke",
        "--record",
        "--scenario",
        "page-rendering,run-log-streaming",
      ]),
    ).toMatchObject({
      platform: "mobile",
      profile: "smoke",
      record: true,
      scenarios: ["page-rendering", "run-log-streaming"],
      tolerance: 0.2,
    });
  });

  it("rejects a baseline captured for a different execution profile", () => {
    expect(() =>
      validateBaselineIdentity(
        {
          device: "iphone",
          platform: "mobile",
          profile: "standard",
        },
        {
          environment: { device: "desktop", platform: "desktop" },
          profile: "standard",
          scenarios: [],
        },
      ),
    ).toThrow(/must match device, platform contract, and workload profile/);
  });

  it("rejects a same-profile baseline with a different scenario workload", () => {
    expect(() =>
      validateBaselineWorkload(
        { name: "page-rendering", workload: { pages: 20 } },
        {
          name: "page-rendering",
          workload: { pages: 10 },
          metrics: {},
        },
      ),
    ).toThrow(/baseline workload does not match/);
  });
});
