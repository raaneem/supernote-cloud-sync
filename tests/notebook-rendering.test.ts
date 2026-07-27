import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { decode } from "fast-png";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeNotebookImageCodec } from "../benchmarks/node-notebook-image-codec";
import type { NotebookImageCodec } from "../src/note/notebook-image-codec";
import { NotebookService } from "../src/note/notebook-service";
import { NotebookWorkerRuntime } from "../src/note/notebook-worker-runtime";
import { sanitizedWhiteNote } from "./fixtures/sanitized-note";
import { NotebookRuntimeWorker } from "./notebook-runtime-worker";

const fixturePath = process.env.SUPERNOTE_REAL_NOTE_FIXTURE ?? "";
const journalFixturePath = process.env.SUPERNOTE_JOURNAL_NOTE_FIXTURE ?? "";

const minimalNote = (header: string): Uint8Array => {
  const encoder = new TextEncoder();
  const signature = encoder.encode("noteSN_FILE_VER_20260016");
  const headerContent = encoder.encode(header);
  const footerContent = encoder.encode("<FILE_FEATURE:24>");
  const headerAddress = signature.length;
  const footerAddress = headerAddress + 4 + headerContent.length;
  const bytes = new Uint8Array(footerAddress + 4 + footerContent.length + 4);
  const view = new DataView(bytes.buffer);
  bytes.set(signature);
  view.setUint32(headerAddress, headerContent.length, true);
  bytes.set(headerContent, headerAddress + 4);
  view.setUint32(footerAddress, footerContent.length, true);
  bytes.set(footerContent, footerAddress + 4);
  view.setUint32(bytes.length - 4, footerAddress, true);
  return bytes;
};

const service = (imageCodec?: NotebookImageCodec): NotebookService =>
  new NotebookService({
    createWorker: () =>
      new NotebookRuntimeWorker(imageCodec) as unknown as Worker,
  });

describe("worker-owned notebook rendering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a committed sanitized notebook generator pixel-identically", async () => {
    const notebooks = service();
    const lease = await notebooks.open({
      path: "sanitized.note",
      revision: "sanitized-v1",
      bytes: sanitizedWhiteNote(),
    });

    const rendered = await lease.renderPng(1, 1);
    const decoded = decode(rendered.png);

    expect(lease.descriptor).toMatchObject({
      pageCount: 1,
      devicePage: 1,
    });
    expect(decoded).toMatchObject({
      width: 1920,
      height: 2560,
      channels: 4,
      depth: 8,
    });
    expect(createHash("sha256").update(decoded.data).digest("hex")).toBe(
      "3a5f3f1fe69e6e7b8c3f0870527d47aff21377c76c3118103a84a8baed65d2cd",
    );
    lease.close();
    notebooks.dispose();
  });

  it("keeps display and export pixels faithful for presentation-layer theming", async () => {
    const displayPixels: number[] = [];
    const imageCodec = new NodeNotebookImageCodec(async (page) => {
      displayPixels.push(...page.pixels.slice(0, 4));
      return {
        width: page.width,
        height: page.height,
        close: vi.fn(),
      } as unknown as ImageBitmap;
    });
    const notebooks = service(imageCodec);
    const lease = await notebooks.open({
      path: "sanitized.note",
      revision: "faithful-display",
      bytes: sanitizedWhiteNote(),
    });
    lease.updateView({
      visible: true,
      currentPage: 1,
      gridOpen: false,
    });

    (await lease.bitmap(1)).release();
    const exported = decode((await lease.renderPng(1, 0.1)).png);

    expect(displayPixels).toEqual([255, 255, 255, 255]);
    expect([...exported.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    lease.close();
    notebooks.dispose();
  });

  it("does not retain decoded page buffers between worker renders", async () => {
    const runtime = new NotebookWorkerRuntime(
      new NodeNotebookImageCodec(async (page) => ({
        width: page.width,
        height: page.height,
        close: vi.fn(),
      })),
    );
    const bytes = sanitizedWhiteNote();
    const opened = await runtime.handle({
      type: "open",
      id: 1,
      sessionId: 1,
      generation: 1,
      path: "sanitized.note",
      revision: "resource-budget",
      bytes: bytes.buffer,
    });
    expect(opened?.type).toBe("opened");
    expect(opened).toMatchObject({
      pageWidth: 1_920,
      pageHeight: 2_560,
      pagePixelBytes: 19_660_800,
    });

    await runtime.handle({
      type: "render",
      id: 2,
      sessionId: 1,
      generation: 1,
      pageNumber: 1,
      output: "bitmap",
    });

    expect(runtime.snapshot()).toMatchObject({
      activeSessions: 1,
      inFlightRenders: 0,
      retainedDecodedBytes: 0,
      retainedSourceBytes: bytes.byteLength,
      retainedParsedBytes: expect.any(Number),
    });
    expect(runtime.snapshot().retainedParsedBytes).toBeGreaterThan(0);
  });

  it("closes a rendered bitmap when worker cancellation wins", async () => {
    let releaseBitmap!: (bitmap: ImageBitmap) => void;
    const renderedBitmap = {
      width: 1_920,
      height: 2_560,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const bitmapReady = new Promise<ImageBitmap>((resolve) => {
      releaseBitmap = resolve;
    });
    const createBitmap = vi.fn(() => bitmapReady);
    const runtime = new NotebookWorkerRuntime({
      decodeBitmap: vi.fn(),
      resize: vi.fn(),
      encodePng: vi.fn(),
      createBitmap,
    });
    const bytes = sanitizedWhiteNote();
    await runtime.handle({
      type: "open",
      id: 1,
      sessionId: 1,
      generation: 1,
      path: "sanitized.note",
      revision: "cancel-render",
      bytes: bytes.buffer,
    });
    const rendering = runtime.handle({
      type: "render",
      id: 2,
      sessionId: 1,
      generation: 1,
      pageNumber: 1,
      output: "bitmap",
    });

    await vi.waitFor(() => {
      expect(runtime.snapshot().inFlightRenders).toBe(1);
      expect(createBitmap).toHaveBeenCalledTimes(1);
    });
    await runtime.handle({
      type: "cancel",
      id: 2,
      sessionId: 1,
      generation: 1,
    });
    releaseBitmap(renderedBitmap);

    await expect(rendering).resolves.toMatchObject({
      type: "error",
      id: 2,
      errorKind: "cancelled",
      message: "Supernote render cancelled",
    });
    expect(renderedBitmap.close).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().inFlightRenders).toBe(0);
  });

  it.skipIf(!existsSync(fixturePath))(
    "keeps native PNG export pixels identical",
    async () => {
      const notebooks = service();
      const lease = await notebooks.open({
        path: "fixture.note",
        revision: "fixture-v1",
        bytes: readFileSync(fixturePath),
      });

      const first = await lease.renderPng(1, 1);
      const second = await lease.renderPng(1, 1);
      const fingerprints = lease.descriptor.pages.map(
        (page) => page.fingerprint,
      );

      expect(lease.descriptor.pageCount).toBe(1);
      expect(fingerprints[0]).toMatch(/^[a-f0-9]{32}$/);
      expect(first).toMatchObject({ width: 1920, height: 2560 });
      expect([...first.png.slice(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      expect(second.png).toEqual(first.png);
      const decoded = decode(first.png);
      expect(decoded).toMatchObject({
        width: 1920,
        height: 2560,
        channels: 4,
        depth: 8,
      });
      expect(createHash("sha256").update(decoded.data).digest("hex")).toBe(
        "c37246557e96387b8999d7290157941b5a2f35cc167dd72d2469961a581a9b28",
      );

      lease.close();
      notebooks.dispose();
    },
  );

  it.skipIf(!existsSync(fixturePath))(
    "shares display and thumbnail bitmaps within one source session",
    async () => {
      const createBitmap = vi.fn(async (page) => ({
        width: page.width,
        height: page.height,
        close: vi.fn(),
      }));
      const notebooks = service(new NodeNotebookImageCodec(createBitmap));
      const lease = await notebooks.open({
        path: "fixture.note",
        revision: "fixture-v1",
        bytes: readFileSync(fixturePath),
      });

      const first = await lease.bitmap(1);
      const second = await lease.bitmap(1);
      const thumbnail = await lease.thumbnailBitmap(1, 240);
      const cachedThumbnail = await lease.thumbnailBitmap(1, 240);

      expect(first).not.toBe(second);
      expect(first.bitmap).toBe(second.bitmap);
      expect(thumbnail.bitmap).toMatchObject({ width: 240, height: 320 });
      expect(thumbnail).not.toBe(cachedThumbnail);
      expect(thumbnail.bitmap).toBe(cachedThumbnail.bitmap);
      expect(createBitmap).toHaveBeenCalledTimes(2);

      first.release();
      second.release();
      thumbnail.release();
      cachedThumbnail.release();
      lease.close();

      expect(first.bitmap.close).toHaveBeenCalledTimes(1);
      expect(thumbnail.bitmap.close).toHaveBeenCalledTimes(1);
      notebooks.dispose();
    },
  );

  it("returns no device page when the header omits it", async () => {
    const notebooks = service();
    const lease = await notebooks.open({
      path: "minimal.note",
      revision: "empty-header",
      bytes: minimalNote(""),
    });

    expect(lease.descriptor.devicePage).toBeNull();
    lease.close();
    notebooks.dispose();
  });

  it("returns no device page for zero or unparseable values", async () => {
    const notebooks = service();
    for (const [revision, header] of [
      ["zero", "<FINALOPERATION_PAGE:0>"],
      ["invalid", "<FINALOPERATION_PAGE:not-a-page>"],
    ] as const) {
      const lease = await notebooks.open({
        path: "minimal.note",
        revision,
        bytes: minimalNote(header),
      });
      expect(lease.descriptor.devicePage).toBeNull();
      lease.close();
    }
    notebooks.dispose();
  });

  it.skipIf(!existsSync(journalFixturePath))(
    "reads the device's last page from a real journal note",
    async () => {
      const notebooks = service();
      const lease = await notebooks.open({
        path: "journal.note",
        revision: "journal-v1",
        bytes: readFileSync(journalFixturePath),
      });

      expect(lease.descriptor.devicePage).toBe(8);
      lease.close();
      notebooks.dispose();
    },
  );
});
