import { MarkdownRenderChild, TFile, type App, type EventRef } from "obsidian";

import type { NotebookSessionProvider } from "../note/notebook-service";
import { displayCanvasBoxKey } from "./display-canvas-size";
import {
  applyEmbedPresentation,
  EmbeddedPageActivation,
  embeddedPageActivationKey,
  linkBasename,
  renderedEmbedElements,
  renderedEmbedTarget,
} from "./embed-reading-dom";
import {
  NotebookEmbedRenderer,
  parseNotebookEmbed,
  type NotebookEmbedDisplayBox,
  type NotebookEmbedRenderState,
  type NotebookEmbedSpec,
} from "./notebook-embed";
import { PagerSwipeGesture } from "./pager-motion";

export interface NotebookReadingViewOptions {
  readonly app: App;
  readonly file: TFile | null;
  readonly spec: NotebookEmbedSpec;
  readonly notebooks: NotebookSessionProvider;
  readonly openReader: (pageNumber: number) => void;
}

export interface MatchedNotebookEmbed {
  readonly element: HTMLElement;
  readonly spec: NotebookEmbedSpec;
}

export const matchNotebookEmbedElements = (
  root: HTMLElement,
  sourceSpecs: readonly NotebookEmbedSpec[],
): MatchedNotebookEmbed[] => {
  const unused = new Set(sourceSpecs.map((_, index) => index));
  const matches: MatchedNotebookEmbed[] = [];
  for (const element of renderedEmbedElements(root)) {
    const target = renderedEmbedTarget(element);
    if (!target) {
      continue;
    }
    const renderedSpec = parseNotebookEmbed(`![[${target}]]`);
    if (!renderedSpec) {
      continue;
    }
    const exactSourceIndex = [...unused].find((index) => {
      const sourceSpec = sourceSpecs[index];
      return (
        sourceSpec?.linkpath.toLocaleLowerCase() ===
        renderedSpec.linkpath.toLocaleLowerCase()
      );
    });
    const sourceIndex =
      exactSourceIndex ??
      [...unused].find((index) => {
        const sourceSpec = sourceSpecs[index];
        return (
          sourceSpec &&
          linkBasename(sourceSpec.linkpath) ===
            linkBasename(renderedSpec.linkpath)
        );
      });
    const sourceSpec =
      sourceIndex === undefined ? undefined : sourceSpecs[sourceIndex];
    if (sourceIndex !== undefined) {
      unused.delete(sourceIndex);
    }
    matches.push({ element, spec: sourceSpec ?? renderedSpec });
  }
  return matches;
};

const notebookName = (file: TFile | null, linkpath: string): string =>
  file?.basename ??
  linkpath
    .split("/")
    .at(-1)
    ?.replace(/\.note$/i, "") ??
  linkpath;

export class NotebookReadingView extends MarkdownRenderChild {
  private readonly renderer: NotebookEmbedRenderer | null;
  private readonly surface: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly activation = new EmbeddedPageActivation();
  private visibilityObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private swipe: PagerSwipeGesture | null = null;
  private pointerId: number | null = null;
  private nearViewport = false;
  private canvasReady = false;
  private observedBox = "";

  constructor(
    container: HTMLElement,
    private readonly options: NotebookReadingViewOptions,
  ) {
    super(container);
    const name = notebookName(options.file, options.spec.linkpath);
    container.className = "supernote-embed-frame supernote-notebook-embed";
    container.dataset.state = "idle";
    applyEmbedPresentation(container, options.spec);

    const header = document.createElement("div");
    header.className = "supernote-embed-header supernote-notebook-header";
    const title = document.createElement("span");
    title.className = "supernote-embed-title supernote-notebook-title";
    title.textContent = name;
    const controls = document.createElement("div");
    controls.className = "supernote-embed-header-controls";
    this.previousButton = document.createElement("button");
    this.previousButton.type = "button";
    this.previousButton.textContent = "‹";
    this.previousButton.setAttribute("aria-label", "Previous page");
    this.counter = document.createElement("span");
    this.counter.className = "supernote-embed-page supernote-notebook-counter";
    this.counter.textContent = "Page 1";
    this.nextButton = document.createElement("button");
    this.nextButton.type = "button";
    this.nextButton.textContent = "›";
    this.nextButton.setAttribute("aria-label", "Next page");
    controls.append(this.previousButton, this.counter, this.nextButton);
    header.append(title, controls);
    container.appendChild(header);

    this.surface = document.createElement("div");
    this.surface.className =
      "supernote-embed-surface supernote-notebook-surface";
    this.surface.tabIndex = 0;
    this.surface.setAttribute("role", "link");
    this.surface.setAttribute("aria-label", `${name} notebook, page 1`);
    container.appendChild(this.surface);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "supernote-notebook-canvas";
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.hidden = true;
    this.surface.appendChild(this.canvas);

    this.status = document.createElement("span");
    this.status.className = "supernote-notebook-status";
    this.surface.appendChild(this.status);

    if (options.spec.caption) {
      const caption = document.createElement("figcaption");
      caption.className = "supernote-embed-caption supernote-notebook-caption";
      caption.textContent = options.spec.caption;
      container.appendChild(caption);
    }

    this.updatePage(1, 0);
    this.show("idle", "Notebook will render when it is nearby.");
    const file = options.file;
    this.renderer = file
      ? new NotebookEmbedRenderer({
          notebooks: options.notebooks,
          path: file.path,
          source: () => ({
            revision: `${file.stat.mtime}:${file.stat.size}`,
            load: async () =>
              new Uint8Array(await options.app.vault.readBinary(file)),
          }),
          target: {
            measure: () => this.measure(),
            draw: (bitmap, backing) => {
              if (this.canvas.width !== backing.width) {
                this.canvas.width = backing.width;
              }
              if (this.canvas.height !== backing.height) {
                this.canvas.height = backing.height;
              }
              const aspectRatio = `${bitmap.width} / ${bitmap.height}`;
              if (this.surface.style.aspectRatio !== aspectRatio) {
                this.surface.style.aspectRatio = aspectRatio;
              }
              const context = this.canvas.getContext("2d", { alpha: false });
              if (!context) {
                throw new Error("Canvas drawing is unavailable");
              }
              context.fillStyle = "#fff";
              context.fillRect(0, 0, backing.width, backing.height);
              context.drawImage(bitmap, 0, 0, backing.width, backing.height);
              this.canvasReady = true;
            },
            releaseCanvas: () => this.releaseCanvas(),
            show: (state, message) => this.show(state, message),
            reportError: (message) => this.reportError(message),
            pageChanged: (pageNumber, pageCount) =>
              this.updatePage(pageNumber, pageCount),
          },
        })
      : null;
  }

  onload(): void {
    this.registerDomEvent(this.previousButton, "click", () =>
      this.renderer?.previous(),
    );
    this.registerDomEvent(this.nextButton, "click", () =>
      this.renderer?.next(),
    );
    this.registerDomEvent(this.surface, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.activation.shouldActivateClick()) {
        this.options.openReader(this.renderer?.currentPage ?? 1);
      }
    });
    this.registerDomEvent(this.surface, "keydown", (event) => {
      if (!embeddedPageActivationKey(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.options.openReader(this.renderer?.currentPage ?? 1);
    });
    this.registerDomEvent(this.containerEl, "keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.renderer?.previous();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.renderer?.next();
      }
    });
    this.bindSwipe();

    if (!this.options.file || !this.renderer) {
      this.show(
        "unavailable",
        `Could not find ${this.options.spec.linkpath} in the Vault.`,
      );
      return;
    }

    const modified: EventRef = this.options.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.options.file?.path) {
        this.renderer?.revisionChanged();
      }
    });
    this.registerEvent(modified);

    this.observedBox = this.boxKey();
    this.resizeObserver = new ResizeObserver(() => {
      const next = this.boxKey();
      if (next === this.observedBox) {
        return;
      }
      this.observedBox = next;
      this.scheduleResizeRender();
    });
    this.resizeObserver.observe(this.surface);

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) {
          return;
        }
        this.nearViewport = entry.isIntersecting;
        if (entry.isIntersecting) {
          this.renderer?.activate();
        } else {
          this.resetSwipe();
          this.renderer?.deactivate();
        }
      },
      { rootMargin: "400px 0px", threshold: 0.01 },
    );
    this.visibilityObserver.observe(this.containerEl);
  }

  onunload(): void {
    this.nearViewport = false;
    this.resetSwipe();
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    this.renderer?.dispose();
  }

  private bindSwipe(): void {
    this.registerDomEvent(this.surface, "pointerdown", (event) => {
      if (
        event.pointerType === "touch" ||
        event.button !== 0 ||
        !this.renderer
      ) {
        return;
      }
      this.resetSwipe();
      this.pointerId = event.pointerId;
      this.surface.setPointerCapture(event.pointerId);
      this.swipe = this.startSwipe(
        event.clientX,
        event.clientY,
        event.timeStamp,
      );
    });
    this.registerDomEvent(this.surface, "pointermove", (event) => {
      if (event.pointerId !== this.pointerId || !this.swipe) {
        return;
      }
      const movement = this.swipe.move({
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      });
      if (movement.axis === "horizontal") {
        event.preventDefault();
        this.canvas.style.transform = `translateX(${movement.offset}px)`;
      }
    });
    this.registerDomEvent(this.surface, "pointerup", (event) => {
      if (event.pointerId !== this.pointerId) {
        return;
      }
      const swipe = this.swipe;
      this.resetSwipe();
      if (swipe) {
        this.finishSwipe(swipe, event.clientX, event.clientY, event.timeStamp);
      }
    });
    this.registerDomEvent(this.surface, "pointercancel", (event) => {
      if (event.pointerId === this.pointerId) {
        this.resetSwipe();
      }
    });
    this.registerDomEvent(
      this.surface,
      "touchstart",
      (event) => {
        const touch = event.touches[0];
        const renderer = this.renderer;
        if (!touch || event.touches.length !== 1 || !renderer) {
          this.swipe = null;
          return;
        }
        this.swipe = this.startSwipe(
          touch.clientX,
          touch.clientY,
          performance.now(),
        );
      },
      { passive: true },
    );
    this.registerDomEvent(
      this.surface,
      "touchmove",
      (event) => {
        const touch = event.touches[0];
        if (!touch || !this.swipe) {
          return;
        }
        const movement = this.swipe.move({
          x: touch.clientX,
          y: touch.clientY,
          time: performance.now(),
        });
        if (movement.axis === "horizontal") {
          event.preventDefault();
          this.canvas.style.transform = `translateX(${movement.offset}px)`;
        }
      },
      { passive: false },
    );
    this.registerDomEvent(this.surface, "touchend", (event) => {
      const touch = event.changedTouches[0];
      const swipe = this.swipe;
      this.resetSwipe();
      if (!touch || !swipe) {
        return;
      }
      this.finishSwipe(swipe, touch.clientX, touch.clientY, performance.now());
    });
    this.registerDomEvent(this.surface, "touchcancel", () => this.resetSwipe());
  }

  private startSwipe(x: number, y: number, time: number): PagerSwipeGesture {
    const renderer = this.renderer!;
    return new PagerSwipeGesture({
      start: { x, y, time },
      viewportWidth: this.surface.clientWidth,
      currentPage: renderer.currentPage,
      pageCount: renderer.pageCount,
      rtl: window.getComputedStyle(this.surface).direction === "rtl",
    });
  }

  private finishSwipe(
    swipe: PagerSwipeGesture,
    x: number,
    y: number,
    time: number,
  ): void {
    const finish = swipe.finish({ x, y, time });
    this.activation.completedGesture(finish.action);
    if (finish.action === "previous") {
      this.renderer?.previous();
    } else if (finish.action === "next") {
      this.renderer?.next();
    }
  }

  private resetSwipe(): void {
    if (
      this.pointerId !== null &&
      this.surface.hasPointerCapture(this.pointerId)
    ) {
      this.surface.releasePointerCapture(this.pointerId);
    }
    this.pointerId = null;
    this.swipe = null;
    this.canvas.style.removeProperty("transform");
  }

  private measure(): NotebookEmbedDisplayBox {
    const surfaceBox = this.surface.getBoundingClientRect();
    const width = Math.max(
      1,
      surfaceBox.width ||
        this.surface.clientWidth ||
        this.options.spec.width ||
        this.containerEl.clientWidth ||
        640,
    );
    const height = Math.max(
      1,
      surfaceBox.height ||
        this.surface.clientHeight ||
        this.options.spec.height ||
        Math.min(window.innerHeight * 0.6, 640, (width * 4) / 3),
    );
    return {
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
    };
  }

  private boxKey(): string {
    return displayCanvasBoxKey(this.measure());
  }

  private scheduleResizeRender(): void {
    if (!this.nearViewport || this.resizeFrame !== null || !this.renderer) {
      return;
    }
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      if (this.nearViewport) {
        this.renderer?.rerender();
      }
    });
  }

  private updatePage(pageNumber: number, pageCount: number): void {
    this.counter.textContent =
      pageCount > 0 ? `Page ${pageNumber} of ${pageCount}` : "Page 1";
    this.previousButton.disabled = pageCount < 1 || pageNumber <= 1;
    this.nextButton.disabled = pageCount < 1 || pageNumber >= pageCount;
    const name = notebookName(this.options.file, this.options.spec.linkpath);
    this.surface.setAttribute(
      "aria-label",
      pageCount > 0
        ? `${name} notebook, page ${pageNumber} of ${pageCount}`
        : `${name} notebook`,
    );
  }

  private releaseCanvas(): void {
    this.canvasReady = false;
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.hidden = true;
  }

  private show(state: NotebookEmbedRenderState, message: string): void {
    this.containerEl.dataset.state = state;
    this.status.textContent = message;
    this.status.hidden = state === "ready";
    this.canvas.hidden = !this.canvasReady;
    if (state === "unavailable") {
      this.previousButton.disabled = true;
      this.nextButton.disabled = true;
    }
  }

  private reportError(message: string): void {
    this.containerEl.dataset.state = "error";
    this.status.textContent = message;
    this.status.hidden = false;
    this.canvas.hidden = !this.canvasReady;
  }
}
