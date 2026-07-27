import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type {
  NotebookBitmapHandle,
  NotebookSessionLease,
  NotebookSessionProvider,
} from "../src/note/notebook-service";
import {
  fixedPageActivationKey,
  fixedPageEmbedAriaLabel,
  fixedPageEmbedMarkdown,
  FixedPageEmbedRenderer,
  parseFixedPageEmbed,
  parseFixedPageEmbeds,
  parseInvalidFixedPageEmbed,
  type FixedPageEmbedRenderTarget,
} from "../src/viewer/fixed-page-embed";
import {
  matchFixedPageEmbedElements,
  matchInvalidFixedPageEmbedElements,
} from "../src/viewer/fixed-page-reading-view";

const descriptor = (pageCount = 12) => ({
  path: "Notes/Journal.note",
  revision: "1:100",
  pageCount,
  devicePage: null,
  pages: Array.from({ length: pageCount }, (_, index) => ({
    pageNumber: index + 1,
    fingerprint: `page-${index + 1}`,
    recognitionText: null,
    recognitionSpans: [],
  })),
  textBoxes: [],
});

const bitmap = {
  width: 1_200,
  height: 1_600,
} as ImageBitmap;

const createLease = (
  options: {
    pageCount?: number;
    admission?: "admitted" | "rejected";
    bitmapPromise?: Promise<NotebookBitmapHandle>;
  } = {},
): NotebookSessionLease => {
  const handle = {
    bitmap,
    release: vi.fn(),
  };
  return {
    descriptor: descriptor(options.pageCount),
    retain: vi.fn(),
    bitmap: vi.fn(),
    thumbnailBitmap: vi
      .fn()
      .mockReturnValue(options.bitmapPromise ?? Promise.resolve(handle)),
    renderPng: vi.fn(),
    updateView: vi
      .fn()
      .mockImplementation(() =>
        options.admission === "rejected"
          ? { admitted: false, reason: "resource-budget" }
          : { admitted: true },
      ),
    close: vi.fn(),
  };
};

const createTarget = (): FixedPageEmbedRenderTarget => ({
  measure: vi.fn().mockReturnValue({
    width: 400,
    height: 533,
    devicePixelRatio: 2,
  }),
  draw: vi.fn(),
  releaseCanvas: vi.fn(),
  show: vi.fn(),
});

describe("fixed Supernote page embed syntax", () => {
  it("parses fixed pages, Obsidian sizes, and captions", () => {
    expect(parseFixedPageEmbed("![[Journal.note#page=12]]")).toEqual({
      linkpath: "Journal.note",
      pageNumber: 12,
      width: null,
      height: null,
      caption: null,
    });
    expect(parseFixedPageEmbed("![[Journal.note#page=12|500]]")).toMatchObject({
      width: 500,
      height: null,
      caption: null,
    });
    expect(
      parseFixedPageEmbed("![[Journal.note#page=12|500x320]]"),
    ).toMatchObject({
      width: 500,
      height: 320,
      caption: null,
    });
    expect(
      parseFixedPageEmbed("![[Journal.note#page=12|Opening sketch]]"),
    ).toMatchObject({
      width: null,
      height: null,
      caption: "Opening sketch",
    });
  });

  it("rejects ordinary links, whole notebooks, and invalid pages", () => {
    expect(parseFixedPageEmbed("[[Journal.note#page=12]]")).toBeNull();
    expect(parseFixedPageEmbed("![[Journal.note]]")).toBeNull();
    expect(parseFixedPageEmbed("![[Journal.note#page=0]]")).toBeNull();
    expect(parseFixedPageEmbed("![[Journal.note#page=1.5]]")).toBeNull();
    expect(parseFixedPageEmbed("![[Journal.pdf#page=12]]")).toBeNull();
  });

  it("recognizes malformed fixed-page attempts for local error rendering", () => {
    expect(parseInvalidFixedPageEmbed("![[Journal.note#page=0]]")).toEqual({
      linkpath: "Journal.note",
      pageReference: "0",
      message: "Page “0” is not a valid one-based page number.",
    });
    expect(
      parseInvalidFixedPageEmbed("![[Journal.note#page=1.5]]"),
    ).toMatchObject({
      linkpath: "Journal.note",
      pageReference: "1.5",
    });
    expect(parseInvalidFixedPageEmbed("![[Journal.note#heading]]")).toBeNull();
  });

  it("extracts only fixed page embeds from a Markdown section", () => {
    expect(
      parseFixedPageEmbeds(
        [
          "[[Journal.note#page=2]]",
          "![[Journal.note]]",
          "![[Journal.note#page=3|320]]",
          "![[Other.note#page=4|Caption]]",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ linkpath: "Journal.note", pageNumber: 3 }),
      expect.objectContaining({ linkpath: "Other.note", pageNumber: 4 }),
    ]);
  });

  it("preserves source sizes and captions when Obsidian renders a full path", () => {
    const renderedEmbed = {
      getAttribute: (name: string) =>
        name === "src" ? "Archive/Journal.note#page=12" : null,
    } as HTMLElement;
    const root = {
      matches: () => false,
      querySelectorAll: () => [renderedEmbed],
    } as unknown as HTMLElement;
    const source = parseFixedPageEmbed(
      "![[Journal.note#page=12|Opening sketch]]",
    );

    expect(matchFixedPageEmbedElements(root, source ? [source] : [])).toEqual([
      {
        element: renderedEmbed,
        spec: expect.objectContaining({
          linkpath: "Journal.note",
          pageNumber: 12,
          caption: "Opening sketch",
        }),
      },
    ]);
  });

  it("matches malformed rendered page targets without touching ordinary links", () => {
    const renderedEmbed = {
      getAttribute: (name: string) =>
        name === "src" ? "Journal.note#page=-2" : null,
    } as HTMLElement;
    const root = {
      matches: () => false,
      querySelectorAll: () => [renderedEmbed],
    } as unknown as HTMLElement;

    expect(matchInvalidFixedPageEmbedElements(root, [])).toEqual([
      {
        element: renderedEmbed,
        spec: expect.objectContaining({
          linkpath: "Journal.note",
          pageReference: "-2",
        }),
      },
    ]);
  });
});

describe("fixed page embed authoring and accessibility", () => {
  it("copies an unambiguous full-path fixed page embed", () => {
    expect(
      fixedPageEmbedMarkdown("supernote/Note/Journal/2026/Journal.note", 12),
    ).toBe("![[supernote/Note/Journal/2026/Journal.note#page=12]]");
  });

  it("describes the notebook and fixed page and activates only on Enter/Space", () => {
    expect(fixedPageEmbedAriaLabel("Journal", 12)).toBe(
      "Open Journal, page 12 in the Supernote reader",
    );
    expect(fixedPageActivationKey("Enter")).toBe(true);
    expect(fixedPageActivationKey(" ")).toBe(true);
    expect(fixedPageActivationKey("ArrowRight")).toBe(false);
  });
});

describe("fixed page embed render lifecycle", () => {
  it("does no notebook work until admitted near the viewport", async () => {
    const lease = createLease();
    const notebooks: NotebookSessionProvider = {
      open: vi.fn().mockResolvedValue(lease),
    };
    const target = createTarget();
    const renderer = new FixedPageEmbedRenderer({
      notebooks,
      path: "Notes/Journal.note",
      pageNumber: 12,
      source: () => ({
        revision: "1:100",
        load: vi.fn(),
      }),
      target,
    });

    expect(notebooks.open).not.toHaveBeenCalled();
    renderer.activate();
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());

    expect(notebooks.open).toHaveBeenCalledOnce();
    expect(lease.thumbnailBitmap).toHaveBeenCalledWith(
      12,
      800,
      "display",
      expect.any(AbortSignal),
    );
    expect(lease.updateView).toHaveBeenLastCalledWith({
      visible: true,
      currentPage: 12,
      gridOpen: false,
      canvasBytes: 3_411_200,
    });
  });

  it("releases stale bitmap, lease, and canvas work when deactivated", async () => {
    let resolveBitmap!: (handle: NotebookBitmapHandle) => void;
    const bitmapPromise = new Promise<NotebookBitmapHandle>((resolve) => {
      resolveBitmap = resolve;
    });
    const lease = createLease({ bitmapPromise });
    const notebooks: NotebookSessionProvider = {
      open: vi.fn().mockResolvedValue(lease),
    };
    const target = createTarget();
    const renderer = new FixedPageEmbedRenderer({
      notebooks,
      path: "Notes/Journal.note",
      pageNumber: 12,
      source: () => ({ revision: "1:100", load: vi.fn() }),
      target,
    });
    const handle = { bitmap, release: vi.fn() };

    renderer.activate();
    await vi.waitFor(() =>
      expect(lease.thumbnailBitmap).toHaveBeenCalledOnce(),
    );
    renderer.deactivate();
    resolveBitmap(handle);
    await vi.waitFor(() => expect(handle.release).toHaveBeenCalledOnce());

    expect(target.draw).not.toHaveBeenCalled();
    expect(target.releaseCanvas).toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it("does not duplicate work when the observer admits a pending embed twice", async () => {
    let resolveOpen!: (lease: NotebookSessionLease) => void;
    const openPromise = new Promise<NotebookSessionLease>((resolve) => {
      resolveOpen = resolve;
    });
    const notebooks: NotebookSessionProvider = {
      open: vi.fn().mockReturnValue(openPromise),
    };
    const target = createTarget();
    const renderer = new FixedPageEmbedRenderer({
      notebooks,
      path: "Notes/Journal.note",
      pageNumber: 12,
      source: () => ({ revision: "1:100", load: vi.fn() }),
      target,
    });

    renderer.activate();
    renderer.activate();
    expect(notebooks.open).toHaveBeenCalledOnce();
    resolveOpen(createLease());
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());
  });

  it("coalesces resize rerenders while a preview render is already pending", async () => {
    let resolveBitmap!: (handle: NotebookBitmapHandle) => void;
    const bitmapPromise = new Promise<NotebookBitmapHandle>((resolve) => {
      resolveBitmap = resolve;
    });
    const lease = createLease({ bitmapPromise });
    const target = createTarget();
    const renderer = new FixedPageEmbedRenderer({
      notebooks: { open: vi.fn().mockResolvedValue(lease) },
      path: "Notes/Journal.note",
      pageNumber: 12,
      source: () => ({ revision: "1:100", load: vi.fn() }),
      target,
    });

    renderer.activate();
    await vi.waitFor(() =>
      expect(lease.thumbnailBitmap).toHaveBeenCalledOnce(),
    );
    for (let index = 0; index < 20; index += 1) {
      renderer.rerender();
    }

    expect(lease.thumbnailBitmap).toHaveBeenCalledOnce();
    resolveBitmap({ bitmap, release: vi.fn() });
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());
  });

  it("keeps the requested page fixed when a shorter revision arrives", async () => {
    const first = createLease();
    const shorter = createLease({ pageCount: 4 });
    const notebooks: NotebookSessionProvider = {
      open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(shorter),
    };
    const target = createTarget();
    let revision = "1:100";
    const renderer = new FixedPageEmbedRenderer({
      notebooks,
      path: "Notes/Journal.note",
      pageNumber: 12,
      source: () => ({ revision, load: vi.fn() }),
      target,
    });

    renderer.activate();
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());
    revision = "2:80";
    renderer.revisionChanged();
    await vi.waitFor(() =>
      expect(target.show).toHaveBeenCalledWith(
        "unavailable",
        "Page 12 is no longer available in Journal.note.",
      ),
    );

    expect(shorter.thumbnailBitmap).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(shorter.close).toHaveBeenCalledOnce();
  });

  it("keeps an admission failure local and never allocates the canvas", async () => {
    const lease = createLease({ admission: "rejected" });
    const target = createTarget();
    const renderer = new FixedPageEmbedRenderer({
      notebooks: { open: vi.fn().mockResolvedValue(lease) },
      path: "Notes/Journal.note",
      pageNumber: 12,
      source: () => ({ revision: "1:100", load: vi.fn() }),
      target,
    });

    renderer.activate();
    await vi.waitFor(() =>
      expect(target.show).toHaveBeenCalledWith(
        "unavailable",
        "Not enough display memory to render page 12.",
      ),
    );

    expect(target.draw).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it("opens only admitted members of a 100-embed fixture", async () => {
    const notebooks: NotebookSessionProvider = {
      open: vi.fn().mockImplementation(() => Promise.resolve(createLease())),
    };
    const renderers = Array.from(
      { length: 100 },
      (_, index) =>
        new FixedPageEmbedRenderer({
          notebooks,
          path: `Notes/Journal-${index}.note`,
          pageNumber: 1,
          source: () => ({ revision: "1:100", load: vi.fn() }),
          target: createTarget(),
        }),
    );

    renderers[0]?.activate();
    renderers[50]?.activate();
    renderers[99]?.activate();
    await vi.waitFor(() => expect(notebooks.open).toHaveBeenCalledTimes(3));

    expect(notebooks.open).toHaveBeenCalledTimes(3);
    renderers.forEach((renderer) => renderer.dispose());
  });
});

describe("fixed page Reading view adapter", () => {
  it("uses the shared frame without exposing a nested native Page preview", () => {
    const source = readFileSync(
      new URL("../src/viewer/fixed-page-reading-view.ts", import.meta.url),
      "utf8",
    );
    const plugin = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("extends MarkdownRenderChild");
    expect(source).toContain(
      '"supernote-embed-frame supernote-fixed-page-embed"',
    );
    expect(source).toContain('rootMargin: "400px 0px"');
    expect(source).toContain('document.createElement("a")');
    expect(source).toContain("fixedPageActivationKey(event.key)");
    expect(
      source.slice(0, source.indexOf("export interface InvalidFixedPage")),
    ).not.toContain("internal-link");
    expect(
      source.slice(0, source.indexOf("export interface InvalidFixedPage")),
    ).not.toContain("dataset.href");
    expect(source).not.toContain("supernote-fixed-page-actions");
    expect(source).toContain("this.canvas.width = 1");
    expect(source).toContain("InvalidFixedPageReadingView");
    expect(plugin).toContain("getFirstLinkpathDest(");
    expect(plugin).toContain("context.addChild(");
    expect(plugin).toContain("matchFixedPageEmbedElements(");
    expect(plugin).toContain("openNotebook: () => open(spec.pageNumber)");
  });

  it("never generates a redundant Open notebook button", () => {
    const source = readFileSync(
      new URL("../src/viewer/fixed-page-reading-view.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('document.createElement("button")');
    expect(source).not.toContain("openNotebookButton");
    expect(source).not.toContain("openButton");
    expect(source).not.toContain("supernote-embed-recovery");
    expect(source).toContain("this.options.openNotebook()");
  });

  it("shares the compact dark frame and preserves explicit dimensions", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toContain(".supernote-embed-frame {");
    expect(styles).toContain("width: fit-content");
    expect(styles).toContain(".supernote-embed-header {");
    expect(styles).toContain("background: #1b1d20");
    expect(styles).toContain(".supernote-embed-surface {");
    expect(styles).toContain("height: min(72vh, 760px)");
    expect(styles).not.toContain("height: min(60vh, 640px)");
    expect(styles).toMatch(
      /\.supernote-fixed-page-canvas\[hidden\],[\s\S]*\.supernote-notebook-canvas\[hidden\]\s*\{[^}]*display: none/,
    );
    expect(styles).toContain(
      ".supernote-embed-frame.has-explicit-width .supernote-embed-surface",
    );
    expect(styles).toContain(
      ".supernote-embed-frame.has-explicit-height .supernote-embed-surface",
    );
  });

  it("collapses unavailable targets instead of reserving a page-sized surface", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const unavailableSurface = styles.match(
      /\.supernote-fixed-page-embed\[data-state="unavailable"\]\s+\.supernote-fixed-page-surface\s*\{([^}]*)\}/,
    );

    expect(unavailableSurface?.[1]).toContain("aspect-ratio: auto");
    expect(unavailableSurface?.[1]).toContain("height: auto");
    expect(unavailableSurface?.[1]).toContain("min-height: 6rem");
  });
});
