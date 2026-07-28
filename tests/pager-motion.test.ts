import { describe, expect, it } from "vitest";

import {
  navigationTarget,
  pageTransitionCommitDecision,
  pageTransitionRenderTarget,
  PagerSwipeGesture,
  pageTransition,
  preparedPageTransition,
  reducedMotionRequested,
} from "../src/viewer/pager-motion";

describe("page transition preparation", () => {
  it("prepares a non-adjacent target before rendering it", () => {
    const prepared: number[] = [];

    expect(
      preparedPageTransition(2, 12, false, (pageNumber) => {
        prepared.push(pageNumber);
        return true;
      }),
    ).toEqual({
      direction: "next",
      trackPercent: -200,
    });
    expect(prepared).toEqual([12]);
    expect(pageTransitionRenderTarget(2, 12)).toBe(12);
    expect(pageTransitionRenderTarget(2, null)).toBe(2);
  });

  it("does not begin a transition when target preparation fails", () => {
    expect(preparedPageTransition(2, 12, false, () => false)).toBeNull();
  });

  it.each([
    {
      animationComplete: false,
      incomingState: "ready" as const,
      expected: "wait",
    },
    {
      animationComplete: true,
      incomingState: "loading" as const,
      expected: "wait",
    },
    {
      animationComplete: true,
      incomingState: "error" as const,
      expected: "abort",
    },
    {
      animationComplete: true,
      incomingState: "ready" as const,
      expected: "commit",
    },
  ])(
    "returns $expected when animationComplete=$animationComplete and incomingState=$incomingState",
    ({ animationComplete, incomingState, expected }) => {
      expect(
        pageTransitionCommitDecision({
          animationComplete,
          incomingState,
        }),
      ).toBe(expected);
    },
  );
});

describe("reducedMotionRequested", () => {
  it("honors the platform preference and Obsidian's animation duration", () => {
    expect(reducedMotionRequested(true, "140ms")).toBe(true);
    expect(reducedMotionRequested(false, "0ms")).toBe(true);
    expect(reducedMotionRequested(false, "0s")).toBe(true);
    expect(reducedMotionRequested(false, "140ms")).toBe(false);
  });
});

describe("navigationTarget", () => {
  it("advances from the in-flight target instead of queuing transitions", () => {
    expect(navigationTarget(2, 3, 1, 8)).toBe(4);
    expect(navigationTarget(2, 3, -1, 8)).toBe(2);
    expect(navigationTarget(8, null, 1, 8)).toBe(8);
  });
});

describe("pageTransition", () => {
  it("slides next and previous pages in opposite physical directions", () => {
    expect(pageTransition(2, 3, false)).toEqual({
      direction: "next",
      trackPercent: -200,
    });
    expect(pageTransition(2, 1, false)).toEqual({
      direction: "previous",
      trackPercent: 0,
    });
  });

  it("mirrors physical slide direction for RTL", () => {
    expect(pageTransition(2, 3, true)).toEqual({
      direction: "next",
      trackPercent: 0,
    });
    expect(pageTransition(2, 1, true)).toEqual({
      direction: "previous",
      trackPercent: -200,
    });
  });
});

describe("PagerSwipeGesture", () => {
  const begin = (
    currentPage = 2,
    pageCount = 4,
    rtl = false,
  ): PagerSwipeGesture =>
    new PagerSwipeGesture({
      start: { x: 200, y: 300, time: 0 },
      viewportWidth: 300,
      currentPage,
      pageCount,
      rtl,
    });

  it("commits horizontal movement and ignores a vertical gesture", () => {
    const horizontal = begin();
    expect(horizontal.move({ x: 185, y: 304, time: 20 })).toEqual({
      axis: "horizontal",
      offset: -15,
    });

    const vertical = begin();
    expect(vertical.move({ x: 196, y: 280, time: 20 })).toEqual({
      axis: "vertical",
      offset: 0,
    });
    expect(vertical.move({ x: 120, y: 275, time: 40 })).toEqual({
      axis: "vertical",
      offset: 0,
    });
  });

  it("completes after crossing 35 percent of the viewport", () => {
    const gesture = begin();

    expect(gesture.finish({ x: 90, y: 300, time: 500 })).toEqual({
      action: "next",
      offset: -110,
    });
  });

  it("completes a short, clearly fast flick", () => {
    const gesture = begin();

    expect(gesture.finish({ x: 165, y: 300, time: 45 })).toEqual({
      action: "next",
      offset: -35,
    });
  });

  it("uses release velocity rather than whole-gesture average speed", () => {
    const fastRelease = begin();
    fastRelease.move({ x: 160, y: 300, time: 400 });
    expect(fastRelease.finish({ x: 130, y: 300, time: 430 })).toEqual({
      action: "next",
      offset: -70,
    });

    const slowRelease = begin();
    slowRelease.move({ x: 130, y: 300, time: 50 });
    expect(slowRelease.finish({ x: 125, y: 300, time: 500 })).toEqual({
      action: "snap-back",
      offset: -75,
    });

    const heldAfterFastMove = begin();
    heldAfterFastMove.move({ x: 130, y: 300, time: 50 });
    expect(heldAfterFastMove.finish({ x: 130, y: 300, time: 500 })).toEqual({
      action: "snap-back",
      offset: -70,
    });
  });

  it("snaps back after a short, slow drag", () => {
    const gesture = begin();

    expect(gesture.finish({ x: 145, y: 300, time: 400 })).toEqual({
      action: "snap-back",
      offset: -55,
    });
  });

  it("rubber-bands when dragging beyond either notebook edge", () => {
    const beforeFirst = begin(1);
    expect(beforeFirst.move({ x: 300, y: 300, time: 100 })).toEqual({
      axis: "horizontal",
      offset: 32,
    });
    expect(beforeFirst.finish({ x: 300, y: 300, time: 100 })).toEqual({
      action: "snap-back",
      offset: 32,
    });

    const afterLast = begin(4);
    expect(afterLast.move({ x: 100, y: 300, time: 100 })).toEqual({
      axis: "horizontal",
      offset: -32,
    });
  });

  it("mirrors logical swipe direction for RTL", () => {
    const gesture = begin(2, 4, true);

    expect(gesture.finish({ x: 310, y: 300, time: 300 })).toEqual({
      action: "next",
      offset: 110,
    });
  });
});
