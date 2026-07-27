export type PageDirection = "previous" | "next";

export interface PageTransition {
  direction: PageDirection;
  trackPercent: 0 | -200;
}

export type PageTransitionCommitDecision = "wait" | "abort" | "commit";

export const pageTransitionCommitDecision = ({
  animationComplete,
  incomingState,
}: {
  animationComplete: boolean;
  incomingState: "loading" | "error" | "ready";
}): PageTransitionCommitDecision => {
  if (!animationComplete || incomingState === "loading") {
    return "wait";
  }
  return incomingState === "error" ? "abort" : "commit";
};

export const reducedMotionRequested = (
  platformPreference: boolean,
  obsidianAnimationDuration: string,
): boolean =>
  platformPreference ||
  /^0+(?:\.0+)?(?:ms|s)?$/i.test(obsidianAnimationDuration.trim());

export const navigationTarget = (
  currentPage: number,
  transitionTarget: number | null,
  delta: -1 | 1,
  pageCount: number,
): number =>
  Math.max(1, Math.min(pageCount, (transitionTarget ?? currentPage) + delta));

export const pageTransition = (
  currentPage: number,
  targetPage: number,
  rtl: boolean,
): PageTransition | null => {
  if (targetPage === currentPage) {
    return null;
  }
  const direction: PageDirection =
    targetPage > currentPage ? "next" : "previous";
  const movesRight = direction === "next" ? rtl : !rtl;
  return {
    direction,
    trackPercent: movesRight ? 0 : -200,
  };
};

export const admittedPageTransition = (
  currentPage: number,
  targetPage: number,
  rtl: boolean,
  admitTarget: (pageNumber: number) => boolean,
): PageTransition | null => {
  const transition = pageTransition(currentPage, targetPage, rtl);
  return transition && admitTarget(targetPage) ? transition : null;
};

export const pageTransitionRenderTarget = (
  currentPage: number,
  transitionTarget: number | null,
): number => transitionTarget ?? currentPage;

interface SwipePoint {
  x: number;
  y: number;
  time: number;
}

interface PagerSwipeGestureOptions {
  start: SwipePoint;
  viewportWidth: number;
  currentPage: number;
  pageCount: number;
  rtl: boolean;
}

export interface SwipeMove {
  axis: "pending" | "horizontal" | "vertical";
  offset: number;
}

export type SwipeFinish =
  | { action: PageDirection; offset: number }
  | { action: "snap-back"; offset: number };

const AXIS_LOCK_DISTANCE = 8;
const DISTANCE_THRESHOLD = 0.35;
const FLICK_VELOCITY = 0.6;
const FLICK_MIN_DISTANCE = 24;
const RELEASE_SAMPLE_WINDOW = 80;
const EDGE_RESISTANCE = 0.32;

export class PagerSwipeGesture {
  private readonly start: SwipePoint;
  private readonly viewportWidth: number;
  private readonly currentPage: number;
  private readonly pageCount: number;
  private readonly rtl: boolean;
  private axis: SwipeMove["axis"] = "pending";
  private previousPoint: SwipePoint;
  private lastPoint: SwipePoint;

  constructor(options: PagerSwipeGestureOptions) {
    this.start = options.start;
    this.viewportWidth = Math.max(1, options.viewportWidth);
    this.currentPage = options.currentPage;
    this.pageCount = options.pageCount;
    this.rtl = options.rtl;
    this.previousPoint = options.start;
    this.lastPoint = options.start;
  }

  move(point: SwipePoint): SwipeMove {
    const movement = this.movementAt(point);
    if (point.time >= this.lastPoint.time) {
      this.previousPoint = this.lastPoint;
      this.lastPoint = point;
    }
    return movement;
  }

  finish(point: SwipePoint): SwipeFinish {
    const movement = this.movementAt(point);
    if (movement.axis !== "horizontal") {
      return {
        action: "snap-back",
        offset: movement.offset,
      };
    }

    const deltaX = point.x - this.start.x;
    const direction = this.direction(deltaX);
    const canComplete =
      (direction === "previous" && this.currentPage > 1) ||
      (direction === "next" && this.currentPage < this.pageCount);
    const distance = Math.abs(deltaX);
    const crossedDistance = distance >= this.viewportWidth * DISTANCE_THRESHOLD;
    const isFlick =
      distance >= FLICK_MIN_DISTANCE &&
      this.releaseVelocity(point) >= FLICK_VELOCITY;

    return canComplete && (crossedDistance || isFlick)
      ? { action: direction, offset: movement.offset }
      : { action: "snap-back", offset: movement.offset };
  }

  private movementAt(point: SwipePoint): SwipeMove {
    const deltaX = point.x - this.start.x;
    const deltaY = point.y - this.start.y;

    if (
      this.axis === "pending" &&
      Math.hypot(deltaX, deltaY) >= AXIS_LOCK_DISTANCE
    ) {
      this.axis =
        Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
    }

    if (this.axis !== "horizontal") {
      return {
        axis: this.axis,
        offset: 0,
      };
    }

    const direction = this.direction(deltaX);
    const atEdge =
      (direction === "previous" && this.currentPage === 1) ||
      (direction === "next" && this.currentPage === this.pageCount);
    return {
      axis: "horizontal",
      offset: atEdge ? deltaX * EDGE_RESISTANCE : deltaX,
    };
  }

  private releaseVelocity(point: SwipePoint): number {
    if (point.time - this.lastPoint.time > RELEASE_SAMPLE_WINDOW) {
      return 0;
    }
    if (point.time > this.lastPoint.time && point.x !== this.lastPoint.x) {
      return (
        Math.abs(point.x - this.lastPoint.x) /
        (point.time - this.lastPoint.time)
      );
    }
    if (this.lastPoint.time > this.previousPoint.time) {
      return (
        Math.abs(this.lastPoint.x - this.previousPoint.x) /
        (this.lastPoint.time - this.previousPoint.time)
      );
    }
    return (
      Math.abs(point.x - this.start.x) /
      Math.max(1, point.time - this.start.time)
    );
  }

  private direction(deltaX: number): PageDirection {
    const logicalDelta = this.rtl ? -deltaX : deltaX;
    return logicalDelta < 0 ? "next" : "previous";
  }
}
