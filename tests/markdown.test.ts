import { describe, expect, it } from "vitest";

import { buildExportMarkdown } from "../src/sync/markdown";

const baseInput = {
  title: "7 July 2026 p3-5",
  sourceNotePath: "supernote/Note/Journal/2026/7 July 2026.note",
  remotePath: "/Note/Journal/2026/7 July 2026.note",
  exportedAt: "2026-07-24 12:00 UTC",
};

describe("export Markdown", () => {
  it("builds a plain one-shot export with source frontmatter", () => {
    expect(
      buildExportMarkdown({
        ...baseInput,
        pages: [
          {
            pageNumber: 3,
            imageVaultPath: "Attachments/7 July 2026 p3.png",
            recognitionText: "Recognized handwriting",
            recognitionSource: "device",
            textBoxes: [],
          },
        ],
      }),
    ).toBe(
      [
        "---",
        'supernote-note: "supernote/Note/Journal/2026/7 July 2026.note"',
        "supernote-pages: [3]",
        "cssclasses: [supernote-generated-preview]",
        "---",
        "",
        "# 7 July 2026 p3-5",
        "",
        "> [!info]- Exported from Supernote `/Note/Journal/2026/7 July 2026.note` at 2026-07-24 12:00 UTC.",
        "",
        "### Page 3",
        "",
        "![[Attachments/7 July 2026 p3.png]]",
        "",
        "Recognized handwriting",
        "",
      ].join("\n"),
    );
  });

  it("marks OCR text and preserves extracted text boxes", () => {
    const markdown = buildExportMarkdown({
      ...baseInput,
      pages: [
        {
          pageNumber: 4,
          imageVaultPath: null,
          recognitionText: "OCR text",
          recognitionSource: "ocr",
          textBoxes: [
            {
              pageNumber: 4,
              text: "Typed box",
              rect: [10, 20, 300, 64],
              fontSize: 48,
              fontPath: "/system/font.ttf",
              id: "box",
            },
          ],
        },
      ],
    });

    expect(markdown).toContain("> Typed box");
    expect(markdown).toContain("\nOCR text\n");
    expect(markdown).toContain("cssclasses: [supernote-generated-preview]");
  });

  it("shows AI text first and device recognition in a collapsed callout", () => {
    const markdown = buildExportMarkdown({
      ...baseInput,
      pages: [
        {
          pageNumber: 2,
          imageVaultPath: null,
          recognitionText: "AI transcription",
          recognitionSource: "ocr",
          deviceRecognitionText: "Device recognition",
          textBoxes: [],
        },
      ],
    });

    expect(markdown.indexOf("AI transcription")).toBeLessThan(
      markdown.indexOf("On-device recognition"),
    );
    expect(markdown).toContain(
      "> [!quote]- On-device recognition\n> Device recognition",
    );
  });

  it("builds one formatted transcription with device text and PDF below it", () => {
    const markdown = buildExportMarkdown({
      ...baseInput,
      formattedTranscription: "# Heading\n\n- one\n- two",
      pdfVaultPath: "Attachments/export.pdf",
      pages: [
        {
          pageNumber: 1,
          imageVaultPath: null,
          recognitionText: null,
          deviceRecognitionText: "Device one",
          textBoxes: [],
        },
        {
          pageNumber: 2,
          imageVaultPath: null,
          recognitionText: null,
          deviceRecognitionText: "Device two",
          textBoxes: [],
        },
      ],
    });

    expect(markdown).toContain(
      "# Heading\n\n- one\n- two\n\n> [!quote]- On-device recognition\n> ### Page 1",
    );
    expect(markdown.indexOf("# Heading")).toBeLessThan(
      markdown.indexOf("![[Attachments/export.pdf]]"),
    );
  });

  it("embeds a combined PDF before the page text", () => {
    const markdown = buildExportMarkdown({
      ...baseInput,
      pdfVaultPath: "Attachments/7 July 2026 p3-5.pdf",
      pages: [
        {
          pageNumber: 3,
          imageVaultPath: null,
          recognitionText: "Text",
          textBoxes: [],
        },
      ],
    });

    expect(
      markdown.indexOf("![[Attachments/7 July 2026 p3-5.pdf]]"),
    ).toBeLessThan(markdown.indexOf("### Page 3"));
  });
});
