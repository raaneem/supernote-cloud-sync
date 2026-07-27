import { PDFDocument } from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfLibExporter } from "../src/export/pdf-export";
import type { PdfExportPage } from "../src/export/pdf-export";
import { BrowserNotebookImageCodec } from "../src/note/notebook-image-codec";
import { encodeOpaqueNotebookPng } from "../src/note/notebook-png";
import { pdfFontBytes } from "./pdf-font-fixture";

const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8S0WQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const pdfPages = async function* (
  pages: readonly PdfExportPage[],
): AsyncIterable<PdfExportPage> {
  yield* pages;
};

describe("PdfLibExporter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves worker-produced RGB pixels through direct PDF embedding", async () => {
    const png = await encodeOpaqueNotebookPng(
      Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]),
      2,
      1,
    );
    const bytes = await new PdfLibExporter(pdfFontBytes).export([
      {
        pageNumber: 1,
        png,
        width: 2,
        height: 1,
        pageText: null,
        positionedText: [],
      },
    ]);

    const loaded = await getDocument({ data: bytes }).promise;
    const page = await loaded.getPage(1);
    const operators = await page.getOperatorList();
    const imageIndex = operators.fnArray.indexOf(OPS.paintImageXObject);
    const imageName = operators.argsArray[imageIndex]?.[0] as string;
    const image = page.objs.get(imageName) as {
      data: Uint8Array;
      height: number;
      width: number;
    };
    expect(image).toMatchObject({ height: 1, width: 2 });
    expect([...image.data]).toEqual([255, 0, 0, 0, 0, 255]);
    await loaded.destroy();
  });

  it("creates native-ratio pages with selectable invisible text", async () => {
    const bytes = await new PdfLibExporter(pdfFontBytes).export(
      pdfPages([
        {
          pageNumber: 3,
          png: onePixelPng,
          width: 1920,
          height: 2560,
          pageText: "Searchable handwriting ◦",
          positionedText: [],
        },
      ]),
    );

    expect(bytes.byteLength).toBeLessThan(100_000);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({
      width: 1920,
      height: 2560,
    });

    const loaded = await getDocument({ data: bytes }).promise;
    const content = await (await loaded.getPage(1)).getTextContent();
    expect(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    ).toContain("Searchable handwriting ◦");
    await loaded.destroy();
  });

  it("accepts the compatible canvas PNG when compression streams are unavailable", async () => {
    class TestImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    class TestOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext(): { putImageData: () => void } {
        return { putImageData: () => undefined };
      }

      async convertToBlob(): Promise<Blob> {
        return new Blob([onePixelPng], { type: "image/png" });
      }
    }
    vi.stubGlobal("CompressionStream", undefined);
    vi.stubGlobal("ImageData", TestImageData);
    vi.stubGlobal("OffscreenCanvas", TestOffscreenCanvas);
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    const png = await new BrowserNotebookImageCodec().encodeOpaquePng({
      width: 1,
      height: 1,
      pixels: Uint8ClampedArray.from([255, 255, 255, 255]),
    });

    const bytes = await new PdfLibExporter(pdfFontBytes).export([
      {
        pageNumber: 1,
        png,
        width: 1,
        height: 1,
        pageText: null,
        positionedText: [],
      },
    ]);

    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(diagnostic).toHaveBeenCalledOnce();
  });

  it("positions device recognition text over its page bounding box", async () => {
    const bytes = await new PdfLibExporter(pdfFontBytes).export(
      pdfPages([
        {
          pageNumber: 1,
          png: onePixelPng,
          width: 1920,
          height: 2560,
          pageText: null,
          positionedText: [
            {
              text: "Tracked line",
              rect: [100, 200, 300, 40],
            },
          ],
        },
      ]),
    );

    const loaded = await getDocument({ data: bytes }).promise;
    const content = await (await loaded.getPage(1)).getTextContent();
    const item = content.items.find(
      (candidate) => "str" in candidate && candidate.str === "Tracked line",
    );
    expect(item && "transform" in item ? item.transform[4] : null).toBeCloseTo(
      100,
      2,
    );
    expect(item && "transform" in item ? item.transform[5] : null).toBeCloseTo(
      2320,
      2,
    );
    await loaded.destroy();
  });
});
