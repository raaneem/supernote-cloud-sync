import type {
  ChecksumWorkerRequest,
  ChecksumWorkerResponse,
} from "./checksum-worker-protocol";

export interface ChecksumResult {
  checksum: string;
  bytes: Uint8Array;
}

export interface ChecksumProvider {
  hash(bytes: Uint8Array, signal?: AbortSignal): Promise<ChecksumResult>;
}

export interface ChecksumServiceSnapshot {
  hashes: number;
  copiedInputBytes: number;
  transferredInputBytes: number;
  returnedBytes: number;
  maxInFlight: number;
  maxInFlightBytes: number;
  maxPreparationTaskMs: number;
  workerCreations: number;
  workerFailures: number;
}

export interface ChecksumWorkerPort {
  onmessage: ((event: MessageEvent<ChecksumWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: ChecksumWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

interface PendingHash {
  cancelled: boolean;
  bytes: number;
  resolve: (result: ChecksumResult) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

const unavailableError = (error: unknown): Error =>
  new Error(
    `Supernote checksum worker is unavailable: ${
      error instanceof Error ? error.message : "unknown worker error"
    }`,
    { cause: error },
  );

const abortError = (): Error => {
  const error = new Error("Checksum calculation was cancelled");
  error.name = "AbortError";
  return error;
};

const now = (): number =>
  typeof performance === "undefined" ? Date.now() : performance.now();

export class ChecksumService implements ChecksumProvider {
  private worker: ChecksumWorkerPort | null = null;
  private workerUnavailable: Error | null = null;
  private readonly pending = new Map<number, PendingHash>();
  private nextRequestId = 1;
  private hashes = 0;
  private copiedInputBytes = 0;
  private transferredInputBytes = 0;
  private returnedBytes = 0;
  private maxInFlight = 0;
  private inFlightBytes = 0;
  private maxInFlightBytes = 0;
  private maxPreparationTaskMs = 0;
  private workerCreations = 0;
  private workerFailures = 0;

  constructor(private readonly createWorker: () => ChecksumWorkerPort) {}

  hash(bytes: Uint8Array, signal?: AbortSignal): Promise<ChecksumResult> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    let worker: ChecksumWorkerPort;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : unavailableError(error),
      );
    }
    const preparationStarted = now();
    const exactBuffer =
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : null;
    const buffer = exactBuffer ?? Uint8Array.from(bytes).buffer;
    if (!exactBuffer) {
      this.copiedInputBytes += buffer.byteLength;
    }
    this.transferredInputBytes += buffer.byteLength;
    this.maxPreparationTaskMs = Math.max(
      this.maxPreparationTaskMs,
      now() - preparationStarted,
    );

    const id = this.nextRequestId++;
    return new Promise<ChecksumResult>((resolve, reject) => {
      const abort = (): void => {
        pendingHash.cancelled = true;
        try {
          worker.postMessage({ type: "cancel", id });
        } catch (error) {
          this.failWorker(
            error instanceof Error ? error : new Error("Worker failed"),
          );
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      const pendingHash: PendingHash = {
        cancelled: false,
        bytes: buffer.byteLength,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", abort),
      };
      this.pending.set(id, pendingHash);
      this.maxInFlight = Math.max(this.maxInFlight, this.pending.size);
      this.inFlightBytes += buffer.byteLength;
      this.maxInFlightBytes = Math.max(
        this.maxInFlightBytes,
        this.inFlightBytes,
      );
      try {
        worker.postMessage({ type: "hash", id, buffer }, [buffer]);
      } catch (error) {
        this.failWorker(
          error instanceof Error ? error : new Error("Worker failed"),
        );
      }
    });
  }

  snapshot(): ChecksumServiceSnapshot {
    return {
      hashes: this.hashes,
      copiedInputBytes: this.copiedInputBytes,
      transferredInputBytes: this.transferredInputBytes,
      returnedBytes: this.returnedBytes,
      maxInFlight: this.maxInFlight,
      maxInFlightBytes: this.maxInFlightBytes,
      maxPreparationTaskMs: this.maxPreparationTaskMs,
      workerCreations: this.workerCreations,
      workerFailures: this.workerFailures,
    };
  }

  dispose(): void {
    this.failWorker(
      new Error("Supernote checksum service was disposed"),
      false,
    );
  }

  private ensureWorker(): ChecksumWorkerPort {
    if (this.worker) {
      return this.worker;
    }
    if (this.workerUnavailable) {
      throw this.workerUnavailable;
    }
    try {
      const worker = this.createWorker();
      worker.onmessage = (
        event: MessageEvent<ChecksumWorkerResponse>,
      ): void => {
        this.receive(event.data);
      };
      worker.onerror = (event): void => {
        this.failWorker(
          new Error(event.message || "Supernote checksum worker failed"),
        );
      };
      worker.onmessageerror = (): void => {
        this.failWorker(
          new Error("Supernote checksum worker returned invalid data"),
        );
      };
      this.worker = worker;
      this.workerCreations += 1;
      return worker;
    } catch (error) {
      this.workerUnavailable = unavailableError(error);
      throw this.workerUnavailable;
    }
  }

  private receive(response: ChecksumWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    this.inFlightBytes -= pending.bytes;
    pending.removeAbortListener();
    this.returnedBytes += response.buffer.byteLength;
    if (pending.cancelled) {
      pending.reject(abortError());
    } else if (response.type === "hashed") {
      this.hashes += 1;
      pending.resolve({
        checksum: response.checksum,
        bytes: new Uint8Array(response.buffer),
      });
    } else if (response.type === "cancelled") {
      pending.reject(abortError());
    } else {
      pending.reject(
        new Error(`Checksum calculation failed: ${response.message}`),
      );
    }
  }

  private failWorker(error: Error, countFailure = true): void {
    const unavailable = unavailableError(error);
    this.workerUnavailable = unavailable;
    if (countFailure) {
      this.workerFailures += 1;
    }
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(unavailable);
    }
    this.pending.clear();
    this.inFlightBytes = 0;
    this.worker?.terminate();
    this.worker = null;
  }
}
