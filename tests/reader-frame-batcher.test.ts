import { describe, expect, it } from "vitest";

import {
  ReaderFrameBatcher,
  type ReaderFrameWrites,
} from "../src/viewer/reader-frame-batcher";

describe("ReaderFrameBatcher", () => {
  it("commits only the latest transform for each surface in one frame", () => {
    let callback: FrameRequestCallback | null = null;
    let requests = 0;
    const commits: ReaderFrameWrites[] = [];
    const batcher = new ReaderFrameBatcher(
      (next) => {
        requests += 1;
        callback = next;
        return requests;
      },
      () => {},
      (writes) => commits.push(writes),
    );

    batcher.schedule({ track: { percent: -100, pixelOffset: 12 } });
    batcher.schedule({ track: { percent: -100, pixelOffset: 40 } });
    batcher.schedule({ canvas: { panX: 3, panY: 4, zoom: 2 } });

    expect(requests).toBe(1);
    expect(commits).toEqual([]);
    expect(callback).not.toBeNull();
    (callback as unknown as FrameRequestCallback)(0);
    expect(commits).toEqual([
      {
        track: { percent: -100, pixelOffset: 40 },
        canvas: { panX: 3, panY: 4, zoom: 2 },
      },
    ]);
  });

  it("can flush pending input before starting a transition", () => {
    const commits: ReaderFrameWrites[] = [];
    let cancelled = 0;
    const batcher = new ReaderFrameBatcher(
      () => 7,
      () => {
        cancelled += 1;
      },
      (writes) => commits.push(writes),
    );

    batcher.schedule({ track: { percent: -100, pixelOffset: -80 } });
    batcher.flush();

    expect(cancelled).toBe(1);
    expect(commits).toEqual([{ track: { percent: -100, pixelOffset: -80 } }]);
  });
});
