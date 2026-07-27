import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("worker-owned notebook boundary", () => {
  it("keeps notebook parsing and pixel conversion inside the worker runtime", async () => {
    const [main, service, runtime, imageCodec, lockfile] = await Promise.all([
      source("../src/main.ts"),
      source("../src/note/notebook-service.ts"),
      source("../src/note/notebook-worker-runtime.ts"),
      source("../src/note/notebook-image-codec.ts"),
      source("../pnpm-lock.yaml"),
    ]);

    expect(main).not.toContain("SupernoteX");
    expect(main).not.toContain("toImage");
    expect(runtime).toContain('from "supernote-typescript/lib/parsing"');
    expect(runtime).not.toContain('from "supernote-typescript/lib/conversion"');
    expect(runtime).toContain('from "./notebook-rasterizer"');
    expect(service).not.toContain("createImageBitmap");
    expect(imageCodec).toContain("createImageBitmap");
    expect(lockfile).not.toMatch(/^\s{2}image-js@/m);
  });

  it("deletes the superseded renderer, parser, and identity cache APIs", async () => {
    for (const path of [
      "../src/note/renderer.ts",
      "../src/note/parser.ts",
      "../src/note/source-page-cache.ts",
    ]) {
      await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
    }
  });

  it("releases hidden-reader resources and keeps theme adaptation in CSS", async () => {
    const [reader, noteView, runtime, styles, main] = await Promise.all([
      source("../src/viewer/note-reader.ts"),
      source("../src/viewer/note-view.ts"),
      source("../src/note/notebook-worker-runtime.ts"),
      source("../styles.css"),
      source("../src/main.ts"),
    ]);

    expect(reader).toContain("session.updateView");
    expect(reader).toContain("new IntersectionObserver");
    expect(reader).toContain("new MutationObserver");
    expect(reader).toContain("canvas.width = 1");
    expect(reader).toContain("canvasBytes: this.retainedCanvasBytes");
    expect(reader).toContain("Math.min(bitmap.width, 960)");
    expect(reader).toContain("window.devicePixelRatio");
    expect(reader).toContain("new ResizeObserver");
    expect(reader).toContain("preparePagerFromGrid");
    expect(reader).not.toContain("canvas.getBoundingClientRect()");
    expect(noteView).toContain('cls: "supernote-reader-staging"');
    expect(noteView).not.toContain("staging.hidden = true");
    expect(noteView).toContain("replacement.rejectedInitialPageAdmission");
    expect(runtime).not.toContain("applyDarkDisplayTheme");
    expect(runtime).not.toContain("decodedPages");
    expect(styles).toContain(".theme-dark .supernote-reader-canvas");
    expect(styles).toContain(".supernote-reader-staging");
    expect(
      styles.match(/\.supernote-reader-canvas\s*\{([^}]*)\}/)?.[1],
    ).not.toContain("box-shadow");
    expect(styles).toContain(
      ".supernote-generated-preview img.supernote-page-reader-trigger",
    );
    expect(main).toContain("MOBILE_RENDER_BUDGET_BYTES");
    expect(main).toContain("maxConcurrentRenders: Platform.isMobile ? 1 : 2");
  });
});
