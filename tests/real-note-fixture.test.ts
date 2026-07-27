import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { PdfLibExporter } from "../src/export/pdf-export";
import { NotebookService } from "../src/note/notebook-service";
import { extractTextBoxes } from "../src/note/textboxes";
import { pdfFontBytes } from "./pdf-font-fixture";
import { NotebookRuntimeWorker } from "./notebook-runtime-worker";

const fixturePath = process.env.SUPERNOTE_REAL_NOTE_FIXTURE ?? "";
const service = (): NotebookService =>
  new NotebookService({
    createWorker: () => new NotebookRuntimeWorker() as unknown as Worker,
  });

describe("real Manta note fixture", () => {
  it.skipIf(!existsSync(fixturePath))(
    "matches the validated Python text-box extraction",
    () => {
      const bytes = readFileSync(fixturePath);

      expect(extractTextBoxes(bytes)).toMatchObject([
        {
          pageNumber: 1,
          rect: [1228, 320, 462, 64],
          text: "Testify text box 123",
        },
      ]);
    },
  );

  it.skipIf(!existsSync(fixturePath))(
    "parses the same fixture through the shipped notebook parser",
    async () => {
      const notebooks = service();
      const session = await notebooks.open({
        path: "fixture.note",
        revision: "fixture-v1",
        bytes: readFileSync(fixturePath),
      });

      expect(session.descriptor.pageCount).toBe(1);
      expect(
        session.descriptor.pages.filter(
          (page) => page.recognitionText !== null,
        ),
      ).toHaveLength(0);
      expect(session.descriptor.textBoxes).toHaveLength(1);
      session.close();
      notebooks.dispose();
    },
  );

  it.skipIf(!existsSync(fixturePath))(
    "exports a real rendered page with selectable text-box content",
    async () => {
      const bytes = readFileSync(fixturePath);
      const notebooks = service();
      const session = await notebooks.open({
        path: "fixture.note",
        revision: "fixture-v1",
        bytes,
      });
      const rendered = await session.renderPng(1, 1);
      const pdf = await new PdfLibExporter(pdfFontBytes).export([
        {
          pageNumber: 1,
          png: rendered.png,
          width: rendered.width,
          height: rendered.height,
          pageText: null,
          positionedText: session.descriptor.textBoxes.map((box) => ({
            text: box.text,
            rect: box.rect,
          })),
        },
      ]);
      session.close();
      notebooks.dispose();

      const loaded = await getDocument({ data: pdf }).promise;
      expect(loaded.numPages).toBe(1);
      const page = await loaded.getPage(1);
      expect(page.getViewport({ scale: 1 })).toMatchObject({
        width: rendered.width,
        height: rendered.height,
      });
      const content = await page.getTextContent();
      expect(
        content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
      ).toContain("Testify text box 123");
      await loaded.destroy();
    },
  );
});
