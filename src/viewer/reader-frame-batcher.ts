import type { ReaderTransform } from "./reader-viewport";

export interface TrackTransform {
  percent: number;
  pixelOffset: number;
}

export interface CanvasTransform extends ReaderTransform {
  animate?: boolean;
}

export interface ReaderFrameWrites {
  track?: TrackTransform;
  canvas?: CanvasTransform;
}

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

/**
 * Coalesces reader transforms into one callback per display frame.
 *
 * Gesture handlers only update logical state. The latest transform for each
 * surface wins, keeping DOM writes bounded even when input events arrive
 * faster than the display can paint.
 */
export class ReaderFrameBatcher {
  private frameHandle: number | null = null;
  private pending: ReaderFrameWrites = {};

  constructor(
    private readonly requestFrame: RequestFrame,
    private readonly cancelFrame: CancelFrame,
    private readonly commit: (writes: ReaderFrameWrites) => void,
  ) {}

  schedule(writes: ReaderFrameWrites): void {
    if (writes.track) {
      this.pending.track = writes.track;
    }
    if (writes.canvas) {
      this.pending.canvas = writes.canvas;
    }
    if (this.frameHandle !== null) {
      return;
    }
    this.frameHandle = this.requestFrame(this.handleFrame);
  }

  flush(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.commitPending();
  }

  private readonly handleFrame = (): void => {
    this.frameHandle = null;
    this.commitPending();
  };

  private commitPending(): void {
    if (!this.pending.track && !this.pending.canvas) {
      return;
    }
    const writes = this.pending;
    this.pending = {};
    this.commit(writes);
  }

  cancel(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.pending = {};
  }
}
