import { describe, expect, it } from "vitest";

import { RunLogPaintScheduler } from "../src/run/run-log-paint-scheduler";

describe("RunLogPaintScheduler", () => {
  it("coalesces repeated run signals into one paint per frame", () => {
    let frame: FrameRequestCallback | null = null;
    let requests = 0;
    const paints: readonly string[][] = [];
    const scheduler = new RunLogPaintScheduler(
      (callback) => {
        frame = callback;
        requests += 1;
        return requests;
      },
      () => {},
      (runIds) => (paints as string[][]).push([...runIds]),
    );

    scheduler.schedule("one");
    scheduler.schedule("one");
    scheduler.schedule("two");

    expect(requests).toBe(1);
    expect(paints).toEqual([]);
    (frame as unknown as FrameRequestCallback)(0);
    expect(paints).toEqual([["one", "two"]]);
  });

  it("flushes pending output synchronously for completion metadata", () => {
    let cancelled = 0;
    const paints: string[][] = [];
    const scheduler = new RunLogPaintScheduler(
      () => 4,
      () => {
        cancelled += 1;
      },
      (runIds) => paints.push([...runIds]),
    );

    scheduler.schedule("background-run");
    scheduler.flush();

    expect(cancelled).toBe(1);
    expect(paints).toEqual([["background-run"]]);
  });
});
