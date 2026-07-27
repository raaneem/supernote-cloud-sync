import { describe, expect, it } from "vitest";

import {
  fitPageWithin,
  readerKeyboardZoomIntent,
  readerTouchStartIntent,
  ReaderDoubleTapGesture,
  ReaderViewportTransform,
} from "../src/viewer/reader-viewport";

describe("fitPageWithin", () => {
  it("fits the page by its limiting axis without changing aspect ratio", () => {
    expect(
      fitPageWithin({ width: 1_000, height: 600 }, { width: 3, height: 4 }),
    ).toEqual({ width: 450, height: 600 });
    expect(
      fitPageWithin({ width: 400, height: 800 }, { width: 3, height: 4 }),
    ).toEqual({ width: 400, height: 1600 / 3 });
  });
});

describe("ReaderViewportTransform", () => {
  it("keeps the focal page coordinate stationary while zooming", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 800, height: 600 },
      page: { width: 800, height: 600 },
    });
    const focalPoint = { x: 600, y: 250 };

    const pagePointBefore = transform.pagePointAt(focalPoint);
    expect(transform.zoomAt(2, focalPoint)).toBe(true);

    expect(transform.snapshot).toEqual({
      zoom: 2,
      panX: -200,
      panY: 50,
    });
    expect(transform.pagePointAt(focalPoint)).toEqual(pagePointBefore);
  });

  it("clamps zoom and pan to the scaled page edges", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 800, height: 600 },
      page: { width: 600, height: 600 },
    });

    expect(transform.zoomAt(99, { x: 400, y: 300 })).toBe(true);
    expect(transform.panBy(999, -999)).toBe(true);
    expect(transform.snapshot).toEqual({
      zoom: 3,
      panX: 500,
      panY: -600,
    });
    expect(transform.zoomAt(4, { x: 0, y: 0 })).toBe(false);
    expect(transform.snapshot).toEqual({
      zoom: 3,
      panX: 500,
      panY: -600,
    });
    expect(transform.panBy(1, -1)).toBe(false);

    expect(transform.zoomAt(-1, { x: 400, y: 300 })).toBe(true);
    expect(transform.snapshot).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it("re-clamps the current pan when the viewport is resized", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 600, height: 600 },
      page: { width: 600, height: 600 },
    });
    transform.zoomAt(3, { x: 300, y: 300 });
    transform.panBy(600, 600);

    expect(
      transform.resize({
        viewport: { width: 1_200, height: 900 },
        page: { width: 600, height: 600 },
      }),
    ).toBe(true);
    expect(transform.snapshot).toEqual({
      zoom: 3,
      panX: 300,
      panY: 450,
    });
    expect(
      transform.resize({
        viewport: { width: 1_200, height: 900 },
        page: { width: 600, height: 600 },
      }),
    ).toBe(false);
  });

  it("steps explicit controls by 25 percentage points at viewport centre", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 800, height: 600 },
      page: { width: 800, height: 600 },
    });

    expect(transform.canZoomOut).toBe(false);
    expect(transform.canZoomIn).toBe(true);
    expect(transform.stepZoom(1)).toBe(true);
    expect(transform.snapshot).toEqual({
      zoom: 1.25,
      panX: 0,
      panY: 0,
    });
    for (let index = 0; index < 7; index += 1) {
      transform.stepZoom(1);
    }
    expect(transform.snapshot.zoom).toBe(3);
    expect(transform.canZoomIn).toBe(false);
    expect(transform.canZoomOut).toBe(true);
    expect(transform.stepZoom(1)).toBe(false);
    expect(transform.stepZoom(-1)).toBe(true);
    expect(transform.snapshot.zoom).toBe(2.75);
  });

  it("settles a near-fit pinch to exact fit and clears pan", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 800, height: 600 },
      page: { width: 800, height: 600 },
    });
    transform.zoomAt(1.05, { x: 100, y: 100 });

    expect(transform.settlePinch()).toBe(true);
    expect(transform.snapshot).toEqual({ zoom: 1, panX: 0, panY: 0 });

    transform.zoomAt(1.051, { x: 100, y: 100 });
    expect(transform.settlePinch()).toBe(false);
    expect(transform.snapshot.zoom).toBe(1.051);
  });

  it("normalizes wheel input and pans only above fit", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 800, height: 600 },
      page: { width: 800, height: 600 },
    });
    const focalPoint = { x: 400, y: 300 };

    expect(
      transform.applyWheel({
        deltaX: 0,
        deltaY: 30,
        deltaMode: 0,
        ctrlKey: false,
        pageTransitionActive: false,
        focalPoint,
      }),
    ).toEqual({ consumed: false, changed: false });
    expect(
      transform.applyWheel({
        deltaX: 0,
        deltaY: -50,
        deltaMode: 0,
        ctrlKey: true,
        pageTransitionActive: false,
        focalPoint,
      }),
    ).toEqual({ consumed: true, changed: true });
    expect(transform.snapshot.zoom).toBeCloseTo(Math.exp(0.1));

    expect(
      transform.applyWheel({
        deltaX: -2,
        deltaY: 3,
        deltaMode: 1,
        ctrlKey: false,
        pageTransitionActive: false,
        focalPoint,
      }),
    ).toEqual({ consumed: true, changed: true });
    expect(transform.snapshot.panX).toBe(32);
    expect(transform.snapshot.panY).toBeCloseTo(-31.551);

    transform.zoomAt(3, focalPoint);
    expect(
      transform.applyWheel({
        deltaX: 0,
        deltaY: -100,
        deltaMode: 0,
        ctrlKey: true,
        pageTransitionActive: false,
        focalPoint,
      }),
    ).toEqual({ consumed: true, changed: false });

    const beforeTransitionWheel = transform.snapshot;
    expect(
      transform.applyWheel({
        deltaX: 0,
        deltaY: 100,
        deltaMode: 0,
        ctrlKey: true,
        pageTransitionActive: true,
        focalPoint,
      }),
    ).toEqual({ consumed: true, changed: false });
    expect(transform.snapshot).toEqual(beforeTransitionWheel);
  });

  it("toggles double-tap zoom between anchored 2× and fit", () => {
    const transform = new ReaderViewportTransform({
      viewport: { width: 800, height: 600 },
      page: { width: 800, height: 600 },
    });

    expect(transform.toggleZoom({ x: 600, y: 300 })).toBe(true);
    expect(transform.snapshot).toEqual({
      zoom: 2,
      panX: -200,
      panY: 0,
    });
    expect(transform.toggleZoom({ x: 100, y: 100 })).toBe(true);
    expect(transform.snapshot).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe("readerTouchStartIntent", () => {
  it("pinches only before a page turn commits and cancels an open drag", () => {
    expect(
      readerTouchStartIntent({
        touchCount: 2,
        zoom: 1,
        pageDragActive: true,
        pageTransitionActive: false,
      }),
    ).toEqual({ mode: "pinch", cancelPageDrag: true });
    expect(
      readerTouchStartIntent({
        touchCount: 2,
        zoom: 1,
        pageDragActive: false,
        pageTransitionActive: true,
      }),
    ).toEqual({ mode: "wait", cancelPageDrag: false });
    expect(
      readerTouchStartIntent({
        touchCount: 1,
        zoom: 2,
        pageDragActive: false,
        pageTransitionActive: false,
      }),
    ).toEqual({ mode: "pan", cancelPageDrag: false });
    expect(
      readerTouchStartIntent({
        touchCount: 1,
        zoom: 1,
        pageDragActive: false,
        pageTransitionActive: false,
      }),
    ).toEqual({ mode: "page", cancelPageDrag: false });
  });
});

describe("ReaderDoubleTapGesture", () => {
  it("accepts two nearby taps and rejects a drag or late second tap", () => {
    const gesture = new ReaderDoubleTapGesture();

    gesture.start({ x: 200, y: 240 }, 0);
    expect(gesture.finish({ x: 202, y: 241 }, 80)).toBe(false);
    gesture.start({ x: 204, y: 242 }, 180);
    expect(gesture.finish({ x: 204, y: 242 }, 240)).toBe(true);

    gesture.start({ x: 200, y: 240 }, 500);
    gesture.move({ x: 240, y: 240 });
    expect(gesture.finish({ x: 240, y: 240 }, 560)).toBe(false);
    gesture.start({ x: 200, y: 240 }, 700);
    expect(gesture.finish({ x: 200, y: 240 }, 780)).toBe(false);
    gesture.start({ x: 200, y: 240 }, 1_200);
    expect(gesture.finish({ x: 200, y: 240 }, 1_260)).toBe(false);

    const missedMoveEvent = new ReaderDoubleTapGesture();
    missedMoveEvent.start({ x: 0, y: 0 }, 0);
    expect(missedMoveEvent.finish({ x: 30, y: 0 }, 50)).toBe(false);
    missedMoveEvent.start({ x: 30, y: 0 }, 100);
    expect(missedMoveEvent.finish({ x: 30, y: 0 }, 150)).toBe(false);
  });
});

describe("readerKeyboardZoomIntent", () => {
  it("maps primary-modifier shortcuts outside editable controls", () => {
    expect(
      readerKeyboardZoomIntent({
        key: "=",
        ctrlKey: true,
        metaKey: false,
        editable: false,
      }),
    ).toBe("in");
    expect(
      readerKeyboardZoomIntent({
        key: "-",
        ctrlKey: false,
        metaKey: true,
        editable: false,
      }),
    ).toBe("out");
    expect(
      readerKeyboardZoomIntent({
        key: "0",
        ctrlKey: true,
        metaKey: false,
        editable: false,
      }),
    ).toBe("fit");
    expect(
      readerKeyboardZoomIntent({
        key: "+",
        ctrlKey: true,
        metaKey: false,
        editable: true,
      }),
    ).toBeNull();
    expect(
      readerKeyboardZoomIntent({
        key: "+",
        ctrlKey: false,
        metaKey: false,
        editable: false,
      }),
    ).toBeNull();
  });
});
