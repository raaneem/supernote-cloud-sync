import SparkMD5 from "spark-md5";

import type {
  ChecksumWorkerRequest,
  ChecksumWorkerResponse,
} from "./checksum-worker-protocol";

const DEFAULT_CHUNK_BYTES = 1_024 * 1_024;

export interface ChecksumWorkerRuntimeOptions {
  chunkBytes?: number;
  yieldToWorker?: () => Promise<void>;
}

export class ChecksumWorkerRuntime {
  private readonly active = new Set<number>();
  private readonly cancelled = new Set<number>();
  private readonly chunkBytes: number;
  private readonly yieldToWorker: () => Promise<void>;

  constructor(options: ChecksumWorkerRuntimeOptions = {}) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.yieldToWorker =
      options.yieldToWorker ??
      (() => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  async handle(
    request: ChecksumWorkerRequest,
  ): Promise<ChecksumWorkerResponse | null> {
    if (request.type === "cancel") {
      if (this.active.has(request.id)) {
        this.cancelled.add(request.id);
      }
      return null;
    }

    this.active.add(request.id);
    try {
      const hasher = new SparkMD5.ArrayBuffer();
      for (
        let offset = 0;
        offset < request.buffer.byteLength;
        offset += this.chunkBytes
      ) {
        if (this.cancelled.has(request.id)) {
          return {
            type: "cancelled",
            id: request.id,
            buffer: request.buffer,
          };
        }
        hasher.append(
          request.buffer.slice(
            offset,
            Math.min(offset + this.chunkBytes, request.buffer.byteLength),
          ),
        );
        if (offset + this.chunkBytes < request.buffer.byteLength) {
          await this.yieldToWorker();
        }
      }
      if (this.cancelled.has(request.id)) {
        return {
          type: "cancelled",
          id: request.id,
          buffer: request.buffer,
        };
      }
      return {
        type: "hashed",
        id: request.id,
        checksum: hasher.end(),
        buffer: request.buffer,
      };
    } catch (error) {
      return {
        type: "error",
        id: request.id,
        message:
          error instanceof Error ? error.message : "Unknown checksum error",
        buffer: request.buffer,
      };
    } finally {
      this.active.delete(request.id);
      this.cancelled.delete(request.id);
    }
  }
}
