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
} from "./embed-syntax";

export interface NotebookEmbedSpec {
  readonly linkpath: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly caption: string | null;
}

export const parseNotebookEmbed = (
  markdown: string,
): NotebookEmbedSpec | null => {
  const embed = parseWikiEmbed(markdown);
  if (
    !embed ||
    embed.target.includes("#") ||
    !embed.target.toLocaleLowerCase().endsWith(".note")
  ) {
    return null;
  }
  return {
    linkpath: embed.target,
    ...parseEmbedPresentation(embed.alias),
  };
};

export const parseNotebookEmbeds = (markdown: string): NotebookEmbedSpec[] => {
  const embeds: NotebookEmbedSpec[] = [];
  for (const embed of markdownWikiEmbeds(markdown)) {
    const parsed = parseNotebookEmbed(embed);
    if (parsed) {
      embeds.push(parsed);
    }
  }
  return embeds;
};

export const notebookEmbedMarkdown = (vaultPath: string): string =>
  `![[${vaultPath}]]`;

export type NotebookEmbedRenderState =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable";

export interface NotebookEmbedDisplayBox {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface NotebookEmbedRenderTarget {
  measure(): NotebookEmbedDisplayBox;
  draw(
    bitmap: ImageBitmap,
    backing: { readonly width: number; readonly height: number },
  ): void;
  releaseCanvas(): void;
  show(state: NotebookEmbedRenderState, message: string): void;
  reportError(message: string): void;
  pageChanged(pageNumber: number, pageCount: number): void;
}

interface NotebookEmbedSource {
  readonly revision: string;
  readonly load: () => Promise<Uint8Array>;
}

interface NotebookEmbedRendererOptions {
  readonly notebooks: NotebookSessionProvider;
  readonly path: string;
  readonly source: () => NotebookEmbedSource;
  readonly target: NotebookEmbedRenderTarget;
}

export class NotebookEmbedRenderer {
  private active = false;
  private lifecycleGeneration = 0;
  private renderGeneration = 0;
  private session: NotebookSessionLease | null = null;
  private displayedPage = 1;
  private desiredPage = 1;
  private totalPages = 0;
  private canvasBytes = 0;
  private hasCanvas = false;
  private openAbort: AbortController | null = null;
  private renderAbort: AbortController | null = null;

  constructor(private readonly options: NotebookEmbedRendererOptions) {}

  get currentPage(): number {
    return this.displayedPage;
  }

  get pageCount(): number {
    return this.totalPages;
  }

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
    this.desiredPage = this.displayedPage;
    this.releaseSession();
    this.releaseCanvas();
    this.options.target.show("idle", "Notebook will render when it is nearby.");
  }

  revisionChanged(): void {
    if (!this.active) {
      return;
    }
    this.lifecycleGeneration += 1;
    this.renderGeneration += 1;
    this.cancelOpen();
    this.cancelRender();
    this.desiredPage = this.displayedPage;
    this.releaseSession();
    this.releaseCanvas();
    void this.openRevision(++this.lifecycleGeneration);
  }

  previous(): void {
    this.goTo(this.desiredPage - 1);
  }

  next(): void {
    this.goTo(this.desiredPage + 1);
  }

  goTo(pageNumber: number): void {
    const session = this.session;
    if (!this.active || !session || this.totalPages < 1) {
      return;
    }
    const target = this.clamp(pageNumber);
    if (target === this.desiredPage) {
      return;
    }
    this.desiredPage = target;
    void this.renderPage(session, target);
  }

  rerender(): void {
    if (this.active && this.session) {
      this.desiredPage = this.displayedPage;
      void this.renderPage(this.session, this.displayedPage);
    }
  }

  dispose(): void {
    this.deactivate();
  }

  private async openRevision(generation: number): Promise<void> {
    this.cancelOpen();
    const openAbort = new AbortController();
    this.openAbort = openAbort;
    this.options.target.show("loading", "Loading notebook…");
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
      this.totalPages = opened.descriptor.pageCount;
      this.displayedPage = this.clamp(this.displayedPage);
      this.desiredPage = this.displayedPage;
      this.options.target.pageChanged(this.displayedPage, this.totalPages);
      const admission = opened.updateView({
        visible: true,
        currentPage: this.displayedPage,
        gridOpen: false,
        canvasBytes: 0,
      });
      if (!admission.admitted) {
        this.fail(
          `Not enough display memory to open ${this.options.path.split("/").at(-1) ?? this.options.path}.`,
        );
        return;
      }
      await this.renderPage(opened, this.displayedPage);
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
          ? `Could not open notebook: ${error.message}`
          : "Could not open notebook.",
      );
    } finally {
      if (this.openAbort === openAbort) {
        this.openAbort = null;
      }
    }
  }

  private async renderPage(
    session: NotebookSessionLease,
    pageNumber: number,
  ): Promise<void> {
    const generation = ++this.renderGeneration;
    this.cancelRender();
    const previousPage = this.displayedPage;
    const previousBytes = this.canvasBytes;
    const currentAdmission = session.updateView({
      visible: true,
      currentPage: pageNumber,
      gridOpen: false,
      canvasBytes: previousBytes,
    });
    if (!currentAdmission.admitted) {
      this.rejectNavigation(
        session,
        previousPage,
        previousBytes,
        `Not enough display memory to render page ${pageNumber}.`,
      );
      return;
    }
    const renderAbort = new AbortController();
    this.renderAbort = renderAbort;
    this.options.target.show("loading", `Loading page ${pageNumber}…`);
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
        pageNumber,
        maxWidth,
        "display",
        renderAbort.signal,
      );
      if (
        !this.active ||
        session !== this.session ||
        generation !== this.renderGeneration ||
        pageNumber !== this.desiredPage
      ) {
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
        currentPage: pageNumber,
        gridOpen: false,
        canvasBytes: backing.bytes,
      });
      if (!admission.admitted) {
        this.rejectNavigation(
          session,
          previousPage,
          previousBytes,
          `Not enough display memory to render page ${pageNumber}.`,
        );
        return;
      }
      this.options.target.draw(handle.bitmap, backing);
      this.canvasBytes = backing.bytes;
      this.hasCanvas = true;
      this.displayedPage = pageNumber;
      this.desiredPage = pageNumber;
      this.options.target.pageChanged(pageNumber, this.totalPages);
      this.options.target.show("ready", "");
    } catch (error) {
      if (
        this.active &&
        session === this.session &&
        generation === this.renderGeneration &&
        !this.isAbortError(error)
      ) {
        const message =
          error instanceof Error
            ? `Could not render page ${pageNumber}: ${error.message}`
            : `Could not render page ${pageNumber}.`;
        if (this.hasCanvas) {
          this.rejectNavigation(session, previousPage, previousBytes, message);
        } else {
          this.fail(message);
        }
      }
    } finally {
      if (this.renderAbort === renderAbort) {
        this.renderAbort = null;
      }
      handle?.release();
    }
  }

  private rejectNavigation(
    session: NotebookSessionLease,
    previousPage: number,
    previousBytes: number,
    message: string,
  ): void {
    this.desiredPage = previousPage;
    session.updateView({
      visible: true,
      currentPage: previousPage,
      gridOpen: false,
      canvasBytes: previousBytes,
    });
    this.options.target.pageChanged(previousPage, this.totalPages);
    this.options.target.reportError(message);
  }

  private fail(message: string): void {
    this.renderGeneration += 1;
    this.cancelOpen();
    this.cancelRender();
    this.desiredPage = this.displayedPage;
    this.releaseSession();
    this.releaseCanvas();
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

  private releaseCanvas(): void {
    this.canvasBytes = 0;
    this.hasCanvas = false;
    this.options.target.releaseCanvas();
  }

  private cancelRender(): void {
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

  private clamp(pageNumber: number): number {
    return Math.max(
      1,
      Math.min(
        this.totalPages,
        Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1,
      ),
    );
  }
}
