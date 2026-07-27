export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface ReaderTransform {
  zoom: number;
  panX: number;
  panY: number;
}

interface ReaderViewportOptions {
  viewport: ViewportSize;
  page: ViewportSize;
}

interface ReaderWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: 0 | 1 | 2;
  ctrlKey: boolean;
  pageTransitionActive: boolean;
  focalPoint: ViewportPoint;
}

export interface ReaderWheelResult {
  consumed: boolean;
  changed: boolean;
}

interface ReaderTouchStart {
  touchCount: number;
  zoom: number;
  pageDragActive: boolean;
  pageTransitionActive: boolean;
}

interface ReaderKeyboardInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  editable: boolean;
}

export type ReaderKeyboardZoomIntent = "fit" | "in" | "out";

export interface ReaderTouchIntent {
  mode: "page" | "pan" | "pinch" | "wait";
  cancelPageDrag: boolean;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const WHEEL_LINE_PIXELS = 16;
const TAP_MOVE_TOLERANCE = 8;
const TAP_DURATION_LIMIT = 250;
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 24;

export const fitPageWithin = (
  available: ViewportSize,
  pageAspect: ViewportSize,
): ViewportSize => {
  const availableWidth = Math.max(1, available.width);
  const availableHeight = Math.max(1, available.height);
  const aspect =
    pageAspect.width > 0 && pageAspect.height > 0
      ? pageAspect.width / pageAspect.height
      : 1;
  if (availableWidth / availableHeight <= aspect) {
    return {
      width: availableWidth,
      height: availableWidth / aspect,
    };
  }
  return {
    width: availableHeight * aspect,
    height: availableHeight,
  };
};

export const readerTouchStartIntent = (
  input: ReaderTouchStart,
): ReaderTouchIntent => {
  if (input.pageTransitionActive) {
    return { mode: "wait", cancelPageDrag: false };
  }
  if (input.touchCount >= 2) {
    return {
      mode: "pinch",
      cancelPageDrag: input.pageDragActive,
    };
  }
  return {
    mode: input.zoom > MIN_ZOOM ? "pan" : "page",
    cancelPageDrag: false,
  };
};

export const readerKeyboardZoomIntent = (
  input: ReaderKeyboardInput,
): ReaderKeyboardZoomIntent | null => {
  if (input.editable || (!input.ctrlKey && !input.metaKey)) {
    return null;
  }
  if (input.key === "+" || input.key === "=") {
    return "in";
  }
  if (input.key === "-" || input.key === "_") {
    return "out";
  }
  return input.key === "0" ? "fit" : null;
};

interface TimedPoint extends ViewportPoint {
  time: number;
}

export class ReaderDoubleTapGesture {
  private activeTap: TimedPoint | null = null;
  private previousTap: TimedPoint | null = null;

  start(point: ViewportPoint, time: number): void {
    this.activeTap = { ...point, time };
  }

  move(point: ViewportPoint): void {
    if (
      this.activeTap &&
      Math.hypot(point.x - this.activeTap.x, point.y - this.activeTap.y) >
        TAP_MOVE_TOLERANCE
    ) {
      this.activeTap = null;
      this.previousTap = null;
    }
  }

  finish(point: ViewportPoint, time: number): boolean {
    const activeTap = this.activeTap;
    this.activeTap = null;
    if (
      !activeTap ||
      time - activeTap.time > TAP_DURATION_LIMIT ||
      Math.hypot(point.x - activeTap.x, point.y - activeTap.y) >
        TAP_MOVE_TOLERANCE
    ) {
      this.previousTap = null;
      return false;
    }
    const previousTap = this.previousTap;
    const completedTap = { ...point, time };
    if (
      previousTap &&
      time - previousTap.time <= DOUBLE_TAP_DELAY &&
      Math.hypot(point.x - previousTap.x, point.y - previousTap.y) <=
        DOUBLE_TAP_DISTANCE
    ) {
      this.previousTap = null;
      return true;
    }
    this.previousTap = completedTap;
    return false;
  }

  cancel(): void {
    this.activeTap = null;
    this.previousTap = null;
  }
}

export class ReaderViewportTransform {
  private viewport: ViewportSize;
  private page: ViewportSize;
  private state: ReaderTransform = {
    zoom: MIN_ZOOM,
    panX: 0,
    panY: 0,
  };

  constructor(options: ReaderViewportOptions) {
    this.viewport = options.viewport;
    this.page = options.page;
  }

  get snapshot(): ReaderTransform {
    return { ...this.state };
  }

  get canZoomIn(): boolean {
    return this.state.zoom < MAX_ZOOM;
  }

  get canZoomOut(): boolean {
    return this.state.zoom > MIN_ZOOM;
  }

  pagePointAt(point: ViewportPoint): ViewportPoint {
    const centred = this.centrePoint(point);
    return {
      x: (centred.x - this.state.panX) / this.state.zoom,
      y: (centred.y - this.state.panY) / this.state.zoom,
    };
  }

  zoomAt(nextZoom: number, focalPoint: ViewportPoint): boolean {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    if (zoom === this.state.zoom) {
      return false;
    }
    const pagePoint = this.pagePointAt(focalPoint);
    const focal = this.centrePoint(focalPoint);
    this.state = this.clamp({
      zoom,
      panX: focal.x - pagePoint.x * zoom,
      panY: focal.y - pagePoint.y * zoom,
    });
    return true;
  }

  panBy(deltaX: number, deltaY: number): boolean {
    const next = this.clamp({
      ...this.state,
      panX: this.state.panX + deltaX,
      panY: this.state.panY + deltaY,
    });
    if (next.panX === this.state.panX && next.panY === this.state.panY) {
      return false;
    }
    this.state = next;
    return true;
  }

  resize(options: ReaderViewportOptions): boolean {
    this.viewport = options.viewport;
    this.page = options.page;
    const next = this.clamp(this.state);
    if (next.panX === this.state.panX && next.panY === this.state.panY) {
      return false;
    }
    this.state = next;
    return true;
  }

  stepZoom(direction: -1 | 1): boolean {
    const nextZoom =
      Math.round((this.state.zoom + direction * 0.25) * 100) / 100;
    return this.zoomAt(nextZoom, {
      x: this.viewport.width / 2,
      y: this.viewport.height / 2,
    });
  }

  settlePinch(): boolean {
    return this.state.zoom <= 1.05 ? this.reset() : false;
  }

  reset(): boolean {
    if (
      this.state.zoom === MIN_ZOOM &&
      this.state.panX === 0 &&
      this.state.panY === 0
    ) {
      return false;
    }
    this.state = { zoom: MIN_ZOOM, panX: 0, panY: 0 };
    return true;
  }

  applyWheel(input: ReaderWheelInput): ReaderWheelResult {
    if (input.pageTransitionActive) {
      return { consumed: input.ctrlKey, changed: false };
    }
    const deltaX = this.normalizedWheelDelta(
      input.deltaX,
      input.deltaMode,
      this.viewport.width,
    );
    const deltaY = this.normalizedWheelDelta(
      input.deltaY,
      input.deltaMode,
      this.viewport.height,
    );
    if (input.ctrlKey) {
      const boundedDeltaY = Math.max(-100, Math.min(100, deltaY));
      return {
        consumed: true,
        changed: this.zoomAt(
          this.state.zoom * Math.exp(-boundedDeltaY * 0.002),
          input.focalPoint,
        ),
      };
    }
    if (this.state.zoom === MIN_ZOOM) {
      return { consumed: false, changed: false };
    }
    const changed = this.panBy(-deltaX, -deltaY);
    return {
      consumed: changed,
      changed,
    };
  }

  toggleZoom(focalPoint: ViewportPoint): boolean {
    return this.state.zoom === MIN_ZOOM
      ? this.zoomAt(2, focalPoint)
      : this.reset();
  }

  private centrePoint(point: ViewportPoint): ViewportPoint {
    return {
      x: point.x - this.viewport.width / 2,
      y: point.y - this.viewport.height / 2,
    };
  }

  private clamp(state: ReaderTransform): ReaderTransform {
    const maxPanX = Math.max(
      0,
      (this.page.width * state.zoom - this.viewport.width) / 2,
    );
    const maxPanY = Math.max(
      0,
      (this.page.height * state.zoom - this.viewport.height) / 2,
    );
    return {
      zoom: state.zoom,
      panX:
        maxPanX === 0 ? 0 : Math.max(-maxPanX, Math.min(maxPanX, state.panX)),
      panY:
        maxPanY === 0 ? 0 : Math.max(-maxPanY, Math.min(maxPanY, state.panY)),
    };
  }

  private normalizedWheelDelta(
    delta: number,
    mode: ReaderWheelInput["deltaMode"],
    pagePixels: number,
  ): number {
    switch (mode) {
      case 1:
        return delta * WHEEL_LINE_PIXELS;
      case 2:
        return delta * pagePixels;
      default:
        return delta;
    }
  }
}
