import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import { MarkdownPdfRenderer } from "../src/export/markdown-pdf";
import { pdfBoldFontBytes, pdfRegularFontBytes } from "./pdf-font-fixture";

describe("MarkdownPdfRenderer", () => {
  it("embeds complete fonts for broad PDF viewer compatibility", async () => {
    const bytes = await new MarkdownPdfRenderer(
      pdfRegularFontBytes,
      pdfBoldFontBytes,
    ).render("# Résumé • Codex Markdown");

    expect(bytes.byteLength).toBeGreaterThan(500_000);
    const pdf = await getDocument({ data: bytes }).promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    expect(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " "),
    ).toContain("Résumé • Codex Markdown");
    await pdf.destroy();
  });

  it("renders structured Markdown as formatted selectable PDF text", async () => {
    const bytes = await new MarkdownPdfRenderer(
      pdfRegularFontBytes,
      pdfBoldFontBytes,
    ).render(
      [
        "# Project brief",
        "",
        "A paragraph with **important** context.",
        "",
        "- First outcome",
        "- [x] Finished task",
        "  - Nested outcome",
        "",
        "> Keep this visible",
        "",
        `Long identifier: ${"x".repeat(160)}`,
      ].join("\n"),
    );

    const pdf = await getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const textItems = content.items.filter(
      (item): item is typeof item & { str: string; height: number } =>
        "str" in item && "height" in item,
    );
    const text = textItems
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const heading = textItems.find((item) => item.str.includes("Project"));
    const paragraph = textItems.find((item) => item.str.trim() === "A");

    expect(pdf.numPages).toBe(1);
    expect(text).toContain("Project brief");
    expect(text).toContain("A paragraph with important context.");
    expect(text).toContain("• First outcome");
    expect(text).toContain("[x] Finished task");
    expect(text).toContain("• Nested outcome");
    expect(text).toContain("| Keep this visible");
    expect(heading?.height).toBeGreaterThan(paragraph?.height ?? 0);
    for (const item of textItems) {
      if ("transform" in item && "width" in item) {
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(542);
      }
    }

    await pdf.destroy();
  });
});
