import { describe, expect, it, vi } from "vitest";

import { md5 } from "../src/shared/md5";
import {
  ChecksumService,
  type ChecksumWorkerPort,
} from "../src/sync/checksum-service";
import type {
  ChecksumWorkerRequest,
  ChecksumWorkerResponse,
} from "../src/sync/checksum-worker-protocol";
import { ChecksumWorkerRuntime } from "../src/sync/checksum-worker-runtime";

class RuntimeWorker implements ChecksumWorkerPort {
  onmessage: ((event: MessageEvent<ChecksumWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly postMessage = vi.fn(
    (message: ChecksumWorkerRequest, transfer: Transferable[] = []): void => {
      const request = structuredClone(message, { transfer });
      queueMicrotask(() => {
        void this.runtime.handle(request).then((response) => {
          if (!response) {
            return;
          }
          const returned = structuredClone(response, {
            transfer: [response.buffer],
          });
          this.onmessage?.({
            data: returned,
          } as MessageEvent<ChecksumWorkerResponse>);
        });
      });
    },
  );
  readonly terminate = vi.fn();

  constructor(private readonly runtime = new ChecksumWorkerRuntime()) {}
}

class FailingWorker implements ChecksumWorkerPort {
  onmessage: ((event: MessageEvent<ChecksumWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly terminate = vi.fn();

  postMessage(
    message: ChecksumWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    structuredClone(message, { transfer });
    queueMicrotask(() => {
      this.onerror?.({
        message: "worker crashed",
      } as ErrorEvent);
    });
  }
}

describe("ChecksumService", () => {
  it("lazily transfers and returns an exact backing buffer", async () => {
    const worker = new RuntimeWorker();
    const createWorker = vi.fn(() => worker);
    const service = new ChecksumService(createWorker);
    const source = new Uint8Array([1, 2, 3, 4]);
    const expected = md5(source);

    expect(createWorker).not.toHaveBeenCalled();
    const pending = service.hash(source);

    expect(createWorker).toHaveBeenCalledOnce();
    expect(source.buffer.byteLength).toBe(0);
    const result = await pending;
    expect(result.checksum).toBe(expected);
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(service.snapshot()).toMatchObject({
      hashes: 1,
      copiedInputBytes: 0,
      transferredInputBytes: 4,
      returnedBytes: 4,
      workerCreations: 1,
    });
  });

  it("copies only a sliced view and leaves its backing buffer attached", async () => {
    const worker = new RuntimeWorker();
    const service = new ChecksumService(() => worker);
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const slice = backing.subarray(1, 5);

    const result = await service.hash(slice);

    expect(backing.buffer.byteLength).toBe(6);
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.checksum).toBe(md5(new Uint8Array([1, 2, 3, 4])));
    expect(service.snapshot().copiedInputBytes).toBe(4);
  });

  it("cancels incremental work and receives ownership back", async () => {
    const worker = new RuntimeWorker(
      new ChecksumWorkerRuntime({
        chunkBytes: 4,
        yieldToWorker: async () => Promise.resolve(),
      }),
    );
    const service = new ChecksumService(() => worker);
    const controller = new AbortController();
    const source = new Uint8Array(16);

    const pending = service.hash(source, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(service.snapshot().returnedBytes).toBe(16);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "cancel",
      id: 1,
    });
  });

  it("rejects pending and future hashes after worker failure", async () => {
    const worker = new FailingWorker();
    const service = new ChecksumService(() => worker);

    await expect(service.hash(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "worker crashed",
    );
    await expect(service.hash(new Uint8Array([4, 5, 6]))).rejects.toThrow(
      "worker crashed",
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(service.snapshot().workerFailures).toBe(1);
  });
});

describe("ChecksumWorkerRuntime", () => {
  it("incrementally hashes a buffer and returns the same bytes", async () => {
    const runtime = new ChecksumWorkerRuntime({
      chunkBytes: 3,
      yieldToWorker: async () => Promise.resolve(),
    });
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);

    const response = await runtime.handle({
      type: "hash",
      id: 7,
      buffer: source.buffer,
    });

    expect(response?.type).toBe("hashed");
    if (response?.type !== "hashed") {
      return;
    }
    expect(response.checksum).toBe(md5(source));
    expect(new Uint8Array(response.buffer)).toEqual(source);
  });
});
