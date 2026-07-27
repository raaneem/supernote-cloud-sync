import { gzipSync } from "node:zlib";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";

import {
  WorkerMarkdownPdfRenderer,
  WorkerPdfExporter,
} from "../src/export/pdf-worker-client";
import type {
  PdfWorkerRequest,
  PdfWorkerResponse,
} from "../src/export/pdf-worker-protocol";
import {
  exactBuffer,
  PdfWorkerRuntime,
} from "../src/export/pdf-worker-runtime";
import { encodeOpaqueNotebookPng } from "../src/note/notebook-png";
import { pdfFontBytes } from "./pdf-font-fixture";

class LoopbackPdfWorker {
  onmessage: ((event: MessageEvent<PdfWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly terminate = vi.fn();
  private readonly runtime = new PdfWorkerRuntime(
    (response) => {
      queueMicrotask(() =>
        this.onmessage?.({ data: response } as MessageEvent<PdfWorkerResponse>),
      );
    },
    {
      symbols: gzipSync(pdfFontBytes),
      regular: gzipSync(pdfFontBytes),
      bold: gzipSync(pdfFontBytes),
    },
  );

  postMessage(request: PdfWorkerRequest): void {
    queueMicrotask(() => this.runtime.handle(request));
  }
}

describe("WorkerPdfExporter", () => {
  it("transfers exact PDF buffers without cloning", () => {
    const exact = new Uint8Array([1, 2, 3]);
    expect(exactBuffer(exact)).toBe(exact.buffer);

    const backing = new Uint8Array([0, 1, 2, 3]);
    const sliced = backing.subarray(1, 3);
    const transferred = exactBuffer(sliced);
    expect(transferred).not.toBe(backing.buffer);
    expect([...new Uint8Array(transferred)]).toEqual([1, 2]);
  });

  it("streams one page at a time and returns selectable text", async () => {
    const worker = new LoopbackPdfWorker();
    const exporter = new WorkerPdfExporter(() => worker as unknown as Worker);
    let activePages = 0;
    let peakPages = 0;
    const pages = async function* () {
      for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
        activePages += 1;
        peakPages = Math.max(peakPages, activePages);
        const png = await encodeOpaqueNotebookPng(
          Uint8ClampedArray.from([255, 255, 255, 255]),
          1,
          1,
        );
        yield {
          pageNumber,
          png,
          width: 1_920,
          height: 2_560,
          pageText: `Worker page ${pageNumber}`,
          positionedText: [],
        };
        activePages -= 1;
      }
    };

    const pdf = await exporter.export(pages());
    const loaded = await getDocument({ data: pdf }).promise;
    expect(loaded.numPages).toBe(2);
    const text = await (await loaded.getPage(2)).getTextContent();
    expect(
      text.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    ).toContain("Worker page 2");
    expect(peakPages).toBe(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await loaded.destroy();
  });

  it("renders Markdown with worker-owned fonts", async () => {
    const worker = new LoopbackPdfWorker();
    const renderer = new WorkerMarkdownPdfRenderer(
      () => worker as unknown as Worker,
    );

    const pdf = await renderer.render("# Worker Markdown");
    const loaded = await getDocument({ data: pdf }).promise;
    const text = await (await loaded.getPage(1)).getTextContent();
    expect(
      text.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " "),
    ).toContain("Worker Markdown");
    expect(worker.terminate).toHaveBeenCalledOnce();
    await loaded.destroy();
  });
});
