import { describe, expect, it } from "vitest";

import {
  gridPageNumbers,
  gridScrollTopForPage,
  planGridWindow,
} from "../src/viewer/grid-window";

describe("planGridWindow", () => {
  it("bounds a thousand-page desktop grid to visible rows plus overscan", () => {
    const plan = planGridWindow({
      pageCount: 1_000,
      scrollTop: 20_000,
      viewportHeight: 720,
      viewportWidth: 800,
    });

    expect(plan.columns).toBe(4);
    expect(plan.mountedPages).toBeLessThanOrEqual(32);
    expect(gridPageNumbers(plan)).toHaveLength(plan.mountedPages);
    expect(plan.startPage).toBeGreaterThan(1);
    expect(plan.endPage).toBeLessThan(1_000);
  });

  it("keeps the final page addressable at the bottom of the grid", () => {
    const plan = planGridWindow({
      pageCount: 1_000,
      scrollTop: Number.MAX_SAFE_INTEGER,
      viewportHeight: 700,
      viewportWidth: 390,
    });

    expect(plan.columns).toBe(2);
    expect(plan.endPage).toBe(1_000);
    expect(gridPageNumbers(plan).at(-1)).toBe(1_000);
    expect(plan.mountedPages).toBeLessThanOrEqual(14);
  });

  it("centers a requested page without mounting preceding cards", () => {
    const geometry = planGridWindow({
      pageCount: 1_000,
      scrollTop: 0,
      viewportHeight: 700,
      viewportWidth: 800,
    });
    const scrollTop = gridScrollTopForPage(500, 700, geometry);
    const centered = planGridWindow({
      pageCount: 1_000,
      scrollTop,
      viewportHeight: 700,
      viewportWidth: 800,
    });

    expect(gridPageNumbers(centered)).toContain(500);
    expect(centered.startPage).toBeGreaterThan(400);
  });
});
