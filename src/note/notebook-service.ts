import type {
  NotebookWorkerRequest,
  NotebookWorkerResponse,
} from "./notebook-worker-protocol";
import type {
  NotebookDescriptor,
  NotebookSource,
  RenderedNotebookPage,
} from "./notebook-types";

export type {
  NotebookDescriptor,
  NotebookSource,
  RenderedNotebookPage,
} from "./notebook-types";

const MIB = 1_024 * 1_024;
const PARSE_WORKING_BYTES_PER_SOURCE_BYTE = 4;
export const DESKTOP_RENDER_BUDGET_BYTES = 128 * MIB;
export const MOBILE_RENDER_BUDGET_BYTES = 96 * MIB;
export const DESKTOP_TRANSIENT_SYNC_BUDGET_BYTES = 192 * MIB;
export const MOBILE_TRANSIENT_SYNC_BUDGET_BYTES = 128 * MIB;

export interface NotebookViewResourceState {
  readonly visible: boolean;
  readonly currentPage: number | null;
  readonly gridOpen: boolean;
  readonly canvasBytes?: number;
}

export type NotebookViewAdmissionResult =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: "resource-budget" | "unavailable";
    };

export interface NotebookBitmapHandle {
  /** Service-owned pixels that remain open until this handle is released. */
  readonly bitmap: ImageBitmap;
  /** Idempotently releases this consumer's borrow; never close bitmap directly. */
  release(): void;
}

export type NotebookBitmapPriority = "display" | "thumbnail";

export interface NotebookSessionLease {
  readonly descriptor: NotebookDescriptor;
  retain(): NotebookSessionLease;
  bitmap(pageNumber: number): Promise<NotebookBitmapHandle>;
  thumbnailBitmap(
    pageNumber: number,
    maxWidth?: number,
    priority?: NotebookBitmapPriority,
    signal?: AbortSignal,
  ): Promise<NotebookBitmapHandle>;
  renderPng(
    pageNumber: number,
    scale?: number,
    encoding?: "opaque-rgb",
  ): Promise<RenderedNotebookPage>;
  updateView(state: NotebookViewResourceState): NotebookViewAdmissionResult;
  close(): void;
}

export interface NotebookOpenOptions {
  /**
   * `reloadable` allows short-lived inspection work to suspend a visible
   * reader's worker source while leaving its already-drawn canvas intact.
   */
  reclaim?: "inactive" | "reloadable";
  /**
   * `transient` admits short-lived sync parsing against the separately bounded
   * transient ceiling instead of the steady interactive-reader ceiling.
   */
  budget?: "interactive" | "transient";
  /** Cancels only this caller's pending lease claim. */
  signal?: AbortSignal;
}

export interface NotebookSessionProvider {
  open(
    source: NotebookSource,
    options?: NotebookOpenOptions,
  ): Promise<NotebookSessionLease>;
}

export interface NotebookSessionResourceSnapshot {
  readonly path: string;
  readonly sourceBytes: number;
  readonly parsedBytes: number;
  readonly canvasBytes: number;
  readonly bitmapBytes: number;
  readonly inFlightBytes: number;
  readonly retainedBytes: number;
}

export interface NotebookServiceSnapshot {
  activeSessions: number;
  activeLeases: number;
  sessionOpens: number;
  budgetBytes: number;
  transientBudgetBytes: number;
  retainedBytes: number;
  retainedSourceBytes: number;
  retainedParsedBytes: number;
  retainedCanvasBytes: number;
  retainedDecodedBytes: number;
  retainedBitmapBytes: number;
  pinnedBitmapBytes: number;
  queuedBytes: number;
  inFlightBytes: number;
  queuedRenders: number;
  inFlightRenders: number;
  maxObservedQueueDepth: number;
  maxObservedInFlightRenders: number;
  cancelledRenders: number;
  evictedBitmaps: number;
  transferredSourceBytes: number;
  sourceCopies: number;
  sessions: readonly NotebookSessionResourceSnapshot[];
}

export interface NotebookServiceOptions {
  createWorker: () => Worker;
  resourceBudgetBytes?: number;
  transientResourceBudgetBytes?: number;
  maxConcurrentRenders?: number;
  maxQueuedRenders?: number;
  notifyRenderingUnavailable?: (message: string) => void;
}

interface LeaseState {
  closed: boolean;
  view: NotebookViewResourceState;
}

interface CachedBitmap {
  readonly key: string;
  readonly kind: "display" | "thumbnail";
  readonly pageNumber: number;
  readonly bitmap: ImageBitmap;
  readonly bytes: number;
  borrows: number;
  closed: boolean;
  lastUsed: number;
}

interface SessionRecord {
  readonly id: number;
  readonly generation: number;
  readonly path: string;
  readonly revision: string;
  sourceBytes: number;
  parsedBytes: number;
  descriptorBytes: number;
  admissionBudgetBytes: number;
  reclaimVisibleSourcesDuringAdmission: boolean;
  pagePixelBytes: number;
  pageWidth: number;
  pageHeight: number;
  readonly sourceLoader: (() => Promise<Uint8Array>) | null;
  resident: boolean;
  opening: Promise<void> | null;
  resolveOpening: (() => void) | null;
  rejectOpening: ((error: Error) => void) | null;
  restoring: Promise<void> | null;
  lastUsed: number;
  readonly opened: Promise<NotebookDescriptor>;
  readonly resolveOpened: (descriptor: NotebookDescriptor) => void;
  readonly rejectOpened: (error: Error) => void;
  readonly bitmaps: Map<string, CachedBitmap>;
  readonly pendingBitmaps: Map<string, PendingBitmap>;
  readonly leaseStates: Set<LeaseState>;
  leases: number;
  closed: boolean;
}

const RENDER_PRIORITY = {
  currentPage: 0,
  adjacentPage: 1,
  thumbnail: 2,
  export: 3,
} as const;

type RenderPriority = (typeof RENDER_PRIORITY)[keyof typeof RENDER_PRIORITY];
type RenderState = "queued" | "in-flight" | "cancelled" | "completed";

interface PendingRenderBase {
  readonly id: number;
  readonly record: SessionRecord;
  readonly request: Extract<NotebookWorkerRequest, { type: "render" }>;
  readonly priority: RenderPriority;
  readonly sequence: number;
  readonly estimatedBytes: number;
  state: RenderState;
  reservationActive: boolean;
  settled: boolean;
}

interface PendingBitmapWaiter {
  resolve: (handle: NotebookBitmapHandle) => void;
  reject: (error: Error) => void;
}

interface PendingBitmap extends PendingRenderBase {
  readonly output: "bitmap";
  readonly key: string;
  readonly kind: CachedBitmap["kind"];
  readonly pageNumber: number;
  readonly waiters: Set<PendingBitmapWaiter>;
}

interface PendingPng extends PendingRenderBase {
  readonly output: "png";
  readonly promise: Promise<RenderedNotebookPage>;
  resolve: (page: RenderedNotebookPage) => void;
  reject: (error: Error) => void;
}

type PendingRender = PendingBitmap | PendingPng;

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

export class NotebookRenderingUnavailableError extends Error {
  constructor(error: unknown) {
    super(
      `Supernote notebook worker is unavailable: ${
        error instanceof Error ? error.message : "unknown worker error"
      }`,
      { cause: error },
    );
    this.name = "NotebookRenderingUnavailableError";
  }
}

export const isNotebookRenderingUnavailableError = (
  error: unknown,
): error is NotebookRenderingUnavailableError =>
  error instanceof NotebookRenderingUnavailableError;

export class NotebookRenderCancelledError extends Error {
  constructor(message = "Supernote render cancelled") {
    super(message);
    this.name = "NotebookRenderCancelledError";
  }
}

export const isNotebookRenderCancelledError = (
  error: unknown,
): error is NotebookRenderCancelledError =>
  error instanceof NotebookRenderCancelledError;

const unavailableError = (error: unknown): NotebookRenderingUnavailableError =>
  new NotebookRenderingUnavailableError(error);

const defaultViewState = (): NotebookViewResourceState => ({
  visible: false,
  currentPage: null,
  gridOpen: false,
  canvasBytes: 0,
});

const bitmapBytes = (bitmap: ImageBitmap): number =>
  bitmap.width * bitmap.height * 4;

const notebookIdentity = (path: string, revision: string): string =>
  `${path}\0${revision}`;

const compareRenderOrder = (
  left: PendingRender,
  right: PendingRender,
): number =>
  left.priority === right.priority
    ? left.sequence - right.sequence
    : left.priority - right.priority;

export class NotebookService implements NotebookSessionProvider {
  private worker: Worker | null = null;
  private workerUnavailable: Error | null = null;
  private workerUnavailableNotified = false;
  private readonly sessionsByIdentity = new Map<string, SessionRecord>();
  private readonly sessionsById = new Map<number, SessionRecord>();
  private readonly retiredResourceSessions = new Set<SessionRecord>();
  private readonly pendingRenders = new Map<number, PendingRender>();
  private readonly renderQueue: PendingRender[] = [];
  private readonly resourceBudgetBytes: number;
  private readonly transientResourceBudgetBytes: number;
  private readonly maxConcurrentRenders: number;
  private readonly maxQueuedRenders: number;
  private nextSessionId = 1;
  private nextRequestId = 1;
  private nextRenderSequence = 1;
  private resourceClock = 0;
  private sessionOpens = 0;
  private transferredSourceBytes = 0;
  private sourceCopies = 0;
  private retainedBitmapBytes = 0;
  private inFlightBytes = 0;
  private activeRenders = 0;
  private maxObservedQueueDepth = 0;
  private maxObservedInFlightRenders = 0;
  private cancelledRenders = 0;
  private evictedBitmaps = 0;

  constructor(private readonly options: NotebookServiceOptions) {
    this.resourceBudgetBytes = Math.max(
      1,
      options.resourceBudgetBytes ?? DESKTOP_RENDER_BUDGET_BYTES,
    );
    this.transientResourceBudgetBytes = Math.max(
      this.resourceBudgetBytes,
      options.transientResourceBudgetBytes ?? this.resourceBudgetBytes,
    );
    this.maxConcurrentRenders = Math.max(
      1,
      Math.trunc(options.maxConcurrentRenders ?? 2),
    );
    this.maxQueuedRenders = Math.max(
      1,
      Math.trunc(options.maxQueuedRenders ?? 64),
    );
  }

  async open(
    source: NotebookSource,
    options: NotebookOpenOptions = {},
  ): Promise<NotebookSessionLease> {
    if (options.signal?.aborted) {
      throw this.abortError();
    }
    const worker = this.ensureWorker();
    const admissionBudgetBytes =
      options.budget === "transient"
        ? this.transientResourceBudgetBytes
        : this.resourceBudgetBytes;
    const identity = notebookIdentity(source.path, source.revision);
    const existing = this.sessionsByIdentity.get(identity);
    if (existing && !existing.closed) {
      existing.leases += 1;
      existing.lastUsed = ++this.resourceClock;
      return this.openClaim(existing, options, admissionBudgetBytes);
    }

    const opened = deferred<NotebookDescriptor>();
    void opened.promise.catch(() => undefined);
    const sessionId = this.nextSessionId++;
    const record: SessionRecord = {
      id: sessionId,
      generation: sessionId,
      path: source.path,
      revision: source.revision,
      sourceBytes: 0,
      parsedBytes: 0,
      descriptorBytes: 0,
      admissionBudgetBytes,
      reclaimVisibleSourcesDuringAdmission: options.reclaim === "reloadable",
      pagePixelBytes: 0,
      pageWidth: 0,
      pageHeight: 0,
      sourceLoader: "load" in source ? source.load : null,
      resident: false,
      opening: null,
      resolveOpening: null,
      rejectOpening: null,
      restoring: null,
      lastUsed: ++this.resourceClock,
      opened: opened.promise,
      resolveOpened: opened.resolve,
      rejectOpened: opened.reject,
      bitmaps: new Map(),
      pendingBitmaps: new Map(),
      leaseStates: new Set(),
      leases: 1,
      closed: false,
    };
    this.sessionsByIdentity.set(identity, record);
    this.sessionsById.set(record.id, record);
    void this.initializeRecord(
      record,
      source,
      worker,
      options,
      admissionBudgetBytes,
    ).catch((error: unknown) => {
      this.closeSession(
        record,
        error instanceof Error
          ? error
          : new Error("Could not open Supernote notebook session"),
      );
    });
    return this.openClaim(record, options, admissionBudgetBytes);
  }

  private async initializeRecord(
    record: SessionRecord,
    source: NotebookSource,
    worker: Worker,
    options: NotebookOpenOptions,
    admissionBudgetBytes: number,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = "bytes" in source ? source.bytes : await source.load();
    } catch (error) {
      const loadError =
        error instanceof Error
          ? error
          : new Error("Could not read Supernote notebook");
      this.closeSession(record, loadError);
      throw loadError;
    }
    const identity = notebookIdentity(source.path, source.revision);
    if (record.closed || this.sessionsByIdentity.get(identity) !== record) {
      throw new Error("Notebook source changed");
    }
    this.sessionOpens += 1;
    await this.openWorkerSession(
      record,
      bytes,
      "bytes" in source && source.transfer === "copy",
      worker,
      options.reclaim,
      admissionBudgetBytes,
    );
  }

  private async openClaim(
    record: SessionRecord,
    options: NotebookOpenOptions,
    admissionBudgetBytes: number,
  ): Promise<NotebookSessionLease> {
    try {
      const descriptor = await this.withAbort(record.opened, options.signal);
      await this.withAbort(
        this.ensureResident(record, options.reclaim, admissionBudgetBytes),
        options.signal,
      );
      return this.createLease(record, descriptor);
    } catch (error) {
      if (!record.closed) {
        record.leases = Math.max(0, record.leases - 1);
        if (record.leases === 0) {
          this.closeSession(
            record,
            this.isAbortError(error)
              ? this.abortError()
              : error instanceof Error
                ? error
                : new Error("Could not open Supernote notebook session"),
          );
        }
      }
      throw error;
    }
  }

  private withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.reject(this.abortError());
    }
    return new Promise<T>((resolve, reject) => {
      const aborted = (): void => {
        signal.removeEventListener("abort", aborted);
        reject(this.abortError());
      };
      signal.addEventListener("abort", aborted, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  }

  snapshot(): NotebookServiceSnapshot {
    const resourceSessions = new Set(this.sessionsById.values());
    for (const session of this.retiredResourceSessions) {
      resourceSessions.add(session);
    }
    for (const render of this.pendingRenders.values()) {
      if (render.reservationActive) {
        resourceSessions.add(render.record);
      }
    }
    const sessions = [...resourceSessions].map((session) => {
      const bitmapBytesForSession = [...session.bitmaps.values()].reduce(
        (total, bitmap) => total + bitmap.bytes,
        0,
      );
      const inFlightBytesForSession = [...this.pendingRenders.values()]
        .filter(
          (render) => render.record === session && render.reservationActive,
        )
        .reduce((total, render) => total + render.estimatedBytes, 0);
      const canvasBytesForSession = this.canvasBytes(session);
      return {
        path: session.path,
        sourceBytes: session.sourceBytes,
        parsedBytes: session.parsedBytes,
        canvasBytes: canvasBytesForSession,
        bitmapBytes: bitmapBytesForSession,
        inFlightBytes: inFlightBytesForSession,
        retainedBytes:
          session.sourceBytes +
          session.parsedBytes +
          canvasBytesForSession +
          bitmapBytesForSession +
          inFlightBytesForSession,
      };
    });
    const retainedSourceBytes = sessions.reduce(
      (total, session) => total + session.sourceBytes,
      0,
    );
    const retainedParsedBytes = sessions.reduce(
      (total, session) => total + session.parsedBytes,
      0,
    );
    const retainedCanvasBytes = sessions.reduce(
      (total, session) => total + session.canvasBytes,
      0,
    );
    const pinnedBitmapBytes = [...resourceSessions].reduce(
      (total, session) =>
        total +
        [...session.bitmaps.values()]
          .filter((bitmap) => this.isPinned(session, bitmap))
          .reduce((subtotal, bitmap) => subtotal + bitmap.bytes, 0),
      0,
    );
    return {
      activeSessions: this.sessionsById.size,
      activeLeases: [...this.sessionsById.values()].reduce(
        (total, session) => total + session.leases,
        0,
      ),
      sessionOpens: this.sessionOpens,
      budgetBytes: this.resourceBudgetBytes,
      transientBudgetBytes: this.transientResourceBudgetBytes,
      retainedBytes:
        retainedSourceBytes +
        retainedParsedBytes +
        retainedCanvasBytes +
        this.retainedBitmapBytes +
        this.inFlightBytes,
      retainedSourceBytes,
      retainedParsedBytes,
      retainedCanvasBytes,
      retainedDecodedBytes: 0,
      retainedBitmapBytes: this.retainedBitmapBytes,
      pinnedBitmapBytes,
      queuedBytes: 0,
      inFlightBytes: this.inFlightBytes,
      queuedRenders: this.renderQueue.length,
      inFlightRenders: this.activeRenders,
      maxObservedQueueDepth: this.maxObservedQueueDepth,
      maxObservedInFlightRenders: this.maxObservedInFlightRenders,
      cancelledRenders: this.cancelledRenders,
      evictedBitmaps: this.evictedBitmaps,
      transferredSourceBytes: this.transferredSourceBytes,
      sourceCopies: this.sourceCopies,
      sessions,
    };
  }

  dispose(): void {
    const disposed = new Error("Supernote notebook service was disposed");
    for (const record of [...this.sessionsById.values()]) {
      this.closeSession(record, disposed);
    }
    this.worker?.terminate();
    this.worker = null;
    this.resetWorkerRenders();
    this.workerUnavailable = disposed;
  }

  private transferableSource(bytes: Uint8Array, copy: boolean): ArrayBuffer {
    const sourceBuffer =
      !copy &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : Uint8Array.from(bytes).buffer;
    if (sourceBuffer !== bytes.buffer) {
      this.sourceCopies += 1;
    }
    this.transferredSourceBytes += sourceBuffer.byteLength;
    return sourceBuffer;
  }

  private async openWorkerSession(
    record: SessionRecord,
    bytes: Uint8Array,
    copy: boolean,
    worker = this.ensureWorker(),
    reclaim: NotebookOpenOptions["reclaim"] = "inactive",
    admissionBudgetBytes = this.resourceBudgetBytes,
  ): Promise<void> {
    const parseWorkingBytes =
      bytes.byteLength * PARSE_WORKING_BYTES_PER_SOURCE_BYTE;
    if (
      !this.evictToFit(
        bytes.byteLength + parseWorkingBytes,
        record,
        reclaim === "reloadable",
        admissionBudgetBytes,
      )
    ) {
      throw new Error(
        `Supernote source exceeds the ${admissionBudgetBytes}-byte resource budget`,
      );
    }
    record.admissionBudgetBytes = admissionBudgetBytes;
    record.reclaimVisibleSourcesDuringAdmission = reclaim === "reloadable";
    const opening = deferred<void>();
    record.opening = opening.promise;
    record.resolveOpening = opening.resolve;
    record.rejectOpening = opening.reject;
    record.sourceBytes = bytes.byteLength;
    record.parsedBytes = record.descriptorBytes + parseWorkingBytes;
    record.resident = true;
    record.lastUsed = ++this.resourceClock;
    const sourceBuffer = this.transferableSource(bytes, copy);
    const request: NotebookWorkerRequest = {
      type: "open",
      id: this.nextRequestId++,
      sessionId: record.id,
      generation: record.generation,
      path: record.path,
      revision: record.revision,
      bytes: sourceBuffer,
    };
    try {
      worker.postMessage(request, [sourceBuffer]);
      await opening.promise;
    } catch (error) {
      record.resident = false;
      record.sourceBytes = 0;
      record.parsedBytes = record.descriptorBytes;
      record.opening = null;
      record.resolveOpening = null;
      record.rejectOpening = null;
      throw error;
    }
  }

  private ensureResident(
    record: SessionRecord,
    reclaim: NotebookOpenOptions["reclaim"] = "inactive",
    admissionBudgetBytes = this.resourceBudgetBytes,
  ): Promise<void> {
    if (record.closed) {
      return Promise.reject(new Error("Notebook source changed"));
    }
    if (record.resident) {
      return record.opening ?? Promise.resolve();
    }
    if (record.restoring) {
      return record.restoring;
    }
    if (!record.sourceLoader) {
      return Promise.reject(
        new Error(
          "Notebook source is no longer resident and cannot be reloaded",
        ),
      );
    }
    const restoring = (async (): Promise<void> => {
      const bytes = await record.sourceLoader!();
      if (record.closed || this.sessionsById.get(record.id) !== record) {
        throw new Error("Notebook source changed");
      }
      this.sessionOpens += 1;
      await this.openWorkerSession(
        record,
        bytes,
        false,
        this.ensureWorker(),
        reclaim,
        admissionBudgetBytes,
      );
    })();
    record.restoring = restoring;
    const clearRestoring = (): void => {
      if (record.restoring === restoring) {
        record.restoring = null;
      }
    };
    void restoring.then(clearRestoring, clearRestoring);
    return restoring;
  }

  private receive(response: NotebookWorkerResponse): void {
    const record = this.sessionsById.get(response.sessionId);
    if (response.type === "opened") {
      if (
        record &&
        !record.closed &&
        record.generation === response.generation
      ) {
        record.pagePixelBytes = response.pagePixelBytes;
        record.pageWidth = response.pageWidth;
        record.pageHeight = response.pageHeight;
        if (record.descriptorBytes === 0) {
          record.descriptorBytes = response.descriptorMetadataBytes;
        }
        record.parsedBytes =
          record.descriptorBytes + response.parsedMetadataBytes;
        if (
          !this.evictToFit(
            0,
            record,
            record.reclaimVisibleSourcesDuringAdmission,
            record.admissionBudgetBytes,
          )
        ) {
          this.closeSession(
            record,
            new Error(
              `Supernote parsed source exceeds the ${record.admissionBudgetBytes}-byte resource budget`,
            ),
          );
          return;
        }
        record.opening = null;
        record.resolveOpening?.();
        record.resolveOpening = null;
        record.rejectOpening = null;
        record.resolveOpened(response.descriptor);
      }
      return;
    }

    const pending = this.pendingRenders.get(response.id);
    if (!pending) {
      if (response.type === "rendered" && response.output === "bitmap") {
        response.bitmap.close();
      } else if (response.type === "error" && record && !record.closed) {
        this.closeSession(record, new Error(response.message));
      }
      return;
    }
    this.finishRender(pending);
    const valid =
      record === pending.record &&
      !pending.record.closed &&
      pending.record.generation === response.generation &&
      pending.state !== "cancelled" &&
      !pending.settled;

    if (!valid) {
      if (response.type === "rendered" && response.output === "bitmap") {
        response.bitmap.close();
      }
      this.pumpQueue();
      return;
    }
    if (response.type === "error") {
      this.rejectRender(
        pending,
        response.errorKind === "cancelled"
          ? new NotebookRenderCancelledError(response.message)
          : new Error(response.message),
      );
    } else if (response.output === "bitmap" && pending.output === "bitmap") {
      const cached = this.cacheBitmap(pending, response.bitmap);
      if (cached) {
        this.resolveBitmap(pending, cached);
      } else {
        response.bitmap.close();
        this.rejectRender(
          pending,
          new Error(
            `Supernote bitmap exceeds the ${this.resourceBudgetBytes}-byte resource budget`,
          ),
        );
      }
    } else if (response.output === "png" && pending.output === "png") {
      pending.settled = true;
      pending.resolve({
        ...response.page,
        png: response.page.png,
      });
    } else {
      if (response.output === "bitmap") {
        response.bitmap.close();
      }
      this.rejectRender(
        pending,
        new Error("Supernote worker returned an unexpected render"),
      );
    }
    queueMicrotask(() => this.pumpQueue());
  }

  private createLease(
    record: SessionRecord,
    descriptor: NotebookDescriptor,
  ): NotebookSessionLease {
    const state: LeaseState = {
      closed: false,
      view: defaultViewState(),
    };
    record.leaseStates.add(state);
    return {
      descriptor,
      retain: () => {
        if (state.closed || record.closed) {
          throw new Error("Notebook source changed");
        }
        record.leases += 1;
        record.lastUsed = ++this.resourceClock;
        return this.createLease(record, descriptor);
      },
      bitmap: (pageNumber) =>
        this.renderBitmap(record, descriptor, state, pageNumber),
      thumbnailBitmap: (
        pageNumber,
        maxWidth = 240,
        priority = "thumbnail",
        signal,
      ) =>
        this.renderBitmap(
          record,
          descriptor,
          state,
          pageNumber,
          maxWidth,
          priority,
          signal,
        ),
      renderPng: (pageNumber, scale = 1, encoding) =>
        this.renderPng(record, descriptor, pageNumber, scale, encoding),
      updateView: (view) => this.updateView(record, descriptor, state, view),
      close: () => {
        if (state.closed) {
          return;
        }
        state.closed = true;
        record.leaseStates.delete(state);
        if (record.closed) {
          return;
        }
        record.leases -= 1;
        if (record.leases === 0) {
          this.closeSession(record);
        } else {
          this.releaseUnneededResources(record);
        }
      },
    };
  }

  private updateView(
    record: SessionRecord,
    descriptor: NotebookDescriptor,
    lease: LeaseState,
    view: NotebookViewResourceState,
  ): NotebookViewAdmissionResult {
    if (lease.closed || record.closed) {
      return {
        admitted: false,
        reason: "unavailable",
      };
    }
    if (
      view.currentPage !== null &&
      (!Number.isInteger(view.currentPage) ||
        view.currentPage < 1 ||
        view.currentPage > descriptor.pageCount)
    ) {
      throw new Error(`Invalid visible page: ${view.currentPage}`);
    }
    const nextView: NotebookViewResourceState = {
      visible: view.visible,
      currentPage: view.visible ? view.currentPage : null,
      gridOpen: view.visible && view.gridOpen,
      canvasBytes: view.visible
        ? Math.max(0, Math.trunc(view.canvasBytes ?? 0))
        : 0,
    };
    const additionalCanvasBytes = Math.max(
      0,
      (nextView.canvasBytes ?? 0) - (lease.view.canvasBytes ?? 0),
    );
    if (!this.evictToFit(additionalCanvasBytes)) {
      return {
        admitted: false,
        reason: "resource-budget",
      };
    }
    lease.view = nextView;
    this.releaseUnneededResources(record);
    this.pumpQueue();
    return { admitted: true };
  }

  private canvasBytes(record: SessionRecord): number {
    return [...record.leaseStates].reduce(
      (total, lease) => total + (lease.view.canvasBytes ?? 0),
      0,
    );
  }

  private scaledPixelBytes(record: SessionRecord, width: number): number {
    const height = Math.max(
      1,
      Math.round((record.pageHeight * width) / record.pageWidth),
    );
    return width * height * 4;
  }

  private bitmapWorkingBytes(
    record: SessionRecord,
    maxWidth: number | undefined,
    bitmapBackgroundBytes: number,
  ): number {
    const outputBytes =
      maxWidth === undefined || maxWidth >= record.pageWidth
        ? record.pagePixelBytes * 2
        : record.pagePixelBytes * 2 +
          this.scaledPixelBytes(record, maxWidth) * 2;
    return bitmapBackgroundBytes > 0
      ? Math.max(outputBytes, record.pagePixelBytes * 4 + bitmapBackgroundBytes)
      : outputBytes;
  }

  private pngWorkingBytes(
    record: SessionRecord,
    scale: number,
    bitmapBackgroundBytes: number,
  ): number {
    const outputBytes =
      scale === 1
        ? record.pagePixelBytes * 3
        : record.pagePixelBytes * 2 +
          this.scaledPixelBytes(
            record,
            Math.max(1, Math.round(record.pageWidth * scale)),
          ) *
            3;
    return bitmapBackgroundBytes > 0
      ? Math.max(outputBytes, record.pagePixelBytes * 4 + bitmapBackgroundBytes)
      : outputBytes;
  }

  private renderBitmap(
    record: SessionRecord,
    descriptor: NotebookDescriptor,
    lease: LeaseState,
    pageNumber: number,
    maxWidth?: number,
    requestedPriority: NotebookBitmapPriority = "thumbnail",
    signal?: AbortSignal,
  ): Promise<NotebookBitmapHandle> {
    if (signal?.aborted) {
      return Promise.reject(this.abortError());
    }
    const invalid = this.renderError(record, descriptor, pageNumber);
    if (invalid) {
      return Promise.reject(invalid);
    }
    if (
      maxWidth !== undefined &&
      (!Number.isFinite(maxWidth) || maxWidth <= 0)
    ) {
      return Promise.reject(new Error(`Invalid thumbnail width: ${maxWidth}`));
    }
    if (!record.resident || record.opening) {
      return this.ensureResident(record).then(() =>
        this.renderBitmap(
          record,
          descriptor,
          lease,
          pageNumber,
          maxWidth,
          requestedPriority,
          signal,
        ),
      );
    }
    record.lastUsed = ++this.resourceClock;
    const width =
      maxWidth === undefined ? undefined : Math.max(1, Math.round(maxWidth));
    const kind =
      width === undefined || requestedPriority === "display"
        ? "display"
        : "thumbnail";
    const key =
      width === undefined
        ? `display:${pageNumber}`
        : `${kind}:${pageNumber}:${width}`;
    const cached = record.bitmaps.get(key);
    if (cached) {
      cached.lastUsed = ++this.resourceClock;
      return Promise.resolve(this.borrowBitmap(record, cached));
    }
    const existing = record.pendingBitmaps.get(key);
    if (existing) {
      return this.waitForBitmap(existing, signal);
    }

    const id = this.nextRequestId++;
    const isCurrentPage =
      lease.view.visible && lease.view.currentPage === pageNumber;
    const priority: RenderPriority = isCurrentPage
      ? RENDER_PRIORITY.currentPage
      : kind === "thumbnail" || requestedPriority === "thumbnail"
        ? RENDER_PRIORITY.thumbnail
        : RENDER_PRIORITY.adjacentPage;
    const render: PendingBitmap = {
      id,
      output: "bitmap",
      key,
      kind,
      pageNumber,
      record,
      request: {
        type: "render",
        id,
        sessionId: record.id,
        generation: record.generation,
        pageNumber,
        output: "bitmap",
        ...(width !== undefined ? { maxWidth: width } : {}),
      },
      priority,
      sequence: this.nextRenderSequence++,
      estimatedBytes: this.bitmapWorkingBytes(
        record,
        width,
        descriptor.pages[pageNumber - 1]?.bitmapBackgroundBytes ?? 0,
      ),
      state: "queued",
      reservationActive: false,
      settled: false,
      waiters: new Set(),
    };
    const result = this.waitForBitmap(render, signal);
    record.pendingBitmaps.set(key, render);
    this.enqueue(render);
    return result;
  }

  private renderPng(
    record: SessionRecord,
    descriptor: NotebookDescriptor,
    pageNumber: number,
    scale: number,
    encoding?: "opaque-rgb",
  ): Promise<RenderedNotebookPage> {
    const invalid = this.renderError(record, descriptor, pageNumber);
    if (invalid) {
      return Promise.reject(invalid);
    }
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
      return Promise.reject(
        new Error(`Invalid Supernote render scale: ${scale}`),
      );
    }
    if (!record.resident || record.opening) {
      return this.ensureResident(record).then(() =>
        this.renderPng(record, descriptor, pageNumber, scale, encoding),
      );
    }
    record.lastUsed = ++this.resourceClock;
    this.releaseDisplayResourcesForExport(record);
    const pending = deferred<RenderedNotebookPage>();
    const id = this.nextRequestId++;
    const render: PendingPng = {
      id,
      output: "png",
      record,
      request: {
        type: "render",
        id,
        sessionId: record.id,
        generation: record.generation,
        pageNumber,
        output: "png",
        scale,
        ...(encoding ? { encoding } : {}),
      },
      priority: RENDER_PRIORITY.export,
      sequence: this.nextRenderSequence++,
      estimatedBytes: this.pngWorkingBytes(
        record,
        scale,
        descriptor.pages[pageNumber - 1]?.bitmapBackgroundBytes ?? 0,
      ),
      state: "queued",
      reservationActive: false,
      settled: false,
      promise: pending.promise,
      resolve: pending.resolve,
      reject: pending.reject,
    };
    this.enqueue(render);
    return render.promise;
  }

  private releaseDisplayResourcesForExport(record: SessionRecord): void {
    for (const bitmap of [...record.bitmaps.values()]) {
      if (bitmap.kind === "display" && bitmap.borrows === 0) {
        this.evictBitmap(record, bitmap);
      }
    }
  }

  private enqueue(render: PendingRender): void {
    this.pendingRenders.set(render.id, render);
    this.renderQueue.push(render);
    this.maxObservedQueueDepth = Math.max(
      this.maxObservedQueueDepth,
      this.renderQueue.length,
    );
    while (this.renderQueue.length > this.maxQueuedRenders) {
      const candidate = this.lowestPriorityQueued();
      if (!candidate) {
        break;
      }
      this.cancelRender(
        candidate,
        new NotebookRenderCancelledError(
          "Supernote render cancelled by backpressure",
        ),
      );
    }
    this.pumpQueue();
  }

  private pumpQueue(): void {
    while (
      this.activeRenders < this.maxConcurrentRenders &&
      this.renderQueue.length > 0
    ) {
      const next = this.highestPriorityQueued();
      if (!next) {
        return;
      }
      const index = this.renderQueue.indexOf(next);
      this.renderQueue.splice(index, 1);
      if (!this.reserve(next)) {
        if (
          this.fixedRetainedBytes() + next.estimatedBytes <=
          this.resourceBudgetBytes
        ) {
          this.renderQueue.push(next);
          return;
        }
        this.pendingRenders.delete(next.id);
        this.removePendingBitmap(next);
        this.rejectRender(
          next,
          new Error(
            `Supernote render exceeds the ${this.resourceBudgetBytes}-byte resource budget`,
          ),
        );
        next.state = "completed";
        continue;
      }
      next.state = "in-flight";
      this.activeRenders += 1;
      this.maxObservedInFlightRenders = Math.max(
        this.maxObservedInFlightRenders,
        this.activeRenders,
      );
      try {
        this.ensureWorker().postMessage(next.request);
      } catch (error) {
        this.finishRender(next);
        this.rejectRender(
          next,
          error instanceof Error
            ? error
            : new Error("Could not request Supernote render"),
        );
      }
    }
  }

  private reserve(render: PendingRender): boolean {
    if (!this.evictToFit(render.estimatedBytes)) {
      return false;
    }
    render.reservationActive = true;
    this.inFlightBytes += render.estimatedBytes;
    return true;
  }

  private fixedRetainedBytes(): number {
    return [...this.sessionsById.values()].reduce(
      (total, session) =>
        total +
        session.sourceBytes +
        session.parsedBytes +
        this.canvasBytes(session),
      0,
    );
  }

  private finishRender(render: PendingRender): void {
    if (render.state === "in-flight" || render.state === "cancelled") {
      this.activeRenders = Math.max(0, this.activeRenders - 1);
    }
    this.releaseReservation(render);
    this.pendingRenders.delete(render.id);
    this.removePendingBitmap(render);
    if (render.state !== "cancelled") {
      render.state = "completed";
    }
  }

  private releaseReservation(render: PendingRender): void {
    if (!render.reservationActive) {
      return;
    }
    render.reservationActive = false;
    this.inFlightBytes = Math.max(
      0,
      this.inFlightBytes - render.estimatedBytes,
    );
  }

  private highestPriorityQueued(): PendingRender | undefined {
    return this.renderQueue.reduce<PendingRender | undefined>(
      (selected, render) =>
        !selected || compareRenderOrder(render, selected) < 0
          ? render
          : selected,
      undefined,
    );
  }

  private lowestPriorityQueued(): PendingRender | undefined {
    return this.renderQueue.reduce<PendingRender | undefined>(
      (selected, render) =>
        !selected || compareRenderOrder(render, selected) > 0
          ? render
          : selected,
      undefined,
    );
  }

  private cancelRender(render: PendingRender, error: Error): void {
    if (render.state === "completed" || render.state === "cancelled") {
      return;
    }
    this.cancelledRenders += 1;
    if (render.state === "queued") {
      const index = this.renderQueue.indexOf(render);
      if (index >= 0) {
        this.renderQueue.splice(index, 1);
      }
      this.pendingRenders.delete(render.id);
      this.removePendingBitmap(render);
      render.state = "completed";
    } else {
      render.state = "cancelled";
      this.removePendingBitmap(render);
      const request: NotebookWorkerRequest = {
        type: "cancel",
        id: render.id,
        sessionId: render.record.id,
        generation: render.record.generation,
      };
      try {
        this.worker?.postMessage(request);
      } catch {
        // Keep the reservation until worker failure or a late response confirms
        // that the worker no longer owns the render allocation.
      }
    }
    this.rejectRender(render, error);
  }

  private rejectRender(render: PendingRender, error: Error): void {
    if (render.settled) {
      return;
    }
    render.settled = true;
    if (render.output === "bitmap") {
      for (const waiter of render.waiters) {
        waiter.reject(error);
      }
      render.waiters.clear();
    } else {
      render.reject(error);
    }
  }

  private removePendingBitmap(render: PendingRender): void {
    if (
      render.output === "bitmap" &&
      render.record.pendingBitmaps.get(render.key) === render
    ) {
      render.record.pendingBitmaps.delete(render.key);
    }
  }

  private waitForBitmap(
    render: PendingBitmap,
    signal?: AbortSignal,
  ): Promise<NotebookBitmapHandle> {
    return new Promise<NotebookBitmapHandle>((resolve, reject) => {
      let abortListener: (() => void) | null = null;
      const cleanup = (): void => {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      };
      const waiter: PendingBitmapWaiter = {
        resolve: (handle) => {
          cleanup();
          resolve(handle);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      abortListener = () => {
        if (!render.waiters.delete(waiter)) {
          return;
        }
        cleanup();
        reject(this.abortError());
        if (render.waiters.size === 0 && !render.settled) {
          this.cancelRender(render, this.abortError());
          queueMicrotask(() => this.pumpQueue());
        }
      };
      render.waiters.add(waiter);
      signal?.addEventListener("abort", abortListener, { once: true });
    });
  }

  private abortError(): Error {
    const error = new Error("Supernote operation cancelled");
    error.name = "AbortError";
    return error;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  private resolveBitmap(render: PendingBitmap, bitmap: CachedBitmap): void {
    if (render.settled) {
      return;
    }
    render.settled = true;
    for (const waiter of render.waiters) {
      waiter.resolve(this.borrowBitmap(render.record, bitmap));
    }
    render.waiters.clear();
  }

  private cacheBitmap(
    render: PendingBitmap,
    bitmap: ImageBitmap,
  ): CachedBitmap | null {
    const bytes = bitmapBytes(bitmap);
    if (!this.evictToFit(bytes)) {
      return null;
    }
    const prior = render.record.bitmaps.get(render.key);
    if (prior) {
      this.evictBitmap(render.record, prior);
    }
    const cached: CachedBitmap = {
      key: render.key,
      kind: render.kind,
      pageNumber: render.pageNumber,
      bitmap,
      bytes,
      borrows: 0,
      closed: false,
      lastUsed: ++this.resourceClock,
    };
    render.record.bitmaps.set(render.key, cached);
    this.retainedBitmapBytes += bytes;
    return cached;
  }

  private borrowBitmap(
    record: SessionRecord,
    bitmap: CachedBitmap,
  ): NotebookBitmapHandle {
    bitmap.borrows += 1;
    let released = false;
    return {
      bitmap: bitmap.bitmap,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        bitmap.borrows = Math.max(0, bitmap.borrows - 1);
        if (bitmap.borrows === 0 && record.closed) {
          this.evictBitmap(record, bitmap);
        } else if (!record.closed) {
          this.releaseUnneededResources(record);
        }
        this.pumpQueue();
      },
    };
  }

  private evictToFit(
    additionalBytes: number,
    excludedSession?: SessionRecord,
    includeVisibleSessions = false,
    budgetBytes = this.resourceBudgetBytes,
  ): boolean {
    while (this.retainedBytes() + additionalBytes > budgetBytes) {
      const candidate = this.oldestUnpinnedBitmap();
      if (candidate) {
        this.evictBitmap(candidate.record, candidate.bitmap);
        continue;
      }
      const source = this.oldestSuspendableSession(
        excludedSession,
        includeVisibleSessions,
      );
      if (!source) {
        return false;
      }
      this.suspendSession(source);
    }
    return true;
  }

  private oldestUnpinnedBitmap():
    | { record: SessionRecord; bitmap: CachedBitmap }
    | undefined {
    let selected: { record: SessionRecord; bitmap: CachedBitmap } | undefined;
    for (const record of this.sessionsById.values()) {
      for (const bitmap of record.bitmaps.values()) {
        if (
          !this.isPinned(record, bitmap) &&
          (!selected || bitmap.lastUsed < selected.bitmap.lastUsed)
        ) {
          selected = { record, bitmap };
        }
      }
    }
    return selected;
  }

  private oldestSuspendableSession(
    excludedSession?: SessionRecord,
    includeVisibleSessions = false,
  ): SessionRecord | undefined {
    let selected: SessionRecord | undefined;
    for (const record of this.sessionsById.values()) {
      const hasPendingRender = [...this.pendingRenders.values()].some(
        (render) => render.record === record,
      );
      const visible = [...record.leaseStates].some(
        (lease) => lease.view.visible,
      );
      if (
        record !== excludedSession &&
        record.resident &&
        !record.opening &&
        record.sourceBytes > 0 &&
        record.sourceLoader &&
        !hasPendingRender &&
        (!visible || includeVisibleSessions) &&
        (!selected || record.lastUsed < selected.lastUsed)
      ) {
        selected = record;
      }
    }
    return selected;
  }

  private suspendSession(record: SessionRecord): void {
    this.releaseUnneededResources(record);
    record.resident = false;
    record.sourceBytes = 0;
    record.parsedBytes = record.descriptorBytes;
    const request: NotebookWorkerRequest = {
      type: "close",
      sessionId: record.id,
      generation: record.generation,
    };
    try {
      this.worker?.postMessage(request);
    } catch {
      // Worker failure is surfaced through failWorker().
    }
  }

  private evictBitmap(record: SessionRecord, bitmap: CachedBitmap): void {
    if (bitmap.closed) {
      return;
    }
    if (bitmap.borrows > 0) {
      return;
    }
    bitmap.closed = true;
    if (record.bitmaps.get(bitmap.key) === bitmap) {
      record.bitmaps.delete(bitmap.key);
    }
    if (record.closed && record.bitmaps.size === 0) {
      this.retiredResourceSessions.delete(record);
    }
    this.retainedBitmapBytes = Math.max(
      0,
      this.retainedBitmapBytes - bitmap.bytes,
    );
    this.evictedBitmaps += 1;
    bitmap.bitmap.close();
  }

  private isPinned(record: SessionRecord, bitmap: CachedBitmap): boolean {
    if (bitmap.borrows > 0) {
      return true;
    }
    if (bitmap.kind !== "display") {
      return false;
    }
    return this.displayPageIsPinned(record, bitmap.pageNumber, true);
  }

  private releaseUnneededResources(record: SessionRecord): void {
    const visibleGrid = [...record.leaseStates].some(
      (lease) => lease.view.visible && lease.view.gridOpen,
    );
    const bitmapGridVisible = [...record.leaseStates].some(
      (lease) =>
        lease.view.visible &&
        lease.view.gridOpen &&
        (lease.view.canvasBytes ?? 0) === 0,
    );
    for (const render of [...this.pendingRenders.values()]) {
      if (render.record !== record || render.output !== "bitmap") {
        continue;
      }
      const needed =
        render.kind === "thumbnail"
          ? visibleGrid
          : this.pendingDisplayIsPinned(record, render);
      if (!needed) {
        this.cancelRender(render, new NotebookRenderCancelledError());
      }
    }
    for (const bitmap of [...record.bitmaps.values()]) {
      if (
        (bitmap.kind === "thumbnail" && !bitmapGridVisible) ||
        (bitmap.kind === "display" && !this.isPinned(record, bitmap))
      ) {
        this.evictBitmap(record, bitmap);
      }
    }
  }

  private pendingDisplayIsPinned(
    record: SessionRecord,
    render: PendingBitmap,
  ): boolean {
    return this.displayPageIsPinned(record, render.pageNumber);
  }

  private displayPageIsPinned(
    record: SessionRecord,
    pageNumber: number,
    requireBitmapStorage = false,
  ): boolean {
    for (const lease of record.leaseStates) {
      const view = lease.view;
      if (
        view.visible &&
        view.currentPage !== null &&
        (!requireBitmapStorage || (view.canvasBytes ?? 0) === 0) &&
        Math.abs(view.currentPage - pageNumber) <= 1
      ) {
        return true;
      }
    }
    return false;
  }

  private retainedBytes(): number {
    return (
      [...this.sessionsById.values()].reduce(
        (total, session) =>
          total +
          session.sourceBytes +
          session.parsedBytes +
          this.canvasBytes(session),
        0,
      ) +
      this.retainedBitmapBytes +
      this.inFlightBytes
    );
  }

  private renderError(
    record: SessionRecord,
    descriptor: NotebookDescriptor,
    pageNumber: number,
  ): Error | null {
    if (record.closed || this.sessionsById.get(record.id) !== record) {
      return new Error("Notebook source changed");
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return new Error(`Invalid Supernote page number: ${pageNumber}`);
    }
    return pageNumber > descriptor.pageCount
      ? new Error(
          `Page ${pageNumber} is not available; notebook has ${descriptor.pageCount} pages`,
        )
      : null;
  }

  private closeSession(record: SessionRecord, error?: Error): void {
    if (record.closed) {
      return;
    }
    record.closed = true;
    record.leases = 0;
    record.leaseStates.clear();
    const identity = notebookIdentity(record.path, record.revision);
    if (this.sessionsByIdentity.get(identity) === record) {
      this.sessionsByIdentity.delete(identity);
    }
    this.sessionsById.delete(record.id);
    if (error) {
      record.rejectOpened(error);
    }
    const closed = error ?? new Error("Notebook session closed");
    record.rejectOpening?.(closed);
    record.opening = null;
    record.resolveOpening = null;
    record.rejectOpening = null;
    for (const pending of [...this.pendingRenders.values()]) {
      if (pending.record === record) {
        this.cancelRender(pending, closed);
      }
    }
    for (const bitmap of [...record.bitmaps.values()]) {
      this.evictBitmap(record, bitmap);
    }
    if (record.bitmaps.size > 0) {
      this.retiredResourceSessions.add(record);
    }
    record.pendingBitmaps.clear();
    const wasResident = record.resident;
    record.resident = false;
    record.sourceBytes = 0;
    record.parsedBytes = 0;
    record.descriptorBytes = 0;
    const request: NotebookWorkerRequest = {
      type: "close",
      sessionId: record.id,
      generation: record.generation,
    };
    if (wasResident) {
      try {
        this.worker?.postMessage(request);
      } catch {
        // The main-thread owner is already released. Worker failure is handled
        // by failWorker(), which terminates every remaining session.
      }
    }
    this.pumpQueue();
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    if (this.workerUnavailable) {
      throw this.workerUnavailable;
    }
    try {
      const worker = this.options.createWorker();
      worker.onmessage = (
        event: MessageEvent<NotebookWorkerResponse>,
      ): void => {
        this.receive(event.data);
      };
      worker.onerror = (event): void => {
        this.failWorker(
          new Error(event.message || "Supernote notebook worker failed"),
        );
      };
      worker.onmessageerror = (): void => {
        this.failWorker(
          new Error("Supernote notebook worker returned invalid data"),
        );
      };
      this.worker = worker;
      return worker;
    } catch (error) {
      this.markWorkerUnavailable(error);
      throw this.workerUnavailable;
    }
  }

  private failWorker(error: Error): void {
    const unavailable = this.markWorkerUnavailable(error);
    for (const record of [...this.sessionsById.values()]) {
      this.closeSession(record, unavailable);
    }
    this.worker?.terminate();
    this.worker = null;
    this.resetWorkerRenders();
  }

  private markWorkerUnavailable(
    error: unknown,
  ): NotebookRenderingUnavailableError {
    const unavailable = unavailableError(error);
    this.workerUnavailable = unavailable;
    if (!this.workerUnavailableNotified) {
      this.workerUnavailableNotified = true;
      this.options.notifyRenderingUnavailable?.(
        "Supernote rendering is unavailable. Reload Obsidian to recover.",
      );
    }
    return unavailable;
  }

  private resetWorkerRenders(): void {
    this.pendingRenders.clear();
    this.renderQueue.length = 0;
    this.activeRenders = 0;
    this.inFlightBytes = 0;
  }
}
