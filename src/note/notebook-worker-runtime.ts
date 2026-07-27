import { SupernoteX } from "supernote-typescript/lib/parsing";
import SparkMD5 from "spark-md5";

import {
  BrowserNotebookImageCodec,
  type NotebookImageCodec,
} from "./notebook-image-codec";
import {
  rasterizeNotebookPage,
  type RasterizedNotebookPage,
} from "./notebook-rasterizer";
import type {
  NotebookWorkerRequest,
  NotebookWorkerResponse,
} from "./notebook-worker-protocol";
import type {
  NotebookDescriptor,
  NotebookPageDescriptor,
  RenderedNotebookPage,
} from "./notebook-types";
import { recognitionSpansForElements } from "./recognition";
import { extractTextBoxes } from "./textboxes";

interface WorkerSession {
  readonly generation: number;
  readonly note: SupernoteX;
  readonly sourceBytes: number;
  readonly parsedMetadataBytes: number;
}

export interface NotebookWorkerSnapshot {
  activeSessions: number;
  parseCount: number;
  renderCount: number;
  inFlightRenders: number;
  retainedDecodedBytes: number;
  retainedSourceBytes: number;
  retainedParsedBytes: number;
}

const OBJECT_HEADER_BYTES = 32;
const ARRAY_SLOT_BYTES = 8;
const PROPERTY_SLOT_BYTES = 16;
const STRING_HEADER_BYTES = 16;

const estimateParsedMetadataBytes = (
  root: object,
  sourceBuffer: ArrayBuffer,
): number => {
  const seenObjects = new WeakSet<object>();
  const seenBuffers = new Set<ArrayBufferLike>([sourceBuffer]);

  const estimate = (value: unknown): number => {
    if (value === null || value === undefined) {
      return 0;
    }
    if (typeof value === "string") {
      return STRING_HEADER_BYTES + value.length * 2;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return 8;
    }
    if (typeof value === "boolean") {
      return 4;
    }
    if (typeof value !== "object") {
      return 0;
    }
    if (ArrayBuffer.isView(value)) {
      if (seenBuffers.has(value.buffer)) {
        return OBJECT_HEADER_BYTES;
      }
      seenBuffers.add(value.buffer);
      return OBJECT_HEADER_BYTES + value.byteLength;
    }
    if (value instanceof ArrayBuffer) {
      if (seenBuffers.has(value)) {
        return 0;
      }
      seenBuffers.add(value);
      return value.byteLength;
    }
    if (seenObjects.has(value)) {
      return 0;
    }
    seenObjects.add(value);
    if (Array.isArray(value)) {
      return (
        OBJECT_HEADER_BYTES +
        value.length * ARRAY_SLOT_BYTES +
        value.reduce((total, item) => total + estimate(item), 0)
      );
    }
    return Object.entries(value).reduce(
      (total, [key, item]) =>
        total +
        PROPERTY_SLOT_BYTES +
        STRING_HEADER_BYTES +
        key.length * 2 +
        estimate(item),
      OBJECT_HEADER_BYTES,
    );
  };

  return estimate(root);
};

const pageFingerprint = (page: SupernoteX["pages"][number]): string => {
  const layers = [
    page.MAINLAYER,
    page.LAYER1,
    page.LAYER2,
    page.LAYER3,
    page.BGLAYER,
  ].map((layer) => ({
    type: layer.LAYERTYPE,
    protocol: layer.LAYERPROTOCOL,
    name: layer.LAYERNAME,
    bitmap: layer.bitmapBuffer
      ? SparkMD5.ArrayBuffer.hash(Uint8Array.from(layer.bitmapBuffer).buffer)
      : null,
  }));
  return SparkMD5.hash(
    JSON.stringify({
      pageStyle: page.PAGESTYLE,
      pageStyleMd5: page.PAGESTYLEMD5,
      layerSwitch: page.LAYERSWITCH,
      layerSequence: page.LAYERSEQ,
      layerInfo: page.LAYERINFO,
      layers,
      totalPath: page.totalPathBuffer
        ? SparkMD5.ArrayBuffer.hash(
            Uint8Array.from(page.totalPathBuffer).buffer,
          )
        : null,
      recognition: page.recognitionElements,
    }),
  );
};

const devicePage = (note: SupernoteX): number | null => {
  const raw = (note.header as unknown as Record<string, unknown>)[
    "FINALOPERATION_PAGE"
  ];
  const page = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(page) && page > 0 ? page : null;
};

const descriptorFor = (
  request: Extract<NotebookWorkerRequest, { type: "open" }>,
  note: SupernoteX,
  bytes: Uint8Array,
): NotebookDescriptor => ({
  path: request.path,
  revision: request.revision,
  pageCount: note.pages.length,
  devicePage: devicePage(note),
  pages: note.pages.map(
    (page, index): NotebookPageDescriptor => ({
      pageNumber: index + 1,
      fingerprint: pageFingerprint(page),
      hasBitmapBackground: page.PAGESTYLE.startsWith("user_"),
      ...(page.PAGESTYLE.startsWith("user_") &&
      page.BGLAYER.bitmapBuffer?.byteLength
        ? { bitmapBackgroundBytes: page.BGLAYER.bitmapBuffer.byteLength }
        : {}),
      recognitionText: page.text?.trim() || null,
      recognitionSpans: recognitionSpansForElements(
        page.recognitionElements ?? [],
      ),
    }),
  ),
  textBoxes: extractTextBoxes(bytes),
});

class NotebookWorkerRenderCancelledError extends Error {
  constructor() {
    super("Supernote render cancelled");
    this.name = "NotebookWorkerRenderCancelledError";
  }
}

const errorResponse = (
  request: Extract<NotebookWorkerRequest, { type: "open" | "render" }>,
  error: unknown,
): NotebookWorkerResponse => ({
  type: "error",
  id: request.id,
  sessionId: request.sessionId,
  generation: request.generation,
  message:
    error instanceof Error
      ? error.message
      : "Could not process Supernote notebook",
  ...(error instanceof NotebookWorkerRenderCancelledError
    ? { errorKind: "cancelled" as const }
    : {}),
});

export class NotebookWorkerRuntime {
  private readonly sessions = new Map<number, WorkerSession>();
  private readonly activeRenderIds = new Set<number>();
  private readonly cancelledRenders = new Set<number>();
  private parseCount = 0;
  private renderCount = 0;
  private inFlightRenders = 0;

  constructor(
    private readonly imageCodec: NotebookImageCodec = new BrowserNotebookImageCodec(),
  ) {}

  snapshot(): NotebookWorkerSnapshot {
    return {
      activeSessions: this.sessions.size,
      parseCount: this.parseCount,
      renderCount: this.renderCount,
      inFlightRenders: this.inFlightRenders,
      retainedDecodedBytes: 0,
      retainedSourceBytes: [...this.sessions.values()].reduce(
        (total, session) => total + session.sourceBytes,
        0,
      ),
      retainedParsedBytes: [...this.sessions.values()].reduce(
        (total, session) => total + session.parsedMetadataBytes,
        0,
      ),
    };
  }

  async handle(
    request: NotebookWorkerRequest,
  ): Promise<NotebookWorkerResponse | null> {
    if (request.type === "close") {
      const session = this.sessions.get(request.sessionId);
      if (session?.generation === request.generation) {
        this.sessions.delete(request.sessionId);
      }
      return null;
    }
    if (request.type === "cancel") {
      if (this.activeRenderIds.has(request.id)) {
        this.cancelledRenders.add(request.id);
      }
      return null;
    }

    try {
      if (request.type === "open") {
        return this.open(request);
      }
      return await this.render(request);
    } catch (error) {
      return errorResponse(request, error);
    }
  }

  private open(
    request: Extract<NotebookWorkerRequest, { type: "open" }>,
  ): NotebookWorkerResponse {
    const bytes = new Uint8Array(request.bytes);
    const note = new SupernoteX(bytes);
    const parsedMetadataBytes = estimateParsedMetadataBytes(
      note,
      request.bytes,
    );
    const descriptor = descriptorFor(request, note, bytes);
    const descriptorMetadataBytes = estimateParsedMetadataBytes(
      descriptor,
      request.bytes,
    );
    this.parseCount += 1;
    this.sessions.set(request.sessionId, {
      generation: request.generation,
      note,
      sourceBytes: bytes.byteLength,
      parsedMetadataBytes,
    });
    return {
      type: "opened",
      id: request.id,
      sessionId: request.sessionId,
      generation: request.generation,
      pagePixelBytes: note.pageWidth * note.pageHeight * 4,
      pageWidth: note.pageWidth,
      pageHeight: note.pageHeight,
      parsedMetadataBytes,
      descriptorMetadataBytes,
      descriptor,
    };
  }

  private async render(
    request: Extract<NotebookWorkerRequest, { type: "render" }>,
  ): Promise<NotebookWorkerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session || session.generation !== request.generation) {
      throw new Error("Supernote notebook session changed");
    }
    if (
      !Number.isInteger(request.pageNumber) ||
      request.pageNumber < 1 ||
      request.pageNumber > session.note.pages.length
    ) {
      throw new Error(
        `Page ${request.pageNumber} is not available; notebook has ${session.note.pages.length} pages`,
      );
    }

    this.inFlightRenders += 1;
    this.activeRenderIds.add(request.id);
    try {
      this.throwIfCancelled(request.id);
      const decoded = await this.decode(session, request.pageNumber);
      this.throwIfCancelled(request.id);
      this.renderCount += 1;
      if (this.sessions.get(request.sessionId) !== session) {
        throw new Error("Supernote notebook session changed");
      }
      if (request.output === "bitmap") {
        const resized =
          request.maxWidth && request.maxWidth < decoded.width
            ? await this.imageCodec.resize(decoded, request.maxWidth)
            : decoded;
        const bitmap = await this.imageCodec.createBitmap(resized);
        if (
          this.cancelledRenders.has(request.id) ||
          this.sessions.get(request.sessionId) !== session
        ) {
          bitmap.close();
          this.throwIfCancelled(request.id);
          throw new Error("Supernote notebook session changed");
        }
        return {
          type: "rendered",
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          output: "bitmap",
          bitmap,
        };
      }

      const page = await this.renderPng(
        decoded,
        request.scale,
        request.encoding,
      );
      this.throwIfCancelled(request.id);
      return {
        type: "rendered",
        id: request.id,
        sessionId: request.sessionId,
        generation: request.generation,
        output: "png",
        page,
      };
    } finally {
      this.inFlightRenders -= 1;
      this.activeRenderIds.delete(request.id);
      this.cancelledRenders.delete(request.id);
    }
  }

  private throwIfCancelled(requestId: number): void {
    if (this.cancelledRenders.has(requestId)) {
      throw new NotebookWorkerRenderCancelledError();
    }
  }

  private async decode(
    session: WorkerSession,
    pageNumber: number,
  ): Promise<RasterizedNotebookPage> {
    const page = session.note.pages[pageNumber - 1]!;
    return rasterizeNotebookPage(
      session.note.pageWidth,
      session.note.pageHeight,
      {
        pageStyle: page.PAGESTYLE,
        layerSequence: page.LAYERSEQ,
        layers: Object.fromEntries(
          page.LAYERSEQ.map((name) => [name, page[name]]),
        ),
      },
      (bytes) => this.imageCodec.decodeBitmap(bytes),
    );
  }

  private async renderPng(
    decoded: RasterizedNotebookPage,
    scale: number,
    encoding?: "opaque-rgb",
  ): Promise<RenderedNotebookPage> {
    const output =
      scale === 1
        ? decoded
        : await this.imageCodec.resize(
            decoded,
            Math.max(1, Math.round(decoded.width * scale)),
          );
    return {
      png:
        encoding === "opaque-rgb" && this.imageCodec.encodeOpaquePng
          ? await this.imageCodec.encodeOpaquePng(output)
          : await this.imageCodec.encodePng(output),
      width: output.width,
      height: output.height,
    };
  }
}
