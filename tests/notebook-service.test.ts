import { describe, expect, it, vi } from "vitest";

import {
  isNotebookRenderCancelledError,
  NotebookService,
  type NotebookDescriptor,
} from "../src/note/notebook-service";
import type {
  NotebookWorkerRequest,
  NotebookWorkerResponse,
} from "../src/note/notebook-worker-protocol";

const descriptor: NotebookDescriptor = {
  path: "supernote/Journal.note",
  revision: "mtime:1",
  pageCount: 2,
  devicePage: 2,
  pages: [
    {
      pageNumber: 1,
      fingerprint: "page-one",
      recognitionText: null,
      recognitionSpans: [],
    },
    {
      pageNumber: 2,
      fingerprint: "page-two",
      recognitionText: "Recognized",
      recognitionSpans: [],
    },
  ],
  textBoxes: [],
};

class ScriptedWorker {
  onmessage: ((event: MessageEvent<NotebookWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly requests: NotebookWorkerRequest[] = [];
  autoRender = false;
  pagePixelBytes = 20;
  pageWidth = 5;
  pageHeight = 1;
  descriptorMetadataBytes = 0;
  descriptorOverride: NotebookDescriptor | null = null;
  bitmap: ImageBitmap = {
    width: 1,
    height: 1,
    close: vi.fn(),
  } as unknown as ImageBitmap;

  postMessage(request: NotebookWorkerRequest): void {
    this.requests.push(request);
    if (request.type === "open") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: "opened",
            id: request.id,
            sessionId: request.sessionId,
            generation: request.generation,
            pagePixelBytes: this.pagePixelBytes,
            pageWidth: this.pageWidth,
            pageHeight: this.pageHeight,
            parsedMetadataBytes: 0,
            descriptorMetadataBytes: this.descriptorMetadataBytes,
            descriptor: {
              ...(this.descriptorOverride ?? descriptor),
              path: request.path,
              revision: request.revision,
            },
          },
        } as MessageEvent<NotebookWorkerResponse>);
      });
    } else if (request.type === "render" && this.autoRender) {
      queueMicrotask(() => {
        if (request.output === "png") {
          this.onmessage?.({
            data: {
              type: "rendered",
              id: request.id,
              sessionId: request.sessionId,
              generation: request.generation,
              output: "png",
              page: {
                png: new Uint8Array([1, 2, 3]),
                width: this.pageWidth,
                height: this.pageHeight,
              },
            },
          } as MessageEvent<NotebookWorkerResponse>);
          return;
        }
        this.onmessage?.({
          data: {
            type: "rendered",
            id: request.id,
            sessionId: request.sessionId,
            generation: request.generation,
            output: "bitmap",
            bitmap: this.bitmap,
          },
        } as MessageEvent<NotebookWorkerResponse>);
      });
    }
  }

  respondBitmap(
    request: Extract<NotebookWorkerRequest, { type: "render" }>,
    bitmap = this.bitmap,
  ): void {
    this.onmessage?.({
      data: {
        type: "rendered",
        id: request.id,
        sessionId: request.sessionId,
        generation: request.generation,
        output: "bitmap",
        bitmap,
      },
    } as MessageEvent<NotebookWorkerResponse>);
  }

  respondError(
    request: Extract<NotebookWorkerRequest, { type: "render" }>,
    message = "Supernote render cancelled",
  ): void {
    this.onmessage?.({
      data: {
        type: "error",
        id: request.id,
        sessionId: request.sessionId,
        generation: request.generation,
        message,
      },
    } as MessageEvent<NotebookWorkerResponse>);
  }

  terminate(): void {}
}

describe("NotebookService", () => {
  it("shares one worker session until the final source lease closes", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const load = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const source = {
      path: descriptor.path,
      revision: descriptor.revision,
      load,
    };

    const [first, second] = await Promise.all([
      service.open(source),
      service.open(source),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(
      worker.requests.filter((request) => request.type === "open"),
    ).toHaveLength(1);
    expect(first.descriptor).toEqual(second.descriptor);
    const retained = first.retain();
    expect(service.snapshot()).toMatchObject({
      activeSessions: 1,
      activeLeases: 3,
      retainedSourceBytes: 3,
      sessionOpens: 1,
      sourceCopies: 0,
      transferredSourceBytes: 3,
    });

    first.close();
    expect(
      worker.requests.filter((request) => request.type === "close"),
    ).toHaveLength(0);

    second.close();
    expect(
      worker.requests.filter((request) => request.type === "close"),
    ).toHaveLength(0);
    retained.close();
    expect(
      worker.requests.filter((request) => request.type === "close"),
    ).toHaveLength(1);
    expect(service.snapshot()).toMatchObject({
      activeSessions: 0,
      activeLeases: 0,
      retainedSourceBytes: 0,
    });
  });

  it("abandons a pending source open when its final caller aborts", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    let finishLoad!: (bytes: Uint8Array) => void;
    const load = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const abort = new AbortController();
    const opening = service.open(
      {
        path: descriptor.path,
        revision: descriptor.revision,
        load,
      },
      { signal: abort.signal },
    );

    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    abort.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(service.snapshot()).toMatchObject({
      activeSessions: 0,
      activeLeases: 0,
      retainedBytes: 0,
    });

    finishLoad(new Uint8Array([1, 2, 3]));
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(
      worker.requests.filter((request) => request.type === "open"),
    ).toHaveLength(0);
  });

  it("keeps a shared pending source open alive for its remaining caller", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    let finishLoad!: (bytes: Uint8Array) => void;
    const load = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const source = {
      path: descriptor.path,
      revision: descriptor.revision,
      load,
    };
    const abort = new AbortController();
    const cancelled = service.open(source, { signal: abort.signal });
    const remaining = service.open(source);

    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    finishLoad(new Uint8Array([1, 2, 3]));
    const lease = await remaining;

    expect(
      worker.requests.filter((request) => request.type === "open"),
    ).toHaveLength(1);
    expect(service.snapshot()).toMatchObject({
      activeSessions: 1,
      activeLeases: 1,
      sessionOpens: 1,
    });
    lease.close();
  });

  it("keeps displayed and alternate revisions of one path independent", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const first = await service.open({
      path: descriptor.path,
      revision: "mtime:1",
      bytes: new Uint8Array([1]),
    });
    (await first.bitmap(1)).release();

    const second = await service.open({
      path: descriptor.path,
      revision: "mtime:2",
      bytes: new Uint8Array([2]),
    });

    await expect(first.renderPng(1)).resolves.toMatchObject({
      width: worker.pageWidth,
      height: worker.pageHeight,
    });
    expect(first.descriptor.revision).toBe("mtime:1");
    expect(second.descriptor.revision).toBe("mtime:2");
    expect(worker.requests.map((request) => request.type)).toEqual([
      "open",
      "render",
      "open",
      "render",
    ]);
    expect(service.snapshot()).toMatchObject({
      activeSessions: 2,
      activeLeases: 2,
    });

    first.close();
    second.close();
  });

  it("keeps a retained reader action alive across a revision handoff", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const displayed = await service.open({
      path: descriptor.path,
      revision: "mtime:1",
      bytes: new Uint8Array([1]),
    });
    const action = displayed.retain();
    displayed.close();

    const replacement = await service.open({
      path: descriptor.path,
      revision: "mtime:2",
      bytes: new Uint8Array([2]),
    });

    await expect(action.renderPng(1)).resolves.toMatchObject({
      width: worker.pageWidth,
      height: worker.pageHeight,
    });
    action.close();
    replacement.close();
  });

  it("keeps in-flight work valid when another revision opens", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const first = await service.open({
      path: descriptor.path,
      revision: "mtime:1",
      bytes: new Uint8Array([1]),
    });
    first.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    const staleRender = first.bitmap(1);
    const second = await service.open({
      path: descriptor.path,
      revision: "mtime:2",
      bytes: new Uint8Array([2]),
    });

    const stale = await staleRender;
    expect(stale.bitmap).toBe(worker.bitmap);
    expect(worker.bitmap.close).not.toHaveBeenCalled();
    first.close();
    expect(worker.bitmap.close).not.toHaveBeenCalled();
    stale.release();
    expect(worker.bitmap.close).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("surfaces worker startup failure without a main-thread fallback", async () => {
    const notifyRenderingUnavailable = vi.fn();
    const service = new NotebookService({
      createWorker: () => {
        throw new Error("Workers are blocked");
      },
      notifyRenderingUnavailable,
    });

    const source = {
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    };
    await expect(service.open(source)).rejects.toThrow(
      "Supernote notebook worker is unavailable: Workers are blocked",
    );
    await expect(service.open(source)).rejects.toThrow(
      "Supernote notebook worker is unavailable: Workers are blocked",
    );
    expect(notifyRenderingUnavailable).toHaveBeenCalledOnce();
    expect(notifyRenderingUnavailable).toHaveBeenCalledWith(
      "Supernote rendering is unavailable. Reload Obsidian to recover.",
    );
    expect(service.snapshot()).toMatchObject({
      activeSessions: 0,
      activeLeases: 0,
      sessionOpens: 0,
    });
  });

  it("fails closed after a fatal worker error and reports reload recovery once", async () => {
    const worker = new ScriptedWorker();
    const notifyRenderingUnavailable = vi.fn();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      notifyRenderingUnavailable,
    });
    const source = {
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const lease = await service.open(source);

    worker.onerror?.({
      message: "Worker crashed",
    } as ErrorEvent);

    expect(notifyRenderingUnavailable).toHaveBeenCalledOnce();
    expect(
      lease.updateView({
        visible: false,
        currentPage: null,
        gridOpen: false,
        canvasBytes: 0,
      }),
    ).toMatchObject({
      admitted: false,
      reason: "unavailable",
    });
    expect(() => lease.close()).not.toThrow();
    await expect(service.open(source)).rejects.toThrow(
      "Supernote notebook worker is unavailable: Worker crashed",
    );
    expect(notifyRenderingUnavailable).toHaveBeenCalledOnce();
  });

  it("rejects a larger canvas allocation without changing the admitted view", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 20,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(
      lease.updateView({
        visible: true,
        currentPage: 1,
        gridOpen: false,
        canvasBytes: 4,
      }),
    ).toEqual({ admitted: true });
    expect(service.snapshot().retainedCanvasBytes).toBe(4);

    expect(
      lease.updateView({
        visible: true,
        currentPage: 2,
        gridOpen: false,
        canvasBytes: 18,
      }),
    ).toMatchObject({
      admitted: false,
      reason: "resource-budget",
    });
    expect(service.snapshot()).toMatchObject({
      retainedCanvasBytes: 4,
      retainedBytes: 7,
    });

    lease.close();
  });

  it("shares display resources and releases them with the final lease", async () => {
    const bitmap = {
      width: 1,
      height: 1,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    worker.bitmap = bitmap;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });

    const first = await lease.bitmap(1);
    const second = await lease.bitmap(1);

    expect(first).not.toBe(second);
    expect(first.bitmap).toBe(second.bitmap);
    expect(
      worker.requests.filter((request) => request.type === "render"),
    ).toHaveLength(1);

    first.release();
    second.release();
    lease.close();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a cache-hit display bitmap open until its consumer releases it", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const source = {
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const reader = await service.open(source);
    const second = await service.open(source);
    reader.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    const rendered = await reader.bitmap(1);
    rendered.release();
    const borrowed = await second.bitmap(1);
    reader.close();

    expect(worker.bitmap.close).not.toHaveBeenCalled();
    borrowed.release();
    borrowed.release();
    expect(worker.bitmap.close).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("keeps a cache-hit thumbnail open until its consumer releases it", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const source = {
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const grid = await service.open(source);
    const second = await service.open(source);
    grid.updateView({
      visible: true,
      currentPage: null,
      gridOpen: true,
    });

    const rendered = await grid.thumbnailBitmap(1);
    rendered.release();
    const borrowed = await second.thumbnailBitmap(1);
    grid.close();

    expect(worker.bitmap.close).not.toHaveBeenCalled();
    borrowed.release();
    expect(worker.bitmap.close).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("gives joined in-flight consumers independent bitmap handles", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });

    const firstPending = lease.bitmap(1);
    const secondPending = lease.bitmap(1);
    const request = worker.requests.find(
      (
        candidate,
      ): candidate is Extract<NotebookWorkerRequest, { type: "render" }> =>
        candidate.type === "render",
    )!;
    worker.respondBitmap(request);
    lease.close();

    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first).not.toBe(second);
    expect(first.bitmap).toBe(second.bitmap);
    expect(worker.bitmap.close).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({
      activeSessions: 0,
      activeLeases: 0,
      retainedBitmapBytes: 4,
      pinnedBitmapBytes: 4,
      retainedBytes: 4,
      sessions: [
        {
          path: descriptor.path,
          sourceBytes: 0,
          parsedBytes: 0,
          canvasBytes: 0,
          bitmapBytes: 4,
          inFlightBytes: 0,
          retainedBytes: 4,
        },
      ],
    });

    first.release();
    expect(worker.bitmap.close).not.toHaveBeenCalled();
    second.release();
    expect(worker.bitmap.close).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({
      activeSessions: 0,
      activeLeases: 0,
      retainedSourceBytes: 0,
      retainedBitmapBytes: 0,
      inFlightBytes: 0,
      retainedBytes: 0,
    });
  });

  it("prioritizes the visible page and bounds worker concurrency", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      maxConcurrentRenders: 1,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: true,
    });

    const thumbnail = lease.thumbnailBitmap(2);
    const adjacent = lease.bitmap(2);
    const current = lease.bitmap(1);
    expect(
      worker.requests.filter((request) => request.type === "render"),
    ).toHaveLength(1);

    const first = worker.requests.find(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )!;
    worker.respondBitmap(first);
    (await thumbnail).release();
    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(2);
    });
    const second = worker.requests.filter(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )[1]!;
    expect(second.pageNumber).toBe(1);
    worker.respondBitmap(second);
    (await current).release();

    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(3);
    });
    const third = worker.requests.filter(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )[2]!;
    expect(third.pageNumber).toBe(2);
    worker.respondBitmap(third);
    (await adjacent).release();

    expect(service.snapshot()).toMatchObject({
      inFlightRenders: 0,
      maxObservedInFlightRenders: 1,
      queuedRenders: 0,
    });
    lease.close();
  });

  it("prioritizes a scaled current-page render ahead of queued background work", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      maxConcurrentRenders: 1,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    const first = lease.bitmap(1);
    const background = lease.bitmap(2);
    lease.updateView({
      visible: true,
      currentPage: 2,
      gridOpen: false,
    });
    const scaledCurrent = lease.thumbnailBitmap(2, 5, "display");
    const firstRequest = worker.requests.find(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )!;
    worker.respondBitmap(firstRequest);
    (await first).release();

    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(2);
    });
    const secondRequest = worker.requests.filter(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )[1]!;
    expect(secondRequest).toMatchObject({
      pageNumber: 2,
      maxWidth: 5,
    });
    worker.respondBitmap(secondRequest);
    (await scaledCurrent).release();

    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(3);
    });
    const thirdRequest = worker.requests.filter(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )[2]!;
    worker.respondBitmap(thirdRequest);
    (await background).release();
    lease.close();
  });

  it("cancels a bitmap render when its final waiter aborts", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const abort = new AbortController();
    const rendered = lease.thumbnailBitmap(1, 5, "display", abort.signal);

    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(1);
    });
    abort.abort();

    await expect(rendered).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests.at(-1)).toMatchObject({ type: "cancel" });
    expect(service.snapshot().cancelledRenders).toBe(1);
    lease.close();
  });

  it("keeps a shared bitmap render alive while another waiter remains", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const abort = new AbortController();
    const cancelled = lease.thumbnailBitmap(1, 5, "display", abort.signal);
    const remaining = lease.thumbnailBitmap(1, 5, "display");

    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(1);
    });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(
      worker.requests.filter((request) => request.type === "cancel"),
    ).toHaveLength(0);

    const request = worker.requests.find(
      (
        candidate,
      ): candidate is Extract<NotebookWorkerRequest, { type: "render" }> =>
        candidate.type === "render",
    )!;
    worker.respondBitmap(request);
    (await remaining).release();
    lease.close();
  });

  it("cancels queued grid work and releases its thumbnails when the grid closes", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      maxConcurrentRenders: 1,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: null,
      gridOpen: true,
    });

    const first = lease.thumbnailBitmap(1);
    const queued = lease.thumbnailBitmap(2);
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    const cancellation = await Promise.all([first, queued]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isNotebookRenderCancelledError(cancellation)).toBe(true);
    expect(service.snapshot()).toMatchObject({
      cancelledRenders: 2,
      inFlightBytes: 40,
      queuedRenders: 0,
      sessions: [
        expect.objectContaining({
          path: descriptor.path,
          inFlightBytes: 40,
        }),
      ],
    });
    expect(worker.requests).toContainEqual({
      type: "cancel",
      id: expect.any(Number),
      sessionId: expect.any(Number),
      generation: expect.any(Number),
    });
    const request = worker.requests.find(
      (
        candidate,
      ): candidate is Extract<NotebookWorkerRequest, { type: "render" }> =>
        candidate.type === "render",
    )!;
    worker.respondBitmap(request);
    expect(worker.bitmap.close).toHaveBeenCalledTimes(1);
    expect(service.snapshot().inFlightBytes).toBe(0);
    lease.close();
  });

  it("evicts and reloads hidden worker sources to enforce the global budget", async () => {
    const worker = new ScriptedWorker();
    worker.descriptorMetadataBytes = 2;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 24,
    });
    const loadFirst = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const loadSecond = vi.fn(async () => new Uint8Array([5, 6, 7, 8]));
    const firstSource = {
      path: "supernote/First.note",
      revision: "mtime:1",
      load: loadFirst,
    };
    const secondSource = {
      path: "supernote/Second.note",
      revision: "mtime:1",
      load: loadSecond,
    };

    const first = await service.open(firstSource);
    const second = await service.open(secondSource);

    expect(service.snapshot()).toMatchObject({
      activeSessions: 2,
      retainedSourceBytes: 4,
      retainedParsedBytes: 4,
      retainedBytes: 8,
      sessions: [
        expect.objectContaining({ path: firstSource.path, parsedBytes: 2 }),
        expect.objectContaining({ path: secondSource.path, parsedBytes: 2 }),
      ],
    });
    expect(
      worker.requests.filter((request) => request.type === "close"),
    ).toHaveLength(1);

    const sharedFirst = await service.open(firstSource);
    expect(loadFirst).toHaveBeenCalledTimes(2);
    expect(loadSecond).toHaveBeenCalledTimes(1);
    expect(service.snapshot().retainedBytes).toBeLessThanOrEqual(24);
    expect(
      worker.requests.filter((request) => request.type === "open"),
    ).toHaveLength(3);

    sharedFirst.close();
    first.close();
    second.close();
  });

  it("reclaims a visible reloadable source for bounded notebook inspection", async () => {
    const worker = new ScriptedWorker();
    worker.descriptorMetadataBytes = 2;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 24,
      transientResourceBudgetBytes: 32,
    });
    const loadVisible = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const visibleSource = {
      path: "supernote/Visible.note",
      revision: "mtime:1",
      load: loadVisible,
    };
    const visible = await service.open(visibleSource);
    visible.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    const inspection = await service.open(
      {
        path: "candidate:changed:supernote/Changed.note",
        revision: "changed",
        bytes: new Uint8Array([5, 6, 7, 8]),
        transfer: "copy",
      },
      { reclaim: "reloadable", budget: "transient" },
    );

    expect(service.snapshot()).toMatchObject({
      budgetBytes: 24,
      transientBudgetBytes: 32,
      retainedBytes: 12,
      sessions: [
        expect.objectContaining({
          path: visibleSource.path,
          sourceBytes: 4,
          parsedBytes: 2,
        }),
        expect.objectContaining({
          path: "candidate:changed:supernote/Changed.note",
          sourceBytes: 4,
          parsedBytes: 2,
        }),
      ],
    });
    expect(
      worker.requests.filter((request) => request.type === "close"),
    ).toHaveLength(0);

    inspection.close();
    const restored = await service.open(visibleSource);
    expect(loadVisible).toHaveBeenCalledTimes(1);
    restored.close();
    visible.close();
  });

  it("keeps transient notebook inspection within its separate ceiling", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 24,
      transientResourceBudgetBytes: 32,
    });

    await expect(
      service.open(
        {
          path: "candidate:oversized:supernote/Oversized.note",
          revision: "oversized",
          bytes: new Uint8Array(7),
          transfer: "copy",
        },
        { reclaim: "reloadable", budget: "transient" },
      ),
    ).rejects.toThrow("source exceeds the 32-byte resource budget");
    expect(service.snapshot().retainedBytes).toBe(0);
  });

  it("rejects a source that cannot fit inside the global resource budget", async () => {
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 3,
    });

    await expect(
      service.open({
        path: descriptor.path,
        revision: descriptor.revision,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    ).rejects.toThrow("source exceeds the 3-byte resource budget");
    expect(service.snapshot()).toMatchObject({
      activeSessions: 0,
      retainedSourceBytes: 0,
      retainedBytes: 0,
    });
    expect(worker.requests).toHaveLength(0);
  });

  it("reserves the bitmap-background decode peak", async () => {
    const worker = new ScriptedWorker();
    worker.descriptorOverride = {
      ...descriptor,
      pages: descriptor.pages.map((page) =>
        page.pageNumber === 1
          ? {
              ...page,
              hasBitmapBackground: true,
              bitmapBackgroundBytes: 5,
            }
          : page,
      ),
    };
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 88,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });

    const rendering = lease.bitmap(1);
    expect(service.snapshot().inFlightBytes).toBe(85);
    const request = worker.requests.find(
      (
        candidate,
      ): candidate is Extract<NotebookWorkerRequest, { type: "render" }> =>
        candidate.type === "render",
    )!;
    worker.respondBitmap(request);
    (await rendering).release();
    lease.close();
  });

  it("accounts mobile canvases and admits native PDF PNG export without duplicate bitmaps", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    worker.pageWidth = 1_920;
    worker.pageHeight = 2_560;
    worker.pagePixelBytes = 1_920 * 2_560 * 4;
    worker.descriptorOverride = {
      ...descriptor,
      pageCount: 3,
      pages: [
        ...descriptor.pages,
        {
          pageNumber: 3,
          fingerprint: "page-three",
          recognitionText: null,
          recognitionSpans: [],
        },
      ],
    };
    Object.defineProperty(worker, "bitmap", {
      get: () =>
        ({
          width: 1_920,
          height: 2_560,
          close: vi.fn(),
        }) as unknown as ImageBitmap,
    });
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 96 * 1_024 * 1_024,
      maxConcurrentRenders: 1,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: 2,
      gridOpen: false,
    });
    (await lease.bitmap(1)).release();
    (await lease.bitmap(2)).release();
    (await lease.bitmap(3)).release();
    expect(service.snapshot().pinnedBitmapBytes).toBe(3 * 19_660_800);
    await Promise.resolve();
    const mobileCanvasBytes = 3 * 960 * 1_280 * 4;
    lease.updateView({
      visible: true,
      currentPage: 2,
      gridOpen: false,
      canvasBytes: mobileCanvasBytes,
    });
    expect(service.snapshot()).toMatchObject({
      retainedCanvasBytes: mobileCanvasBytes,
      retainedBitmapBytes: 0,
      pinnedBitmapBytes: 0,
    });

    await expect(lease.renderPng(2, 1, "opaque-rgb")).resolves.toMatchObject({
      width: 1_920,
      height: 2_560,
    });
    expect(
      [...worker.requests]
        .reverse()
        .find(
          (request) => request.type === "render" && request.output === "png",
        ),
    ).toMatchObject({ encoding: "opaque-rgb" });
    expect(service.snapshot()).toMatchObject({
      retainedCanvasBytes: mobileCanvasBytes,
      retainedBitmapBytes: 0,
      pinnedBitmapBytes: 0,
    });
    lease.close();
  });

  it("evicts least-recently-used unpinned bitmaps to stay inside the byte budget", async () => {
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    let bitmapId = 0;
    Object.defineProperty(worker, "bitmap", {
      get: () =>
        ({
          id: ++bitmapId,
          width: 5,
          height: 2,
          close: vi.fn(),
        }) as unknown as ImageBitmap,
    });
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      resourceBudgetBytes: 163,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    (await lease.bitmap(1)).release();
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: true,
    });
    (await lease.thumbnailBitmap(1, 5)).release();
    (await lease.thumbnailBitmap(2, 5)).release();

    expect(service.snapshot()).toMatchObject({
      budgetBytes: 163,
      retainedSourceBytes: 3,
      retainedBitmapBytes: 120,
      retainedBytes: 123,
      evictedBitmaps: 0,
    });

    (await lease.thumbnailBitmap(1, 4)).release();
    const snapshot = service.snapshot();
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(163);
    expect(snapshot.evictedBitmaps).toBe(1);
    expect(snapshot.retainedBytes).toBe(
      snapshot.retainedSourceBytes +
        snapshot.retainedBitmapBytes +
        snapshot.inFlightBytes,
    );
    lease.close();
  });

  it("reuses one faithful display bitmap across presentation changes", async () => {
    const bitmap = {
      width: 5,
      height: 2,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    worker.bitmap = bitmap;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });
    (await lease.bitmap(1)).release();

    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });
    (await lease.bitmap(1)).release();

    expect(
      worker.requests.filter(
        (
          request,
        ): request is Extract<
          NotebookWorkerRequest,
          { type: "render"; output: "bitmap" }
        > => request.type === "render" && request.output === "bitmap",
      ),
    ).toHaveLength(1);
    expect(bitmap.close).not.toHaveBeenCalled();
    lease.close();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("reuses one faithful thumbnail bitmap across presentation changes", async () => {
    const bitmap = {
      width: 5,
      height: 2,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const worker = new ScriptedWorker();
    worker.autoRender = true;
    worker.bitmap = bitmap;
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: true,
    });
    (await lease.thumbnailBitmap(1)).release();

    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: true,
    });
    (await lease.thumbnailBitmap(1)).release();

    expect(
      worker.requests.filter((request) => request.type === "render"),
    ).toHaveLength(1);
    expect(bitmap.close).not.toHaveBeenCalled();
    expect(service.snapshot().retainedBitmapBytes).toBe(40);
    lease.close();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed bitmap alive until its consumer can draw it", async () => {
    const firstBitmap = {
      width: 5,
      height: 2,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const secondBitmap = {
      width: 5,
      height: 2,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const worker = new ScriptedWorker();
    const service = new NotebookService({
      createWorker: () => worker as unknown as Worker,
      maxConcurrentRenders: 1,
      resourceBudgetBytes: 80,
    });
    const lease = await service.open({
      path: descriptor.path,
      revision: descriptor.revision,
      bytes: new Uint8Array([1, 2, 3]),
    });
    lease.updateView({
      visible: true,
      currentPage: null,
      gridOpen: true,
    });

    const first = lease.thumbnailBitmap(1, 5);
    const second = lease.thumbnailBitmap(2, 5);
    const consumed = first.then((handle) => {
      expect(handle.bitmap).toBe(firstBitmap);
      expect(firstBitmap.close).not.toHaveBeenCalled();
      handle.release();
    });
    const firstRequest = worker.requests.find(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )!;
    worker.respondBitmap(firstRequest, firstBitmap);

    await consumed;
    await vi.waitFor(() => {
      expect(
        worker.requests.filter((request) => request.type === "render"),
      ).toHaveLength(2);
    });
    expect(firstBitmap.close).toHaveBeenCalledTimes(1);
    const secondRequest = worker.requests.filter(
      (
        request,
      ): request is Extract<NotebookWorkerRequest, { type: "render" }> =>
        request.type === "render",
    )[1]!;
    worker.respondBitmap(secondRequest, secondBitmap);
    (await second).release();
    lease.close();
  });
});
