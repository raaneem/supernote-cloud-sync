import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

import type { CloudDirectory, CloudFile, CloudItem } from "../src/cloud/types";
import { decodeEmbeddedFont } from "../src/export/font-codec";
import { PdfLibExporter } from "../src/export/pdf-export";
import { encodeOpaqueNotebookPng } from "../src/note/notebook-png";
import { rasterizeNotebookPage } from "../src/note/notebook-rasterizer";
import {
  DESKTOP_RENDER_BUDGET_BYTES,
  MOBILE_RENDER_BUDGET_BYTES,
  NotebookService,
} from "../src/note/notebook-service";
import {
  ApiOcrService,
  BASE64_CHUNK_BYTES,
  BASE64_ENCODED_CHUNK_BYTES,
  DESKTOP_DOCUMENT_REQUEST_BYTE_LIMIT,
  MOBILE_DOCUMENT_REQUEST_BYTE_LIMIT,
} from "../src/ocr/api-ocr";
import type {
  NotebookWorkerRequest,
  NotebookWorkerResponse,
} from "../src/note/notebook-worker-protocol";
import { NotebookWorkerRuntime } from "../src/note/notebook-worker-runtime";
import { RunRegistry } from "../src/run/run-registry";
import { RunLogPaintScheduler } from "../src/run/run-log-paint-scheduler";
import {
  ChecksumService,
  type ChecksumWorkerPort,
} from "../src/sync/checksum-service";
import type {
  ChecksumWorkerRequest,
  ChecksumWorkerResponse,
} from "../src/sync/checksum-worker-protocol";
import { ChecksumWorkerRuntime } from "../src/sync/checksum-worker-runtime";
import {
  SyncManifestTransaction,
  type SyncManifest,
} from "../src/sync/manifest";
import {
  emptyPairBaseline,
  PairSyncService,
} from "../src/sync/pair-sync-service";
import { SyncService } from "../src/sync/sync-service";
import type { VaultStore } from "../src/sync/vault-store";
import { PagerSwipeGesture, pageTransition } from "../src/viewer/pager-motion";
import { gridPageNumbers, planGridWindow } from "../src/viewer/grid-window";
import { ReaderFrameBatcher } from "../src/viewer/reader-frame-batcher";
import {
  type BenchmarkPlatform,
  type BenchmarkProfile,
  collectAfterGc,
  collectMemory,
  memorySummary,
  type ScenarioObservation,
  summarizeTimings,
} from "./harness";
import {
  blankRlePage,
  generatedBytes,
  pageWorkload,
  REFERENCE_GRID_PAGES,
  REFERENCE_NOTEBOOK_PAGES,
  REFERENCE_SYNC_BYTES,
  REFERENCE_SYNC_FILES,
  syncPaths,
  syncWorkload,
} from "./workloads";
import { NodeNotebookImageCodec } from "./node-notebook-image-codec";

const MIB = 1_024 ** 2;
interface ScenarioOptions {
  platform: BenchmarkPlatform;
  profile: BenchmarkProfile;
  pluginRoot: string;
  privateNote?: string;
}

interface StartupChildResult {
  bundleBytes: number;
  moduleEvaluationMs: number;
  onloadMs: number;
  pdfFirstUseMaxTaskMs: number;
  pdfFirstUseMs: number;
  retainedBytes: number;
}

const platformLimit = (
  platform: BenchmarkPlatform,
  desktop: number,
  mobile: number,
): number => (platform === "desktop" ? desktop : mobile);

const fillHandwritingLikePage = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  pageNumber: number,
): number => {
  pixels.fill(255);
  const left = Math.round(width * 0.08);
  const right = Math.round(width * 0.92);
  const top = Math.round(height * 0.08);
  const lineSpacing = Math.max(12, Math.round(height * 0.028));
  const lineCount = Math.max(3, Math.floor((height - top * 2) / lineSpacing));
  let inkPixels = 0;
  const ink = (x: number, y: number, shade: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }
    const offset = (y * width + x) * 4;
    if (pixels[offset] === 255) {
      inkPixels += 1;
    }
    pixels[offset] = shade;
    pixels[offset + 1] = shade;
    pixels[offset + 2] = shade;
  };

  for (let line = 0; line < lineCount; line += 1) {
    const baseline = top + line * lineSpacing;
    const amplitude = Math.max(2, Math.round(lineSpacing * 0.12));
    let x = left;
    let word = 0;
    while (x < right) {
      const wordWidth =
        Math.max(8, Math.round(width * 0.025)) +
        ((pageNumber * 31 + line * 17 + word * 23) %
          Math.max(4, Math.round(width * 0.04)));
      const wordEnd = Math.min(right, x + wordWidth);
      for (let column = x; column < wordEnd; column += 1) {
        const local = column - x;
        const wave =
          Math.sin((local + pageNumber * 5) / 5) +
          0.55 * Math.sin((local + line * 7) / 13);
        const y = Math.round(baseline + wave * amplitude);
        ink(column, y, 24);
        ink(column, y + 1, 54);
        if ((local + word + line) % 29 === 0) {
          for (let stem = 1; stem <= amplitude * 2; stem += 1) {
            ink(column, y - stem, 36);
          }
        }
      }
      const gap =
        Math.max(4, Math.round(width * 0.006)) +
        ((pageNumber + line + word * 3) %
          Math.max(2, Math.round(width * 0.006)));
      x = wordEnd + gap;
      word += 1;
    }
  }
  return inkPixels;
};

interface RenderBudgetObservation {
  cachedFlipP95Ms: number;
  cancelledRenders: number;
  maxObservedInFlightRenders: number;
  maxObservedQueueDepth: number;
  peakRetainedBytes: number;
  releasedRetainedBytes: number;
}

class RenderBudgetWorker {
  onmessage: ((event: MessageEvent<NotebookWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  postMessage(request: NotebookWorkerRequest): void {
    if (request.type === "close") {
      return;
    }
    if (request.type === "cancel") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: "error",
            id: request.id,
            sessionId: request.sessionId,
            generation: request.generation,
            message: "Supernote render cancelled",
          },
        } as MessageEvent<NotebookWorkerResponse>);
      });
      return;
    }
    if (request.type === "open") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: "opened",
            id: request.id,
            sessionId: request.sessionId,
            generation: request.generation,
            pagePixelBytes: 1_920 * 2_560 * 4,
            pageWidth: 1_920,
            pageHeight: 2_560,
            parsedMetadataBytes: REFERENCE_GRID_PAGES * 512,
            descriptorMetadataBytes: REFERENCE_GRID_PAGES * 256,
            descriptor: {
              path: request.path,
              revision: request.revision,
              pageCount: REFERENCE_GRID_PAGES,
              devicePage: 1,
              pages: Array.from(
                { length: REFERENCE_GRID_PAGES },
                (_, index) => ({
                  pageNumber: index + 1,
                  fingerprint: `generated-${index + 1}`,
                  recognitionText: null,
                  recognitionSpans: [],
                }),
              ),
              textBoxes: [],
            },
          },
        } as unknown as MessageEvent<NotebookWorkerResponse>);
      });
      return;
    }
    if (request.output === "png") {
      throw new Error("Render-budget contract requests bitmaps only");
    }
    const width = request.maxWidth ?? 1_920;
    const height = Math.round((2_560 * width) / 1_920);
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          type: "rendered",
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          output: "bitmap",
          bitmap: {
            width,
            height,
            close: () => undefined,
          } as ImageBitmap,
        },
      } as unknown as MessageEvent<NotebookWorkerResponse>);
    });
  }

  terminate(): void {}
}

class BenchmarkChecksumWorker implements ChecksumWorkerPort {
  onmessage: ((event: MessageEvent<ChecksumWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private readonly runtime = new ChecksumWorkerRuntime();
  private terminated = false;

  constructor(private readonly observeMemory: () => void) {}

  postMessage(
    message: ChecksumWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    if (this.terminated) {
      throw new Error("Benchmark checksum worker is terminated");
    }
    const request = structuredClone(message, { transfer });
    queueMicrotask(() => {
      void this.runtime.handle(request).then(
        (response) => {
          if (!response || this.terminated) {
            return;
          }
          this.observeMemory();
          const returned = structuredClone(response, {
            transfer: [response.buffer],
          });
          this.onmessage?.({
            data: returned,
          } as MessageEvent<ChecksumWorkerResponse>);
        },
        (error: unknown) => {
          this.onerror?.({
            message:
              error instanceof Error
                ? error.message
                : "Benchmark checksum worker failed",
          } as ErrorEvent);
        },
      );
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const renderBudgetContract = async (
  options: ScenarioOptions,
): Promise<RenderBudgetObservation> => {
  const service = new NotebookService({
    createWorker: () => new RenderBudgetWorker() as unknown as Worker,
    resourceBudgetBytes:
      options.platform === "mobile"
        ? MOBILE_RENDER_BUDGET_BYTES
        : DESKTOP_RENDER_BUDGET_BYTES,
    maxConcurrentRenders: options.platform === "mobile" ? 1 : 2,
  });
  const lease = await service.open({
    path: "generated-budget.note",
    revision: "benchmark",
    bytes: new Uint8Array(7 * MIB),
  });
  let peakRetainedBytes = service.snapshot().retainedBytes;
  const flipSamples: number[] = [];
  for (let page = 1; page <= 10; page += 1) {
    lease.updateView({
      visible: true,
      currentPage: page,
      gridOpen: false,
    });
    const start = performance.now();
    const handles = await Promise.all(
      [page - 1, page, page + 1]
        .filter(
          (candidate) => candidate >= 1 && candidate <= REFERENCE_GRID_PAGES,
        )
        .map((candidate) => lease.bitmap(candidate)),
    );
    flipSamples.push(performance.now() - start);
    for (const handle of handles) {
      handle.release();
    }
    peakRetainedBytes = Math.max(
      peakRetainedBytes,
      service.snapshot().retainedBytes,
    );
  }

  lease.updateView({
    visible: true,
    currentPage: null,
    gridOpen: true,
  });
  const thumbnailHandles = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      lease.thumbnailBitmap(index + 1, 240),
    ),
  );
  for (const handle of thumbnailHandles) {
    handle.release();
  }
  peakRetainedBytes = Math.max(
    peakRetainedBytes,
    service.snapshot().retainedBytes,
  );
  lease.updateView({
    visible: true,
    currentPage: 10,
    gridOpen: false,
  });

  lease.updateView({
    visible: true,
    currentPage: null,
    gridOpen: true,
  });
  const staleGrid = Array.from({ length: 40 }, (_, index) =>
    lease.thumbnailBitmap(index + 1, 240),
  );
  lease.updateView({
    visible: true,
    currentPage: 10,
    gridOpen: false,
  });
  const staleResults = await Promise.allSettled(staleGrid);
  for (const result of staleResults) {
    if (result.status === "fulfilled") {
      result.value.release();
    }
  }
  const active = service.snapshot();
  lease.close();
  await Promise.resolve();
  const released = service.snapshot();
  service.dispose();
  return {
    cachedFlipP95Ms: summarizeTimings(flipSamples.slice(1)).p95Ms,
    cancelledRenders: active.cancelledRenders,
    maxObservedInFlightRenders: active.maxObservedInFlightRenders,
    maxObservedQueueDepth: active.maxObservedQueueDepth,
    peakRetainedBytes,
    releasedRetainedBytes: released.retainedBytes,
  };
};

const startup = (options: ScenarioOptions): ScenarioObservation => {
  const runs =
    options.profile === "smoke" ? 2 : options.profile === "reference" ? 10 : 5;
  const samples: StartupChildResult[] = [];
  for (let index = 0; index < runs; index += 1) {
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        resolve(options.pluginRoot, "benchmarks/startup-child.cjs"),
        resolve(options.pluginRoot, "main.js"),
        options.platform,
      ],
      { encoding: "utf8" },
    );
    if (child.status !== 0) {
      throw new Error(
        `Cold activation child failed: ${child.stderr || child.stdout}`,
      );
    }
    samples.push(JSON.parse(child.stdout) as StartupChildResult);
  }
  const moduleEvaluation = summarizeTimings(
    samples.map((sample) => sample.moduleEvaluationMs),
  );
  const onload = summarizeTimings(samples.map((sample) => sample.onloadMs));
  const timings = summarizeTimings(
    samples.map((sample) => sample.moduleEvaluationMs + sample.onloadMs),
  );
  const retainedBytes = Math.max(
    ...samples.map((sample) => sample.retainedBytes),
  );
  const bundleBytes = samples[0]?.bundleBytes ?? 0;
  const bundle = readFileSync(resolve(options.pluginRoot, "main.js"));
  const bundleGzipBytes = gzipSync(bundle, { level: 9 }).byteLength;
  const bundleBrotliBytes = brotliCompressSync(bundle, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).byteLength;
  const fontPaths = [
    "node_modules/@expo-google-fonts/noto-sans-symbols-2/400Regular/NotoSansSymbols2_400Regular.ttf",
    "node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf",
    "node_modules/@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf",
  ];
  const fonts = fontPaths.map((path) =>
    readFileSync(resolve(options.pluginRoot, path)),
  );
  const fontDecodedBytes = fonts.reduce(
    (total, font) => total + font.byteLength,
    0,
  );
  const fontCompressedBytes = fonts.reduce(
    (total, font) => total + gzipSync(font, { level: 9 }).byteLength,
    0,
  );
  return {
    name: "cold-activation",
    workload: {
      bundle: "main.js",
      isolatedProcesses: runs,
    },
    timings,
    longTaskSamplesMs: samples.flatMap((sample) => [
      sample.moduleEvaluationMs,
      sample.onloadMs,
    ]),
    memory: memorySummary(0, retainedBytes, retainedBytes),
    metrics: {
      activationP95Ms: timings.p95Ms,
      bundleBytes,
      maxTaskMs: Math.max(moduleEvaluation.maxMs, onload.maxMs),
      moduleEvaluationP95Ms: moduleEvaluation.p95Ms,
      onloadP95Ms: onload.p95Ms,
    },
    budgets: [
      {
        metric: "activationP95Ms",
        limit: platformLimit(options.platform, 100, 200),
        unit: "ms",
        description: "Cold plugin activation p95",
      },
      {
        metric: "maxTaskMs",
        limit: 50,
        unit: "ms",
        description: "Maximum plugin-attributable startup task",
      },
      {
        metric: "bundleBytes",
        limit: 4 * MIB,
        unit: "bytes",
        description: "Uncompressed production main.js",
      },
    ],
    counters: {
      bundleBrotliBytes,
      bundleBytes,
      bundleGzipBytes,
      fontCompressedBytes,
      fontDecodedBytes,
      isolatedProcesses: runs,
      moduleEvaluationP95Ms: moduleEvaluation.p95Ms,
      onloadP95Ms: onload.p95Ms,
    },
    notes: [
      "Measures CommonJS module evaluation and resolved plugin onload separately with inert Obsidian registration boundaries.",
      "Release sizes report raw, gzip-9, and Brotli-11 bytes; embedded fonts report build-compressed and first-use decoded bytes.",
    ],
  };
};

const generatedPageRendering = async (
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  const workload = pageWorkload(options.profile);
  const rle = blankRlePage(workload.width, workload.height);
  const before = collectAfterGc();
  let peak = before;
  const samples: number[] = [];
  let decodedBytes = 0;
  let checksum = 0;
  for (let page = 0; page < workload.pages; page += 1) {
    const start = performance.now();
    const decoded = await rasterizeNotebookPage(
      workload.width,
      workload.height,
      {
        pageStyle: "style_white_a5x2",
        layerSequence: ["BGLAYER"],
        layers: {
          BGLAYER: {
            LAYERNAME: "BGLAYER",
            LAYERPROTOCOL: "RATTA_RLE",
            bitmapBuffer: rle,
          },
        },
      },
      async () => {
        throw new Error("Generated Ratta fixture cannot use a bitmap");
      },
    );
    samples.push(performance.now() - start);
    decodedBytes += decoded.pixels.byteLength;
    checksum ^= decoded.pixels[page % decoded.pixels.length] ?? 0;
    peak = Math.max(peak, collectMemory());
  }
  const after = collectAfterGc();
  const timings = summarizeTimings(samples);
  const memory = memorySummary(before, peak, after);
  const resources = await renderBudgetContract(options);
  return {
    name: "page-rendering",
    workload: {
      fixture: "generated-blank-ratta-rle",
      height: workload.height,
      referenceNotebookPages: REFERENCE_NOTEBOOK_PAGES,
      sampledPages: workload.pages,
      width: workload.width,
    },
    timings,
    memory,
    metrics: {
      maxTaskMs: timings.maxMs,
      pageP95Ms: timings.p95Ms,
      peakWorkingBytes: memory.peakWorkingBytes,
      cachedFlipP95Ms: resources.cachedFlipP95Ms,
      trackedRenderBytes: resources.peakRetainedBytes,
      releasedRenderBytes: resources.releasedRetainedBytes,
    },
    budgets: [
      {
        metric: "pageP95Ms",
        limit: platformLimit(options.platform, 300, 500),
        unit: "ms",
        description: "Uncached page pixels",
      },
      {
        metric: "maxTaskMs",
        limit: 50,
        unit: "ms",
        description: "Maximum plugin-attributable render task",
      },
      {
        metric: "peakWorkingBytes",
        limit: platformLimit(options.platform, 128 * MIB, 96 * MIB),
        unit: "bytes",
        description: "Render resource ceiling",
      },
      {
        metric: "trackedRenderBytes",
        limit: platformLimit(
          options.platform,
          DESKTOP_RENDER_BUDGET_BYTES,
          MOBILE_RENDER_BUDGET_BYTES,
        ),
        unit: "bytes",
        description: "Tracked render resource ceiling",
      },
      {
        metric: "releasedRenderBytes",
        limit: 0,
        unit: "bytes",
        description: "Tracked resources after final lease close",
      },
      {
        metric: "cachedFlipP95Ms",
        limit: 50,
        unit: "ms",
        description: "Cached or prefetched page flip p95",
      },
    ],
    counters: {
      checksum,
      cancelledRenders: resources.cancelledRenders,
      decodedBytes,
      encodedFixtureBytes: rle.byteLength,
      maxObservedInFlightRenders: resources.maxObservedInFlightRenders,
      maxObservedQueueDepth: resources.maxObservedQueueDepth,
      peakTrackedRenderBytes: resources.peakRetainedBytes,
      releasedTrackedRenderBytes: resources.releasedRetainedBytes,
    },
    notes: [
      "Generated fixture exercises the shipped Ratta decoder without personal notebook content.",
      "The resource contract drives ten pager windows, a 40-thumbnail grid, rapid grid closure, and final-session cleanup through NotebookService.",
      "Use --note with a gitignored local file to exercise the full parser, compositor, and PNG encoder.",
    ],
  };
};

const privateNoteRendering = async (
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  const source = readFileSync(options.privateNote!);
  const runtime = new NotebookWorkerRuntime(new NodeNotebookImageCodec());
  const opened = await runtime.handle({
    type: "open",
    id: 1,
    sessionId: 1,
    generation: 1,
    path: "private-note",
    revision: "benchmark",
    bytes: Uint8Array.from(source).buffer,
  });
  if (!opened || opened.type !== "opened") {
    throw new Error(
      opened?.type === "error"
        ? opened.message
        : "Private benchmark note did not open",
    );
  }
  const pages = Math.min(
    opened.descriptor.pageCount,
    options.profile === "reference" ? REFERENCE_NOTEBOOK_PAGES : 3,
  );
  if (pages === 0) {
    throw new Error("Private benchmark note has no pages");
  }
  const before = collectAfterGc();
  let peak = before;
  const samples: number[] = [];
  let pngBytes = 0;
  for (let page = 1; page <= pages; page += 1) {
    const start = performance.now();
    const rendered = await runtime.handle({
      type: "render",
      id: page + 1,
      sessionId: 1,
      generation: 1,
      pageNumber: page,
      output: "png",
      scale: 1,
    });
    if (
      !rendered ||
      rendered.type !== "rendered" ||
      rendered.output !== "png"
    ) {
      throw new Error(
        rendered?.type === "error"
          ? rendered.message
          : `Could not render private benchmark page ${page}`,
      );
    }
    pngBytes += rendered.page.png.byteLength;
    samples.push(performance.now() - start);
    peak = Math.max(peak, collectMemory());
  }
  const active = runtime.snapshot();
  await runtime.handle({
    type: "close",
    sessionId: 1,
    generation: 1,
  });
  const released = runtime.snapshot();
  const after = collectAfterGc();
  const timings = summarizeTimings(samples);
  const memory = memorySummary(before, peak, after);
  return {
    name: "page-rendering",
    workload: {
      fixture: "private-note",
      noteBytes: source.byteLength,
      notePages: opened.descriptor.pageCount,
      referenceNotebookPages: REFERENCE_NOTEBOOK_PAGES,
      sampledPages: pages,
    },
    timings,
    memory,
    metrics: {
      maxTaskMs: timings.maxMs,
      pageP95Ms: timings.p95Ms,
      peakWorkingBytes: memory.peakWorkingBytes,
    },
    budgets: [
      {
        metric: "pageP95Ms",
        limit: platformLimit(options.platform, 300, 500),
        unit: "ms",
        description: "Uncached page pixels",
      },
      {
        metric: "maxTaskMs",
        limit: 50,
        unit: "ms",
        description: "Maximum plugin-attributable render task",
      },
      {
        metric: "peakWorkingBytes",
        limit: platformLimit(options.platform, 128 * MIB, 96 * MIB),
        unit: "bytes",
        description: "Render resource ceiling",
      },
    ],
    counters: {
      activeSessionsAfterClose: released.activeSessions,
      inFlightRendersAfterSample: active.inFlightRenders,
      parseCount: active.parseCount,
      pngBytes,
      renderCount: active.renderCount,
      retainedDecodedBytesAfterSample: active.retainedDecodedBytes,
      retainedParsedBytesAfterClose: released.retainedParsedBytes,
      retainedParsedBytesWhileOpen: active.retainedParsedBytes,
      retainedSourceBytesAfterClose: released.retainedSourceBytes,
      retainedSourceBytesWhileOpen: active.retainedSourceBytes,
      sourceBufferCopies: 1,
      sourceBytes: source.byteLength,
    },
    notes: [
      "The private source path and notebook content are intentionally absent from benchmark output.",
      "The worker runtime opens one source session, renders the sampled pages, then proves source bytes return to zero on close.",
    ],
  };
};

const viewerInteraction = (options: ScenarioOptions): ScenarioObservation => {
  const before = collectAfterGc();
  const samples: number[] = [];
  const gestureSamples: number[] = [];
  let frameCallback: FrameRequestCallback = () => {};
  let frameRequests = 0;
  let transformCommits = 0;
  const batcher = new ReaderFrameBatcher(
    (callback) => {
      frameRequests += 1;
      frameCallback = callback;
      return frameRequests;
    },
    () => {},
    () => {
      transformCommits += 1;
    },
  );
  let mountedCards = 0;
  const viewportHeight = options.platform === "mobile" ? 700 : 720;
  const viewportWidth = options.platform === "mobile" ? 390 : 800;
  const firstGrid = planGridWindow({
    pageCount: REFERENCE_GRID_PAGES,
    scrollTop: 0,
    viewportHeight,
    viewportWidth,
  });
  for (let index = 0; index < 200; index += 1) {
    const start = performance.now();
    const plan = planGridWindow({
      pageCount: REFERENCE_GRID_PAGES,
      scrollTop: (firstGrid.contentHeight * index) / 199,
      viewportHeight,
      viewportWidth,
    });
    mountedCards = Math.max(mountedCards, gridPageNumbers(plan).length);
    samples.push(performance.now() - start);
  }
  let transitions = 0;
  for (let index = 0; index < 500; index += 1) {
    const start = performance.now();
    const gesture = new PagerSwipeGesture({
      start: { time: 0, x: 800, y: 500 },
      viewportWidth: 800,
      currentPage: (index % 998) + 2,
      pageCount: REFERENCE_GRID_PAGES,
      rtl: index % 2 === 0,
    });
    gesture.move({ time: 12, x: 760, y: 501 });
    gesture.move({ time: 24, x: 620, y: 503 });
    const result = gesture.finish({
      time: 36,
      x: 480,
      y: 505,
    });
    if (
      result.action !== "snap-back" &&
      pageTransition(10, 11, index % 2 === 0)
    ) {
      transitions += 1;
    }
    for (let write = 0; write < 20; write += 1) {
      batcher.schedule({
        track: { percent: -100, pixelOffset: write },
      });
    }
    const callback = frameCallback;
    frameCallback = () => {};
    callback(performance.now());
    const duration = performance.now() - start;
    samples.push(duration);
    gestureSamples.push(duration);
  }
  const peak = collectMemory();
  const after = collectAfterGc();
  const timings = summarizeTimings(samples);
  const memory = memorySummary(before, peak, after);
  return {
    name: "viewer-interaction",
    workload: {
      gestureSequences: 500,
      gridPages: REFERENCE_GRID_PAGES,
      profile: options.profile,
    },
    timings,
    memory,
    metrics: {
      gestureP95Ms: summarizeTimings(gestureSamples).p95Ms,
      maxTaskMs: timings.maxMs,
      mountedCards,
    },
    budgets: [
      {
        metric: "gestureP95Ms",
        limit: 8,
        unit: "ms",
        description: "Gesture and frame work p95",
      },
      {
        metric: "maxTaskMs",
        limit: 50,
        unit: "ms",
        description: "Maximum interaction task",
      },
      {
        metric: "mountedCards",
        limit: 40,
        unit: "count",
        description: "Visible grid cards plus overscan",
      },
    ],
    counters: {
      delegatedGridListeners: 6,
      frameRequests,
      inputTransformWrites: 10_000,
      mountedThumbnailCanvasBytes: mountedCards * 240 * 320 * 4,
      perCardListeners: 0,
      transitions,
      transformCommits,
    },
    notes: [
      "Before PERF-006 the grid mounted 1,000 cards and attached five listeners to every card.",
      "The production window planner retains two overscan rows on each side; the grid owns six delegated interaction listeners.",
      "Twenty transform updates per gesture sequence coalesce into one production frame-batcher commit.",
    ],
  };
};

const runLogStreaming = (): ScenarioObservation => {
  const lineCount = 1_000;
  const before = collectAfterGc();
  const payload = (() => {
    let now = 0;
    let frameCallback: FrameRequestCallback = () => {};
    let frameRequests = 0;
    let indicatorSignals = 0;
    let logPaints = 0;
    let logSignals = 0;
    let metadataSignals = 0;
    const registry = new RunRegistry({
      id: () => "benchmark-run",
      now: () => now,
    });
    const scheduler = new RunLogPaintScheduler(
      (callback) => {
        frameCallback = callback;
        frameRequests += 1;
        return frameRequests;
      },
      () => {},
      () => {
        logPaints += 1;
      },
    );
    const unsubscribe = registry.subscribe((signal) => {
      if (signal.type === "log") {
        logSignals += 1;
        scheduler.schedule(signal.runId);
      } else if (signal.type === "metadata") {
        metadataSignals += 1;
        scheduler.flush();
      } else {
        indicatorSignals += 1;
      }
    });
    const run = registry.start({
      engine: "command",
      kind: "transcription",
      label: "Generated stream",
      model: "benchmark",
    });
    const samples: number[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      now += 1;
      const start = performance.now();
      run.append(
        index % 10 === 0 ? "stderr" : "stdout",
        `generated line ${String(index).padStart(4, "0")}\n`,
      );
      samples.push(performance.now() - start);
      if ((index + 1) % 16 === 0) {
        const callback = frameCallback;
        frameCallback = () => {};
        callback(performance.now());
      }
    }
    run.finish("succeeded", { exitCode: 0 });
    const retainedLogBytes = new TextEncoder().encode(
      registry.logText(run.id),
    ).byteLength;
    unsubscribe();
    scheduler.dispose();
    return {
      frameRequests,
      indicatorSignals,
      logPaints,
      logSignals,
      metadataSignals,
      retainedLogBytes,
      samples,
    };
  })();
  const peak = collectMemory();
  const after = collectAfterGc();
  const timings = summarizeTimings(payload.samples);
  const memory = memorySummary(before, peak, after);
  return {
    name: "run-log-streaming",
    workload: {
      generatedLines: lineCount,
      maxLogBytes: 256 * 1_024,
    },
    timings,
    memory,
    metrics: {
      appendP95Ms: timings.p95Ms,
      indicatorMutations: payload.indicatorSignals,
      logPaints: payload.logPaints,
      maxTaskMs: timings.maxMs,
    },
    budgets: [
      {
        metric: "appendP95Ms",
        limit: 8,
        unit: "ms",
        description: "Stream append p95",
      },
      {
        metric: "maxTaskMs",
        limit: 50,
        unit: "ms",
        description: "Maximum stream append task",
      },
      {
        metric: "logPaints",
        limit: Math.ceil(lineCount / 16),
        unit: "count",
        description: "At most one open-console log paint per simulated frame",
      },
      {
        metric: "indicatorMutations",
        limit: 2,
        unit: "count",
        description: "Status changes only for running and completion",
      },
    ],
    counters: {
      detailsTreeRebuilds: 0,
      frameRequests: payload.frameRequests,
      fullLogJoins: 1,
      indicatorSignals: payload.indicatorSignals,
      logDomAppends: payload.logPaints,
      logPaints: payload.logPaints,
      logSignals: payload.logSignals,
      metadataReconciles: payload.metadataSignals,
      metadataSignals: payload.metadataSignals,
      retainedLogBytes: payload.retainedLogBytes,
      statusDomMutations: payload.indicatorSignals,
    },
    notes: [
      "The simulated open console consumes sixteen streamed lines per display frame through the production paint scheduler.",
      "Metadata flushes pending output synchronously, so completion and failure do not depend on animation-frame delivery.",
      "The sole full-log join is the explicit retained-byte inspection after streaming completes.",
    ],
  };
};

const writableSyncMemory = async (
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  const workload = syncWorkload(options.profile);
  const paths = syncPaths(workload.files);
  const pathIndexes = new Map(paths.map((path, index) => [path, index]));
  const before = collectAfterGc();
  let peak = before;
  let memoryObservations = 0;
  const observeMemory = (): void => {
    memoryObservations += 1;
    if (memoryObservations % 25 === 0) {
      peak = Math.max(peak, collectAfterGc());
    }
  };
  const payload = await (async () => {
    let reads = 0;
    let manifestWrites = 0;
    const uploaded: CloudFile[] = [];
    const checksumWorker = new BenchmarkChecksumWorker(observeMemory);
    const checksums = new ChecksumService(() => checksumWorker);
    const pushDirectory: CloudDirectory = {
      createTime: 0,
      directoryId: "0",
      fileName: "Push",
      id: "push",
      isFolder: true,
      md5: "",
      size: 0,
      updateTime: 0,
    };
    const vault: VaultStore & {
      createDirectory(path: string): Promise<void>;
      listDirectories(path: string): Promise<string[]>;
      move(from: string, to: string): Promise<void>;
    } = {
      createDirectory: async () => undefined,
      delete: async () => undefined,
      exists: async (path) => pathIndexes.has(path),
      getRevision: async () => null,
      listFiles: async () => paths,
      listDirectories: async () => [],
      move: async () => undefined,
      readBinary: async (path) => {
        reads += 1;
        const bytes = generatedBytes(
          workload.bytesPerFile,
          pathIndexes.get(path) ?? 0,
        );
        observeMemory();
        return bytes;
      },
      readText: async () => null,
      writeBinary: async () => undefined,
      writeText: async () => {
        manifestWrites += 1;
        observeMemory();
      },
    };
    const cloud = {
      createDirectory: async () => undefined,
      download: async () => new Uint8Array(),
      getDownloadDescriptor: async () => ({ md5: "", url: "" }),
      listDirectory: async (directoryId: string): Promise<CloudItem[]> =>
        directoryId === "0" ? [pushDirectory] : [...uploaded],
      replaceFile: async (_file: CloudFile, bytes: Uint8Array) => ({
        md5: `replacement-${bytes.byteLength}`,
      }),
      recycleItem: async () => undefined,
      uploadFile: async (
        directoryId: string,
        fileName: string,
        bytes: Uint8Array,
      ) => {
        const checksum = `${fileName}-${bytes.byteLength}`;
        uploaded.push({
          createTime: uploaded.length,
          directoryId,
          fileName,
          id: `uploaded-${uploaded.length}`,
          isFolder: false,
          md5: checksum,
          size: bytes.byteLength,
          updateTime: uploaded.length,
        });
        observeMemory();
        return { md5: checksum };
      },
    };
    const service = new PairSyncService({
      cloud,
      remoteDirectoryId: "push",
      remoteFolder: "Push",
      targetFolder: "Supernote",
      vault,
    });
    const start = performance.now();
    const baseline = emptyPairBaseline();
    baseline.initialized = true;
    const result = await service.reconcile(baseline);
    const durationMs = performance.now() - start;
    const checksumSnapshot = checksums.snapshot();
    checksums.dispose();
    return {
      checksumSnapshot,
      durationMs,
      manifestWrites,
      reads,
      uploaded: result.uploaded.length,
    };
  })();
  const after = collectAfterGc();
  const timings = summarizeTimings([payload.durationMs]);
  const memory = memorySummary(before, peak, after);
  return {
    name: "writable-sync-memory",
    workload: {
      bytesPerFile: workload.bytesPerFile,
      files: workload.files,
      referenceFiles: REFERENCE_SYNC_FILES,
      referenceTotalBytes: REFERENCE_SYNC_BYTES,
      sampledTotalBytes: workload.totalBytes,
    },
    timings,
    memory,
    metrics: {
      maxTaskMs: payload.checksumSnapshot.maxPreparationTaskMs,
      peakWorkingBytes: memory.peakWorkingBytes,
    },
    budgets: [
      {
        metric: "peakWorkingBytes",
        limit: workload.bytesPerFile + 16 * MIB,
        unit: "bytes",
        description: "Largest file plus fixed sync overhead",
      },
      {
        metric: "maxTaskMs",
        limit: 50,
        unit: "ms",
        description: "Maximum checksum transfer-preparation task",
      },
    ],
    counters: {
      manifestWrites: payload.manifestWrites,
      checksumCopies: payload.checksumSnapshot.copiedInputBytes,
      checksumHashes: payload.checksumSnapshot.hashes,
      checksumReturnedBytes: payload.checksumSnapshot.returnedBytes,
      checksumTransferredBytes: payload.checksumSnapshot.transferredInputBytes,
      checksumWorkerCreations: payload.checksumSnapshot.workerCreations,
      maxChecksumInFlight: payload.checksumSnapshot.maxInFlight,
      maxChecksumInFlightBytes: payload.checksumSnapshot.maxInFlightBytes,
      vaultReads: payload.reads,
      uploadedFiles: payload.uploaded,
    },
    notes: [
      `${options.profile === "smoke" ? "Smoke mode samples 20 files" : `${options.profile === "standard" ? "Standard" : "Reference"} mode samples all 500 files`} at ${workload.bytesPerFile} bytes each.`,
      "Checksum input uses production transfer semantics and reports transfer preparation separately from worker hashing.",
    ],
    longTaskSamplesMs: [payload.checksumSnapshot.maxPreparationTaskMs],
  };
};

const manifestVaultIo = async (
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  const files = options.profile === "smoke" ? 20 : REFERENCE_SYNC_FILES;
  const manifestPath = "Supernote/.sync-manifest.json";
  const initialManifest: SyncManifest = {
    version: 1,
    files: {
      unrelated: {
        remoteId: "unrelated",
        directoryId: "other",
        fileName: "unrelated.pdf",
        remotePath: "/Other/unrelated.pdf",
        md5: "unrelated-md5",
        updateTime: 1,
        vaultPath: "Supernote/Other/unrelated.pdf",
        syncedAt: "2026-07-26T00:00:00.000Z",
      },
    },
  };
  let manifestContent = `${JSON.stringify(initialManifest)}\n`;
  let manifestReads = 0;
  let manifestWrites = 0;
  let subtreeScans = 0;
  let binaryReadCalls = 0;
  let manifestBytesRead = 0;
  const vault: VaultStore & {
    createDirectory(path: string): Promise<void>;
    listDirectories(path: string): Promise<string[]>;
    move(from: string, to: string): Promise<void>;
  } = {
    createDirectory: async () => undefined,
    delete: async () => undefined,
    exists: async () => false,
    getRevision: async (path) =>
      path === manifestPath ? manifestContent : null,
    listFiles: async () => {
      subtreeScans += 1;
      return [];
    },
    listDirectories: async () => [],
    move: async () => undefined,
    readBinary: async () => {
      binaryReadCalls += 1;
      return null;
    },
    readText: async (path) => {
      if (path !== manifestPath) {
        return null;
      }
      manifestReads += 1;
      manifestBytesRead += Buffer.byteLength(manifestContent);
      return manifestContent;
    },
    writeBinary: async () => undefined,
    writeText: async (path, content) => {
      if (path === manifestPath) {
        manifestWrites += 1;
        manifestContent = content;
      }
    },
  };
  const pushDirectory: CloudDirectory = {
    createTime: 0,
    directoryId: "0",
    fileName: "Push",
    id: "push",
    isFolder: true,
    md5: "",
    size: 0,
    updateTime: 0,
  };
  const cloud = {
    createDirectory: async () => undefined,
    download: async () => new Uint8Array([1]),
    getDownloadDescriptor: async (fileId: string) => ({
      md5: `${fileId}-md5`,
      url: `benchmark://${fileId}`,
    }),
    listDirectory: async (directoryId: string): Promise<CloudItem[]> =>
      directoryId === "0" ? [pushDirectory] : [],
    replaceFile: async () => ({ md5: "" }),
    recycleItem: async () => undefined,
    uploadFile: async () => ({ md5: "" }),
  };
  const mirror = new SyncService({
    cloud,
    notebooks: {
      open: async () => {
        throw new Error("Manifest benchmark mirrors non-note files");
      },
    },
    targetFolder: "Supernote",
    vault,
  });
  const pair = new PairSyncService({
    cloud,
    remoteDirectoryId: "push",
    remoteFolder: "Push",
    targetFolder: "Supernote",
    vault,
  });
  const before = collectAfterGc();
  const started = performance.now();
  const transaction = await SyncManifestTransaction.open(vault, manifestPath);
  await transaction.run(async (manifest) => {
    for (let index = 0; index < files; index += 1) {
      const id = `mirror-${index}`;
      await mirror.mirrorFile(
        {
          file: {
            createTime: 0,
            directoryId: "mirror",
            fileName: `${id}.pdf`,
            id,
            isFolder: false,
            md5: `${id}-md5`,
            size: 1,
            updateTime: index,
          },
          remotePath: `/Note/${id}.pdf`,
        },
        manifest,
      );
    }
    const baseline = emptyPairBaseline();
    baseline.initialized = true;
    await pair.reconcile(baseline);
  });
  const durationMs = performance.now() - started;
  const peak = collectMemory();
  const after = collectAfterGc();
  const timings = summarizeTimings([durationMs]);
  const persistedManifest = JSON.parse(manifestContent) as SyncManifest;
  return {
    name: "manifest-vault-io",
    workload: {
      mirroredFiles: files,
      writableSyncs: 1,
    },
    timings,
    memory: memorySummary(before, peak, after),
    metrics: {
      manifestReads,
      manifestWrites,
      subtreeScans,
    },
    budgets: [
      {
        metric: "manifestReads",
        limit: 1,
        unit: "count",
        description: "One caller-owned manifest load",
      },
      {
        metric: "manifestWrites",
        limit: 1,
        unit: "count",
        description: "One final manifest save",
      },
      {
        metric: "subtreeScans",
        limit: 1,
        unit: "count",
        description: "One writable-subtree traversal",
      },
    ],
    counters: {
      binaryReadCalls,
      binaryBytesRead: 0,
      manifestBytesRead,
      manifestEntries: Object.keys(persistedManifest.files).length,
      manifestReads,
      manifestWrites,
      subtreeScans,
    },
    notes: [
      "The production manifest transaction wraps all mirror operations and one writable sync.",
      "The unrelated seed entry remains present after the shared final save.",
    ],
  };
};

const exportPreparation = async (
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  const pages = options.profile === "smoke" ? 2 : REFERENCE_NOTEBOOK_PAGES;
  const width = options.profile === "smoke" ? 192 : 1_920;
  const height = options.profile === "smoke" ? 256 : 2_560;
  const nativePageBytes = width * height * 4;
  const rgbEncoderRowBytes = width * 3 + 1;
  const compressedFont = gzipSync(
    readFileSync(
      resolve(
        options.pluginRoot,
        "node_modules/@expo-google-fonts/noto-sans-symbols-2/400Regular/NotoSansSymbols2_400Regular.ttf",
      ),
    ),
    { level: 9 },
  );
  const firstUseChild = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      resolve(options.pluginRoot, "benchmarks/startup-child.cjs"),
      resolve(options.pluginRoot, "main.js"),
      options.platform,
      "pdf-first-use",
    ],
    { encoding: "utf8" },
  );
  if (firstUseChild.status !== 0) {
    throw new Error(
      `Production PDF first-use child failed: ${
        firstUseChild.stderr || firstUseChild.stdout
      }`,
    );
  }
  const firstUse = JSON.parse(firstUseChild.stdout) as StartupChildResult;
  const before = collectAfterGc();
  let peak = before;
  let activeProducerPages = 0;
  let minimumInkPixelsPerPage = Number.POSITIVE_INFINITY;
  let peakInputPngBytes = 0;
  let peakProducerPages = 0;
  const memoryTimeline: number[] = [];
  const payload = await (async () => {
    const inputs = async function* () {
      for (let index = 0; index < pages; index += 1) {
        activeProducerPages += 1;
        peakProducerPages = Math.max(peakProducerPages, activeProducerPages);
        peak = Math.max(peak, collectMemory());
        memoryTimeline.push(peak);
        const pixels = new Uint8ClampedArray(nativePageBytes);
        minimumInkPixelsPerPage = Math.min(
          minimumInkPixelsPerPage,
          fillHandwritingLikePage(pixels, width, height, index + 1),
        );
        peak = Math.max(peak, collectMemory());
        memoryTimeline.push(peak);
        const png = await encodeOpaqueNotebookPng(pixels, width, height);
        peakInputPngBytes = Math.max(peakInputPngBytes, png.byteLength);
        peak = Math.max(peak, collectMemory());
        memoryTimeline.push(peak);
        yield {
          height,
          pageNumber: index + 1,
          pageText: `Generated benchmark page ${index + 1} ◦`,
          png,
          positionedText: [],
          width,
        };
        activeProducerPages -= 1;
        peak = Math.max(peak, collectMemory());
        memoryTimeline.push(peak);
      }
    };
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
    eventLoopDelay.enable();
    await new Promise<void>((resolveDelay) => setImmediate(resolveDelay));
    const start = performance.now();
    const memoryPoll = setInterval(() => {
      const current = collectMemory();
      peak = Math.max(peak, current);
      memoryTimeline.push(current);
    }, 1);
    let output: Uint8Array;
    let fontDecodeMs = 0;
    try {
      const decodeStart = performance.now();
      const font = decodeEmbeddedFont(compressedFont);
      fontDecodeMs = performance.now() - decodeStart;
      await new Promise<void>((resolveDelay) => setImmediate(resolveDelay));
      output = await new PdfLibExporter(font).export(inputs());
    } finally {
      clearInterval(memoryPoll);
    }
    const durationMs = performance.now() - start;
    await new Promise<void>((resolveDelay) => setImmediate(resolveDelay));
    eventLoopDelay.disable();
    peak = Math.max(peak, collectMemory());
    memoryTimeline.push(peak);
    return {
      durationMs,
      fontDecodeMs,
      maxTaskMs: eventLoopDelay.max / 1_000_000,
      outputBytes: output.byteLength,
    };
  })();
  const after = collectAfterGc();
  const timings = summarizeTimings([payload.durationMs]);
  const memory = memorySummary(before, peak, after);
  const peakBeyondFinalPdfBytes = Math.max(
    0,
    memory.peakWorkingBytes - payload.outputBytes,
  );
  const retainedBeyondFinalPdfBytes = Math.max(
    0,
    memory.retainedBytes - payload.outputBytes,
  );
  return {
    name: "export-preparation",
    workload: {
      pages,
      referenceNotebookPages: REFERENCE_NOTEBOOK_PAGES,
      source: "generated-native-rgba-to-worker-png-with-sanitized-ink",
      nativeHeight: height,
      nativeWidth: width,
    },
    timings,
    memory,
    metrics: {
      maxTaskMs: payload.maxTaskMs,
      peakBeyondFinalPdfBytes,
      peakProducerPages,
      pdfFirstUseMaxTaskMs: firstUse.pdfFirstUseMaxTaskMs,
      preparationMs: timings.p95Ms,
      retainedBeyondFinalPdfBytes,
    },
    budgets: [
      {
        metric: "preparationMs",
        limit: platformLimit(options.platform, 10_000, 20_000),
        unit: "ms",
        description: "Twenty-page native export preparation",
      },
      {
        metric: "maxTaskMs",
        limit: 100,
        unit: "ms",
        description: "Maximum PDF-worker event-loop delay during preparation",
      },
      {
        metric: "pdfFirstUseMaxTaskMs",
        limit: 50,
        unit: "ms",
        description:
          "Production-bundle PDF client, inline-worker construction, and first page transport task",
      },
      {
        metric: "peakProducerPages",
        limit: 1,
        unit: "count",
        description: "Sequential PDF input ownership",
      },
      {
        metric: "peakBeyondFinalPdfBytes",
        limit: nativePageBytes + rgbEncoderRowBytes * 2 + 64 * MIB,
        unit: "bytes",
        description:
          "One native RGBA page, two RGB encoder rows, and bounded overhead beyond final PDF bytes",
      },
      {
        metric: "retainedBeyondFinalPdfBytes",
        limit: 32 * MIB,
        unit: "bytes",
        description: "Retained memory beyond the final PDF representation",
      },
    ],
    counters: {
      compressedFontBytes: compressedFont.byteLength,
      fontDecodeMs: payload.fontDecodeMs,
      memoryTimelineSamples: memoryTimeline.length,
      minimumInkPixelsPerPage,
      nativePageBytes,
      outputBytes: payload.outputBytes,
      peakInputPngBytes,
      peakBeyondFinalPdfBytes,
      peakProducerPages,
      pdfFirstUseMaxTaskMs: firstUse.pdfFirstUseMaxTaskMs,
      pdfFirstUseMs: firstUse.pdfFirstUseMs,
      retainedBeyondFinalPdfBytes,
    },
    notes: [
      "The timed worker-equivalent path decodes the build-compressed font, creates a distinct handwriting-like native RGBA page, converts it to an opaque RGB PNG in bounded chunks, and embeds it before producing the next page.",
      "A separate isolated child loads the production bundle and measures lazy PDF-client import, inline-worker Blob construction, and a 256 KiB first-page transport through a protocol stub; browser worker readiness remains part of real-device validation.",
      "Memory is polled throughout encode/embed/save, sampled around every page handoff, and sampled after forced GC; final PDF bytes are separated from bounded working and retained memory.",
    ],
    longTaskSamplesMs: [payload.maxTaskMs],
  };
};

const exportTranscriptionPipeline = async (
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  const pages = options.profile === "smoke" ? 2 : REFERENCE_NOTEBOOK_PAGES;
  const pageBytes = options.profile === "smoke" ? 16 * 1024 : 512 * 1024;
  let activeRenderCalls = 0;
  let peakConcurrentRenderCalls = 0;
  let producerRenders = 0;
  let documentRequests = 0;
  let finalRequestBytes = 0;
  const before = collectAfterGc();
  let peak = before;
  const service = new ApiOcrService({
    baseUrl: "https://benchmark.invalid/v1",
    apiKey: "benchmark",
    model: "benchmark-vision",
    extraInstructions: "",
    documentRequestByteLimit: platformLimit(
      options.platform,
      DESKTOP_DOCUMENT_REQUEST_BYTE_LIMIT,
      MOBILE_DOCUMENT_REQUEST_BYTE_LIMIT,
    ),
    request: async (request) => {
      documentRequests += 1;
      finalRequestBytes = Buffer.byteLength(request.body);
      peak = Math.max(peak, collectMemory());
      return {
        status: 200,
        json: {
          choices: [
            { message: { content: "# Generated benchmark transcript" } },
          ],
        },
      };
    },
  });
  const started = performance.now();
  const result = await service.transcribe({
    mode: "document",
    note: "generated-reference.note",
    pages: {
      pageNumbers: Array.from({ length: pages }, (_, index) => index + 1),
      render: async (pageNumber) => {
        activeRenderCalls += 1;
        peakConcurrentRenderCalls = Math.max(
          peakConcurrentRenderCalls,
          activeRenderCalls,
        );
        producerRenders += 1;
        const image = generatedBytes(pageBytes, pageNumber);
        peak = Math.max(peak, collectMemory());
        activeRenderCalls -= 1;
        return image;
      },
    },
  });
  const durationMs = performance.now() - started;
  if (result.errors.length > 0 || !result.documentText) {
    throw new Error(
      `Transcription pipeline benchmark failed: ${result.errors.join("; ")}`,
    );
  }
  const documentAfterGc = collectAfterGc();
  const documentMemory = memorySummary(before, peak, documentAfterGc);
  let pageModePeak = documentAfterGc;
  const pageModeConcurrency = 3;
  let pageModeRequests = 0;
  let pageModeRenders = 0;
  let peakPreparedPageModePages = 0;
  let maxPageModeRequestBytes = 0;
  const pageModeService = new ApiOcrService({
    baseUrl: "https://benchmark.invalid/v1",
    apiKey: "benchmark",
    model: "benchmark-vision",
    extraInstructions: "",
    concurrency: pageModeConcurrency,
    request: async (request) => {
      pageModeRequests += 1;
      maxPageModeRequestBytes = Math.max(
        maxPageModeRequestBytes,
        Buffer.byteLength(request.body),
      );
      pageModePeak = Math.max(pageModePeak, collectMemory());
      return {
        status: 200,
        json: { choices: [{ message: { content: "page transcript" } }] },
      };
    },
  });
  let remainingPageNumbers = Array.from(
    { length: pages },
    (_, index) => index + 1,
  );
  while (remainingPageNumbers.length > 0) {
    const rendersBeforeBatch = pageModeRenders;
    const prepared = await pageModeService.prepare({
      mode: "page",
      note: "generated-reference.note",
      pages: {
        pageNumbers: remainingPageNumbers,
        render: async (pageNumber) => {
          pageModeRenders += 1;
          const image = generatedBytes(pageBytes, pageNumber);
          pageModePeak = Math.max(pageModePeak, collectMemory());
          return image;
        },
      },
    });
    peakPreparedPageModePages = Math.max(
      peakPreparedPageModePages,
      pageModeRenders - rendersBeforeBatch,
    );
    await prepared.transcribe();
    remainingPageNumbers = [...prepared.remainingPageNumbers];
  }
  const after = collectAfterGc();
  const timings = summarizeTimings([durationMs]);
  const memory = memorySummary(before, Math.max(peak, pageModePeak), after);
  const pageModeMemory = memorySummary(documentAfterGc, pageModePeak, after);
  const boundedTransientWorkingBytes =
    pageBytes + BASE64_CHUNK_BYTES + BASE64_ENCODED_CHUNK_BYTES;
  return {
    name: "export-transcription-pipeline",
    workload: {
      pages,
      pageBytes,
      mode: "document",
      platform: options.platform,
    },
    timings,
    memory,
    metrics: {
      documentRequests,
      finalRequestBytes,
      pageModeRequests,
      peakPreparedPageModePages,
      peakConcurrentRenderCalls,
      preparationMs: timings.p95Ms,
    },
    budgets: [
      {
        metric: "preparationMs",
        limit: platformLimit(options.platform, 3_000, 6_000),
        unit: "ms",
        description:
          "Twenty-page transcription payload preparation excluding network and model time",
      },
      {
        metric: "peakConcurrentRenderCalls",
        limit: 1,
        unit: "count",
        description:
          "Document preparation invokes the render producer sequentially",
      },
      {
        metric: "peakPreparedPageModePages",
        limit: pageModeConcurrency,
        unit: "count",
        description:
          "Page mode prepares no more than configured request concurrency",
      },
      {
        metric: "pageModeRequests",
        limit: pages,
        unit: "count",
        description: "Page mode sends one isolated request per page",
      },
      {
        metric: "documentRequests",
        limit: 1,
        unit: "count",
        description: "Document mode remains one logical request",
      },
      {
        metric: "finalRequestBytes",
        limit: platformLimit(
          options.platform,
          DESKTOP_DOCUMENT_REQUEST_BYTE_LIMIT,
          MOBILE_DOCUMENT_REQUEST_BYTE_LIMIT,
        ),
        unit: "bytes",
        description: "Whole-document API request stays within platform cap",
      },
    ],
    counters: {
      boundedTransientWorkingBytes,
      documentRequests,
      finalRequestBytes,
      documentMeasuredPeakProcessWorkingBytes: documentMemory.peakWorkingBytes,
      pageModeMeasuredPeakProcessWorkingBytes: pageModeMemory.peakWorkingBytes,
      pageModeRenders,
      pageModeRequests,
      maxPageModeRequestBytes,
      pageModePreparedImageBytes: peakPreparedPageModePages * pageBytes,
      pageImageBytes: pageBytes,
      peakPreparedPageModePages,
      peakConcurrentRenderCalls,
      producerRenders,
    },
    notes: [
      "The production API adapter consumes the lazy page source and prepares one unsplit document request.",
      "The same run drives page mode through bounded prepare/execute batches with one request per page.",
      "Final request bytes, document/page-mode measured process working bytes, and code-bounded transients are reported separately.",
      "The request executor returns immediately, excluding network and model inference time.",
    ],
    longTaskSamplesMs: [],
  };
};

export const scenarioNames = [
  "cold-activation",
  "page-rendering",
  "viewer-interaction",
  "run-log-streaming",
  "writable-sync-memory",
  "manifest-vault-io",
  "export-preparation",
  "export-transcription-pipeline",
] as const;

export type ScenarioName = (typeof scenarioNames)[number];

export const runScenario = async (
  name: ScenarioName,
  options: ScenarioOptions,
): Promise<ScenarioObservation> => {
  switch (name) {
    case "cold-activation":
      return startup(options);
    case "page-rendering":
      return options.privateNote
        ? privateNoteRendering(options)
        : generatedPageRendering(options);
    case "viewer-interaction":
      return viewerInteraction(options);
    case "run-log-streaming":
      return runLogStreaming();
    case "writable-sync-memory":
      return writableSyncMemory(options);
    case "manifest-vault-io":
      return manifestVaultIo(options);
    case "export-preparation":
      return exportPreparation(options);
    case "export-transcription-pipeline":
      return exportTranscriptionPipeline(options);
  }
};
