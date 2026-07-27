type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

/**
 * Coalesces any number of per-run log signals into one paint per frame.
 */
export class RunLogPaintScheduler {
  private readonly pendingRunIds = new Set<string>();
  private frameHandle: number | null = null;

  constructor(
    private readonly requestFrame: RequestFrame,
    private readonly cancelFrame: CancelFrame,
    private readonly paint: (runIds: readonly string[]) => void,
  ) {}

  schedule(runId: string): void {
    this.pendingRunIds.add(runId);
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
    this.paintPending();
  }

  dispose(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.pendingRunIds.clear();
  }

  private readonly handleFrame = (): void => {
    this.frameHandle = null;
    this.paintPending();
  };

  private paintPending(): void {
    if (this.pendingRunIds.size === 0) {
      return;
    }
    const runIds = [...this.pendingRunIds];
    this.pendingRunIds.clear();
    this.paint(runIds);
  }
}
