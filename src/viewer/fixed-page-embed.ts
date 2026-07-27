import type {
  NotebookBitmapHandle,
  NotebookSessionLease,
  NotebookSessionProvider,
} from "../note/notebook-service";
import { displayCanvasBackingSize } from "./display-canvas-size";
import {
  markdownWikiEmbeds,
  parseEmbedPresentation,
  parseWikiEmbed,
  positiveInteger,
} from "./embed-syntax";

export interface FixedPageEmbedSpec {
  readonly linkpath: string;
  readonly pageNumber: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly caption: string | null;
}

export interface InvalidFixedPageEmbedSpec {
  readonly linkpath: string;
  readonly pageReference: string;
  readonly message: string;
}

export const parseFixedPageEmbed = (
  markdown: string,
): FixedPageEmbedSpec | null => {
  const embed = parseWikiEmbed(markdown);
  if (!embed) {
    return null;
  }
  const pageMatch = /^(.*)#page=(\d+)$/i.exec(embed.target);
  const pageTarget = pageMatch?.[1];
  const pageText = pageMatch?.[2];
  if (!pageTarget || !pageText) {
    return null;
  }
  const linkpath = pageTarget.trim();
  const pageNumber = positiveInteger(pageText);
  if (!pageNumber || !linkpath.toLocaleLowerCase().endsWith(".note")) {
    return null;
  }

  const presentation = parseEmbedPresentation(embed.alias);
  return {
    linkpath,
    pageNumber,
    ...presentation,
  };
};

export const parseFixedPageEmbeds = (
  markdown: string,
): FixedPageEmbedSpec[] => {
  const embeds: FixedPageEmbedSpec[] = [];
  for (const embed of markdownWikiEmbeds(markdown)) {
    const parsed = parseFixedPageEmbed(embed);
    if (parsed) {
      embeds.push(parsed);
    }
  }
  return embeds;
};

export const parseInvalidFixedPageEmbed = (
  markdown: string,
): InvalidFixedPageEmbedSpec | null => {
  const embed = parseWikiEmbed(markdown);
  if (!embed) {
    return null;
  }
  const pageMatch = /^(.*)#page=([^#]*)$/i.exec(embed.target);
  const linkpath = pageMatch?.[1]?.trim();
  const pageReference = pageMatch?.[2]?.trim();
  if (
    !linkpath ||
    pageReference === undefined ||
    !linkpath.toLocaleLowerCase().endsWith(".note") ||
    parseFixedPageEmbed(markdown)
  ) {
    return null;
  }
  return {
    linkpath,
    pageReference,
    message: pageReference
      ? `Page “${pageReference}” is not a valid one-based page number.`
      : "A fixed page embed requires a one-based page number.",
  };
};

export const parseInvalidFixedPageEmbeds = (
  markdown: string,
): InvalidFixedPageEmbedSpec[] => {
  const embeds: InvalidFixedPageEmbedSpec[] = [];
  for (const embed of markdownWikiEmbeds(markdown)) {
    const parsed = parseInvalidFixedPageEmbed(embed);
    if (parsed) {
      embeds.push(parsed);
    }
  }
  return embeds;
};

export const fixedPageEmbedMarkdown = (
  vaultPath: string,
  pageNumber: number,
): string => {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new Error("A fixed page embed requires a one-based page number");
  }
  return `![[${vaultPath}#page=${pageNumber}]]`;
};

export const fixedPageEmbedAriaLabel = (
  notebookName: string,
  pageNumber: number,
): string => `Open ${notebookName}, page ${pageNumber} in the Supernote reader`;

export const fixedPageActivationKey = (key: string): boolean =>
  key === "Enter" || key === " ";

export type FixedPageEmbedRenderState =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable";

export interface FixedPageEmbedDisplayBox {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface FixedPageEmbedRenderTarget {
  measure(): FixedPageEmbedDisplayBox;
  draw(
    bitmap: ImageBitmap,
    backing: { readonly width: number; readonly height: number },
  ): void;
  releaseCanvas(): void;
  show(state: FixedPageEmbedRenderState, message: string): void;
}

interface FixedPageEmbedSource {
  readonly revision: string;
  readonly load: () => Promise<Uint8Array>;
}

interface FixedPageEmbedRendererOptions {
  readonly notebooks: NotebookSessionProvider;
  readonly path: string;
  readonly pageNumber: number;
  readonly source: () => FixedPageEmbedSource;
  readonly target: FixedPageEmbedRenderTarget;
}

const notebookName = (path: string): string => path.split("/").at(-1) ?? path;

export class FixedPageEmbedRenderer {
  private active = false;
  private lifecycleGeneration = 0;
  private renderGeneration = 0;
  private session: NotebookSessionLease | null = null;
  private openAbort: AbortController | null = null;
  private renderAbort: AbortController | null = null;
  private rerenderQueued = false;

  constructor(private readonly options: FixedPageEmbedRendererOptions) {}

  activate(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    void this.openRevision(++this.lifecycleGeneration);
  }

  deactivate(): void {
    if (!this.active && !this.session) {
      return;
    }
    this.active = false;
    this.lifecycleGeneration += 1;
    this.renderGeneration += 1;
    this.cancelOpen();
    this.cancelRender();
    this.releaseSession();
    this.options.target.releaseCanvas();
    this.options.target.show("idle", "Page will render when it is nearby.");
  }

  revisionChanged(): void {
    if (!this.active) {
      return;
    }
    this.lifecycleGeneration += 1;
    this.renderGeneration += 1;
    this.cancelOpen();
    this.cancelRender();
    this.releaseSession();
    this.options.target.releaseCanvas();
    void this.openRevision(++this.lifecycleGeneration);
  }

  rerender(): void {
    if (!this.active || !this.session) {
      return;
    }
    if (this.renderAbort) {
      this.rerenderQueued = true;
      return;
    }
    void this.render(this.session);
  }

  dispose(): void {
    this.deactivate();
  }

  private async openRevision(generation: number): Promise<void> {
    this.cancelOpen();
    const openAbort = new AbortController();
    this.openAbort = openAbort;
    this.options.target.show(
      "loading",
      `Loading page ${this.options.pageNumber}…`,
    );
    let opened: NotebookSessionLease | null = null;
    try {
      const source = this.options.source();
      opened = await this.options.notebooks.open(
        {
          path: this.options.path,
          revision: source.revision,
          load: source.load,
        },
        { signal: openAbort.signal },
      );
      if (!this.active || generation !== this.lifecycleGeneration) {
        opened.close();
        return;
      }
      this.session = opened;
      if (this.options.pageNumber > opened.descriptor.pageCount) {
        this.fail(
          `Page ${this.options.pageNumber} is no longer available in ${notebookName(this.options.path)}.`,
        );
        return;
      }
      if (
        !opened.updateView({
          visible: true,
          currentPage: this.options.pageNumber,
          gridOpen: false,
          canvasBytes: 0,
        }).admitted
      ) {
        this.fail(
          `Not enough display memory to render page ${this.options.pageNumber}.`,
        );
        return;
      }
      await this.render(opened);
    } catch (error) {
      if (
        !this.active ||
        generation !== this.lifecycleGeneration ||
        (opened && opened !== this.session)
      ) {
        opened?.close();
        return;
      }
      this.fail(
        error instanceof Error
          ? `Could not render page ${this.options.pageNumber}: ${error.message}`
          : `Could not render page ${this.options.pageNumber}.`,
      );
    } finally {
      if (this.openAbort === openAbort) {
        this.openAbort = null;
      }
    }
  }

  private async render(session: NotebookSessionLease): Promise<void> {
    const generation = ++this.renderGeneration;
    this.cancelRender();
    const renderAbort = new AbortController();
    this.renderAbort = renderAbort;
    const box = this.options.target.measure();
    const maxWidth = Math.max(
      1,
      Math.ceil(
        box.width *
          (Number.isFinite(box.devicePixelRatio) && box.devicePixelRatio > 0
            ? box.devicePixelRatio
            : 1),
      ),
    );
    let handle: NotebookBitmapHandle | null = null;
    try {
      handle = await session.thumbnailBitmap(
        this.options.pageNumber,
        maxWidth,
        "display",
        renderAbort.signal,
      );
      if (
        !this.active ||
        session !== this.session ||
        generation !== this.renderGeneration
      ) {
        return;
      }
      if (this.rerenderQueued) {
        return;
      }
      const backing = displayCanvasBackingSize({
        sourceWidth: handle.bitmap.width,
        sourceHeight: handle.bitmap.height,
        displayWidth: box.width,
        displayHeight: box.height,
        devicePixelRatio: box.devicePixelRatio,
      });
      const admission = session.updateView({
        visible: true,
        currentPage: this.options.pageNumber,
        gridOpen: false,
        canvasBytes: backing.bytes,
      });
      if (!admission.admitted) {
        this.fail(
          `Not enough display memory to render page ${this.options.pageNumber}.`,
        );
        return;
      }
      this.options.target.draw(handle.bitmap, backing);
      this.options.target.show("ready", "");
    } catch (error) {
      if (
        this.active &&
        session === this.session &&
        generation === this.renderGeneration &&
        !this.isAbortError(error)
      ) {
        this.fail(
          error instanceof Error
            ? `Could not render page ${this.options.pageNumber}: ${error.message}`
            : `Could not render page ${this.options.pageNumber}.`,
        );
      }
    } finally {
      const rerender =
        this.renderAbort === renderAbort &&
        this.rerenderQueued &&
        this.active &&
        session === this.session;
      if (this.renderAbort === renderAbort) {
        this.renderAbort = null;
      }
      handle?.release();
      if (rerender) {
        this.rerenderQueued = false;
        void this.render(session);
      }
    }
  }

  private fail(message: string): void {
    this.renderGeneration += 1;
    this.cancelOpen();
    this.cancelRender();
    this.releaseSession();
    this.options.target.releaseCanvas();
    this.options.target.show("unavailable", message);
  }

  private releaseSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) {
      return;
    }
    session.updateView({
      visible: false,
      currentPage: null,
      gridOpen: false,
      canvasBytes: 0,
    });
    session.close();
  }

  private cancelRender(): void {
    this.rerenderQueued = false;
    this.renderAbort?.abort();
    this.renderAbort = null;
  }

  private cancelOpen(): void {
    this.openAbort?.abort();
    this.openAbort = null;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }
}
