import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type {
  NotebookBitmapHandle,
  NotebookSessionLease,
  NotebookSessionProvider,
} from "../src/note/notebook-service";
import {
  notebookEmbedMarkdown,
  NotebookEmbedRenderer,
  parseNotebookEmbed,
  parseNotebookEmbeds,
  type NotebookEmbedRenderTarget,
} from "../src/viewer/notebook-embed";

const descriptor = (pageCount = 6, revision = "1:100") => ({
  path: "Notes/Journal.note",
  revision,
  pageCount,
  devicePage: 5,
  pages: Array.from({ length: pageCount }, (_, index) => ({
    pageNumber: index + 1,
    fingerprint: `page-${index + 1}`,
    recognitionText: null,
    recognitionSpans: [],
  })),
  textBoxes: [],
});

const createHandle = (pageNumber: number): NotebookBitmapHandle => ({
  bitmap: {
    width: 1_200,
    height: 1_600,
    pageNumber,
  } as unknown as ImageBitmap,
  release: vi.fn(),
});

const createLease = (
  options: {
    pageCount?: number;
    revision?: string;
    render?: (
      pageNumber: number,
      signal?: AbortSignal,
    ) => Promise<NotebookBitmapHandle>;
  } = {},
): NotebookSessionLease => ({
  descriptor: descriptor(options.pageCount, options.revision),
  retain: vi.fn(),
  bitmap: vi.fn(),
  thumbnailBitmap: vi
    .fn()
    .mockImplementation(
      (
        pageNumber: number,
        _maxWidth?: number,
        _priority?: string,
        signal?: AbortSignal,
      ) =>
        options.render?.(pageNumber, signal) ??
        Promise.resolve(createHandle(pageNumber)),
    ),
  renderPng: vi.fn(),
  updateView: vi.fn().mockReturnValue({ admitted: true }),
  close: vi.fn(),
});

const createTarget = (): NotebookEmbedRenderTarget => ({
  measure: vi.fn().mockReturnValue({
    width: 400,
    height: 533,
    devicePixelRatio: 2,
  }),
  draw: vi.fn(),
  releaseCanvas: vi.fn(),
  show: vi.fn(),
  reportError: vi.fn(),
  pageChanged: vi.fn(),
});

const createRenderer = (
  notebooks: NotebookSessionProvider,
  target = createTarget(),
  revision = () => "1:100",
): { renderer: NotebookEmbedRenderer; target: NotebookEmbedRenderTarget } => ({
  renderer: new NotebookEmbedRenderer({
    notebooks,
    path: "Notes/Journal.note",
    source: () => ({
      revision: revision(),
      load: async () => new Uint8Array([1]),
    }),
    target,
  }),
  target,
});

describe("whole Supernote notebook embed syntax", () => {
  it("parses whole notebooks, sizes, and captions without accepting page embeds", () => {
    expect(parseNotebookEmbed("![[Journal.note]]")).toEqual({
      linkpath: "Journal.note",
      width: null,
      height: null,
      caption: null,
    });
    expect(parseNotebookEmbed("![[Journal.note|500]]")).toMatchObject({
      width: 500,
      height: null,
      caption: null,
    });
    expect(parseNotebookEmbed("![[Journal.note|500x320]]")).toMatchObject({
      width: 500,
      height: 320,
      caption: null,
    });
    expect(parseNotebookEmbed("![[Journal.note|Daily journal]]")).toMatchObject(
      {
        caption: "Daily journal",
      },
    );
    expect(parseNotebookEmbed("[[Journal.note]]")).toBeNull();
    expect(parseNotebookEmbed("![[Journal.note#page=2]]")).toBeNull();
    expect(parseNotebookEmbed("![[Journal.pdf]]")).toBeNull();
  });

  it("extracts only unqualified notebook embeds from a Markdown section", () => {
    expect(
      parseNotebookEmbeds(
        [
          "[[Journal.note]]",
          "![[Journal.note#page=2]]",
          "![[Journal.note|320]]",
          "![[Other.note]]",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ linkpath: "Journal.note", width: 320 }),
      expect.objectContaining({ linkpath: "Other.note" }),
    ]);
  });

  it("copies a paste-safe full-path notebook embed", () => {
    expect(notebookEmbedMarkdown("supernote/Note/Journal/Journal.note")).toBe(
      "![[supernote/Note/Journal/Journal.note]]",
    );
  });
});

describe("bounded notebook embed render lifecycle", () => {
  it("does no notebook work before activation and starts at page one", async () => {
    const lease = createLease();
    const notebooks = { open: vi.fn().mockResolvedValue(lease) };
    const { renderer, target } = createRenderer(notebooks);

    expect(notebooks.open).not.toHaveBeenCalled();
    renderer.activate();
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());

    expect(renderer.currentPage).toBe(1);
    expect(lease.thumbnailBitmap).toHaveBeenCalledWith(
      1,
      800,
      "display",
      expect.any(AbortSignal),
    );
    expect(target.pageChanged).toHaveBeenCalledWith(1, 6);
  });

  it("navigates independently while sharing the same source identity", async () => {
    const first = createLease();
    const second = createLease();
    const notebooks = {
      open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    };
    const left = createRenderer(notebooks);
    const right = createRenderer(notebooks);

    left.renderer.activate();
    right.renderer.activate();
    await vi.waitFor(() => {
      expect(left.target.draw).toHaveBeenCalledOnce();
      expect(right.target.draw).toHaveBeenCalledOnce();
    });
    left.renderer.next();
    await vi.waitFor(() => expect(left.renderer.currentPage).toBe(2));

    expect(right.renderer.currentPage).toBe(1);
    expect(notebooks.open).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        path: "Notes/Journal.note",
        revision: "1:100",
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(notebooks.open).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: "Notes/Journal.note",
        revision: "1:100",
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("cancels a pending source open when it leaves the viewport", async () => {
    const lease = createLease();
    let finishOpen!: (opened: NotebookSessionLease) => void;
    let signal: AbortSignal | undefined;
    const notebooks = {
      open: vi.fn(
        (
          _source: unknown,
          options?: {
            signal?: AbortSignal;
          },
        ) => {
          signal = options?.signal;
          return new Promise<NotebookSessionLease>((resolve) => {
            finishOpen = resolve;
          });
        },
      ),
    };
    const { renderer } = createRenderer(notebooks);

    renderer.activate();
    await vi.waitFor(() => expect(notebooks.open).toHaveBeenCalledOnce());
    renderer.deactivate();

    expect(signal?.aborted).toBe(true);
    finishOpen(lease);
    await vi.waitFor(() => expect(lease.close).toHaveBeenCalledOnce());
  });

  it("restores its transient page after leaving and re-entering the viewport", async () => {
    const first = createLease();
    const reopened = createLease();
    const notebooks = {
      open: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(reopened),
    };
    const { renderer, target } = createRenderer(notebooks);

    renderer.activate();
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());
    renderer.next();
    await vi.waitFor(() => expect(renderer.currentPage).toBe(2));
    renderer.deactivate();

    expect(first.close).toHaveBeenCalledOnce();
    expect(target.releaseCanvas).toHaveBeenCalled();

    renderer.activate();
    await vi.waitFor(() =>
      expect(reopened.thumbnailBitmap).toHaveBeenCalledWith(
        2,
        800,
        "display",
        expect.any(AbortSignal),
      ),
    );
    expect(renderer.currentPage).toBe(2);
  });

  it("clamps the transient page only when a revision becomes shorter", async () => {
    const first = createLease({ pageCount: 6 });
    const shorter = createLease({ pageCount: 2, revision: "2:80" });
    const notebooks = {
      open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(shorter),
    };
    let revision = "1:100";
    const { renderer, target } = createRenderer(
      notebooks,
      createTarget(),
      () => revision,
    );

    renderer.activate();
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());
    renderer.goTo(5);
    await vi.waitFor(() => expect(renderer.currentPage).toBe(5));
    revision = "2:80";
    renderer.revisionChanged();
    await vi.waitFor(() => expect(renderer.currentPage).toBe(2));

    expect(shorter.thumbnailBitmap).toHaveBeenCalledWith(
      2,
      800,
      "display",
      expect.any(AbortSignal),
    );
  });

  it("releases stale rapid-navigation results and keeps only the latest page", async () => {
    const pending = new Map<number, (handle: NotebookBitmapHandle) => void>();
    const signals = new Map<number, AbortSignal | undefined>();
    const lease = createLease({
      render: (pageNumber, signal) => {
        signals.set(pageNumber, signal);
        return new Promise((resolve) => pending.set(pageNumber, resolve));
      },
    });
    const { renderer, target } = createRenderer({
      open: vi.fn().mockResolvedValue(lease),
    });
    const first = createHandle(1);
    const second = createHandle(2);
    const third = createHandle(3);

    renderer.activate();
    await vi.waitFor(() => expect(pending.has(1)).toBe(true));
    pending.get(1)?.(first);
    await vi.waitFor(() => expect(renderer.currentPage).toBe(1));
    renderer.next();
    renderer.next();
    await vi.waitFor(() => {
      expect(pending.has(2)).toBe(true);
      expect(pending.has(3)).toBe(true);
    });
    expect(signals.get(2)?.aborted).toBe(true);
    expect(signals.get(3)?.aborted).toBe(false);
    pending.get(2)?.(second);
    pending.get(3)?.(third);
    await vi.waitFor(() => expect(renderer.currentPage).toBe(3));

    expect(second.release).toHaveBeenCalledOnce();
    expect(third.release).toHaveBeenCalledOnce();
    expect(target.draw).toHaveBeenCalledTimes(2);
  });

  it("never retains more than one admitted canvas allocation", async () => {
    const lease = createLease();
    const { renderer, target } = createRenderer({
      open: vi.fn().mockResolvedValue(lease),
    });

    renderer.activate();
    await vi.waitFor(() => expect(target.draw).toHaveBeenCalledOnce());
    renderer.next();
    await vi.waitFor(() => expect(renderer.currentPage).toBe(2));

    expect(target.draw).toHaveBeenCalledTimes(2);
    expect(target.releaseCanvas).not.toHaveBeenCalled();
    expect(lease.updateView).toHaveBeenLastCalledWith({
      visible: true,
      currentPage: 2,
      gridOpen: false,
      canvasBytes: 3_411_200,
    });
  });

  it("opens only admitted members of a 100-embed fixture", async () => {
    const notebooks: NotebookSessionProvider = {
      open: vi.fn().mockImplementation(() => Promise.resolve(createLease())),
    };
    const renderers = Array.from(
      { length: 100 },
      (_, index) =>
        createRenderer(notebooks, createTarget(), () => `1:${index}`).renderer,
    );

    renderers[0]?.activate();
    renderers[50]?.activate();
    renderers[99]?.activate();
    await vi.waitFor(() => expect(notebooks.open).toHaveBeenCalledTimes(3));

    expect(notebooks.open).toHaveBeenCalledTimes(3);
    renderers.forEach((renderer) => renderer.dispose());
  });
});

describe("bounded notebook Reading view adapter", () => {
  it("opens the displayed page without a redundant reader action", () => {
    const source = readFileSync(
      new URL("../src/viewer/notebook-reading-view.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("extends MarkdownRenderChild");
    expect(source).toContain(
      '"supernote-embed-frame supernote-notebook-embed"',
    );
    expect(source.match(/document\.createElement\("canvas"\)/g)).toHaveLength(
      1,
    );
    expect(source).not.toContain("NoteReader");
    expect(source).not.toContain("Open in reader");
    expect(source).not.toContain("openButton");
    expect(source).toContain('this.surface, "click"');
    expect(source).toContain("embeddedPageActivationKey(event.key)");
    expect(source).toContain("EmbeddedPageActivation");
    expect(source).toContain("`Page ${pageNumber} of ${pageCount}`");
  });

  it("keeps header navigation focus-scoped and separates completed swipe activation", () => {
    const source = readFileSync(
      new URL("../src/viewer/notebook-reading-view.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("supernote-embed-header-controls");
    expect(source).toContain('this.containerEl, "keydown"');
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain("PagerSwipeGesture");
    expect(source).toContain('movement.axis === "horizontal"');
    expect(source).toContain("this.activation.completedGesture(finish.action)");
    expect(source).toContain('this.surface, "pointerdown"');
    expect(source).toContain('this.surface, "pointermove"');
    expect(source).toContain('this.surface, "pointerup"');
    expect(source).toContain('event.pointerType === "touch"');
    expect(source).toContain('rootMargin: "400px 0px"');
  });

  it("clears swipe transforms without a static style assignment", () => {
    const source = readFileSync(
      new URL("../src/viewer/notebook-reading-view.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/\.style\.transform\s*=\s*""/);
    expect(source).toContain('this.canvas.style.removeProperty("transform")');
  });
});
