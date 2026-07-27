import { MarkdownRenderChild, TFile, type App, type EventRef } from "obsidian";

import type { NotebookSessionProvider } from "../note/notebook-service";
import { displayCanvasBoxKey } from "./display-canvas-size";
import {
  applyEmbedPresentation,
  linkBasename,
  renderedEmbedElements,
  renderedEmbedTarget,
} from "./embed-reading-dom";
import {
  fixedPageActivationKey,
  fixedPageEmbedAriaLabel,
  FixedPageEmbedRenderer,
  parseInvalidFixedPageEmbed,
  parseFixedPageEmbed,
  type FixedPageEmbedDisplayBox,
  type FixedPageEmbedRenderState,
  type FixedPageEmbedSpec,
  type InvalidFixedPageEmbedSpec,
} from "./fixed-page-embed";

export interface FixedPageReadingViewOptions {
  readonly app: App;
  readonly file: TFile | null;
  readonly spec: FixedPageEmbedSpec;
  readonly notebooks: NotebookSessionProvider;
  readonly openPage: () => void;
  readonly openNotebook: () => void;
}

export interface MatchedFixedPageEmbed {
  readonly element: HTMLElement;
  readonly spec: FixedPageEmbedSpec;
}

export interface MatchedInvalidFixedPageEmbed {
  readonly element: HTMLElement;
  readonly spec: InvalidFixedPageEmbedSpec;
}

const sameTarget = (
  left: FixedPageEmbedSpec,
  right: FixedPageEmbedSpec,
): boolean =>
  left.pageNumber === right.pageNumber &&
  left.linkpath.toLocaleLowerCase() === right.linkpath.toLocaleLowerCase();

export const matchFixedPageEmbedElements = (
  root: HTMLElement,
  sourceSpecs: readonly FixedPageEmbedSpec[],
): MatchedFixedPageEmbed[] => {
  const elements = renderedEmbedElements(root);
  const unused = new Set(sourceSpecs.map((_, index) => index));
  const matches: MatchedFixedPageEmbed[] = [];
  for (const element of elements) {
    const target = renderedEmbedTarget(element);
    if (!target) {
      continue;
    }
    const renderedSpec = parseFixedPageEmbed(`![[${target}]]`);
    if (!renderedSpec) {
      continue;
    }
    const exactSourceIndex = [...unused].find((index) => {
      const sourceSpec = sourceSpecs[index];
      return sourceSpec ? sameTarget(sourceSpec, renderedSpec) : false;
    });
    const sourceIndex =
      exactSourceIndex ??
      [...unused].find((index) => {
        const sourceSpec = sourceSpecs[index];
        return (
          sourceSpec?.pageNumber === renderedSpec.pageNumber &&
          linkBasename(sourceSpec.linkpath) ===
            linkBasename(renderedSpec.linkpath)
        );
      });
    if (sourceIndex === undefined) {
      matches.push({ element, spec: renderedSpec });
      continue;
    }
    const sourceSpec = sourceSpecs[sourceIndex];
    if (!sourceSpec) {
      continue;
    }
    unused.delete(sourceIndex);
    matches.push({ element, spec: sourceSpec });
  }
  return matches;
};

export const matchInvalidFixedPageEmbedElements = (
  root: HTMLElement,
  sourceSpecs: readonly InvalidFixedPageEmbedSpec[],
): MatchedInvalidFixedPageEmbed[] => {
  const elements = renderedEmbedElements(root);
  const unused = new Set(sourceSpecs.map((_, index) => index));
  const matches: MatchedInvalidFixedPageEmbed[] = [];
  for (const element of elements) {
    const target = renderedEmbedTarget(element);
    if (!target) {
      continue;
    }
    const renderedSpec = parseInvalidFixedPageEmbed(`![[${target}]]`);
    if (!renderedSpec) {
      continue;
    }
    const sourceIndex = [...unused].find((index) => {
      const sourceSpec = sourceSpecs[index];
      return (
        sourceSpec?.pageReference === renderedSpec.pageReference &&
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

const displayName = (file: TFile | null, linkpath: string): string => {
  if (file) {
    return file.basename;
  }
  return (
    linkpath
      .split("/")
      .at(-1)
      ?.replace(/\.note$/i, "") ?? linkpath
  );
};

export class FixedPageReadingView extends MarkdownRenderChild {
  private readonly renderer: FixedPageEmbedRenderer | null;
  private readonly pageLink: HTMLAnchorElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private visibilityObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private nearViewport = false;
  private observedBox = "";

  constructor(
    container: HTMLElement,
    private readonly options: FixedPageReadingViewOptions,
  ) {
    super(container);
    const name = displayName(options.file, options.spec.linkpath);
    container.className = "supernote-embed-frame supernote-fixed-page-embed";
    container.dataset.state = "idle";
    applyEmbedPresentation(container, options.spec);

    const header = document.createElement("div");
    header.className = "supernote-embed-header supernote-fixed-page-header";
    const title = document.createElement("span");
    title.className = "supernote-embed-title supernote-fixed-page-title";
    title.textContent = name;
    const pageNumberLabel = document.createElement("span");
    pageNumberLabel.className =
      "supernote-embed-page supernote-fixed-page-number";
    pageNumberLabel.textContent = `Page ${options.spec.pageNumber}`;
    header.append(title, pageNumberLabel);
    container.appendChild(header);

    this.pageLink = document.createElement("a");
    this.pageLink.className =
      "supernote-embed-surface supernote-fixed-page-surface";
    this.pageLink.href = "#";
    this.pageLink.setAttribute(
      "aria-label",
      fixedPageEmbedAriaLabel(name, options.spec.pageNumber),
    );
    container.appendChild(this.pageLink);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "supernote-fixed-page-canvas";
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.hidden = true;
    this.pageLink.appendChild(this.canvas);

    this.status = document.createElement("span");
    this.status.className = "supernote-fixed-page-status";
    this.pageLink.appendChild(this.status);

    if (options.spec.caption) {
      const caption = document.createElement("figcaption");
      caption.className =
        "supernote-embed-caption supernote-fixed-page-caption";
      caption.textContent = options.spec.caption;
      container.appendChild(caption);
    }

    this.show("idle", "Page will render when it is nearby.");
    const file = options.file;
    this.renderer = file
      ? new FixedPageEmbedRenderer({
          notebooks: options.notebooks,
          path: file.path,
          pageNumber: options.spec.pageNumber,
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
              if (this.pageLink.style.aspectRatio !== aspectRatio) {
                this.pageLink.style.aspectRatio = aspectRatio;
              }
              const context = this.canvas.getContext("2d", { alpha: false });
              if (!context) {
                throw new Error("Canvas drawing is unavailable");
              }
              context.fillStyle = "#fff";
              context.fillRect(0, 0, backing.width, backing.height);
              context.drawImage(bitmap, 0, 0, backing.width, backing.height);
            },
            releaseCanvas: () => this.releaseCanvas(),
            show: (state, message) => this.show(state, message),
          },
        })
      : null;
  }

  onload(): void {
    this.registerDomEvent(this.pageLink, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.containerEl.dataset.state === "unavailable") {
        this.options.openNotebook();
        return;
      }
      this.options.openPage();
    });
    this.registerDomEvent(this.pageLink, "keydown", (event) => {
      if (!fixedPageActivationKey(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (this.containerEl.dataset.state === "unavailable") {
        this.options.openNotebook();
        return;
      }
      this.options.openPage();
    });

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
    this.resizeObserver.observe(this.pageLink);

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
          this.renderer?.deactivate();
        }
      },
      { rootMargin: "400px 0px", threshold: 0.01 },
    );
    this.visibilityObserver.observe(this.containerEl);
  }

  onunload(): void {
    this.nearViewport = false;
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

  private measure(): FixedPageEmbedDisplayBox {
    const surfaceBox = this.pageLink.getBoundingClientRect();
    const width = Math.max(
      1,
      surfaceBox.width ||
        this.pageLink.clientWidth ||
        this.options.spec.width ||
        this.containerEl.clientWidth ||
        640,
    );
    const height = Math.max(
      1,
      surfaceBox.height ||
        this.pageLink.clientHeight ||
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

  private releaseCanvas(): void {
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.hidden = true;
  }

  private show(state: FixedPageEmbedRenderState, message: string): void {
    this.containerEl.dataset.state = state;
    this.status.textContent = message;
    this.status.hidden = state === "ready";
    this.canvas.hidden = state !== "ready";
  }
}

export interface InvalidFixedPageReadingViewOptions {
  readonly file: TFile | null;
  readonly spec: InvalidFixedPageEmbedSpec;
  readonly openNotebook: () => void;
}

export class InvalidFixedPageReadingView extends MarkdownRenderChild {
  private readonly surface: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly options: InvalidFixedPageReadingViewOptions,
  ) {
    super(container);
    const name = displayName(options.file, options.spec.linkpath);
    container.className = "supernote-embed-frame supernote-fixed-page-embed";
    container.dataset.state = "unavailable";

    const header = document.createElement("div");
    header.className = "supernote-embed-header supernote-fixed-page-header";
    const title = document.createElement("span");
    title.className = "supernote-embed-title supernote-fixed-page-title";
    title.textContent = name;
    const pageNumberLabel = document.createElement("span");
    pageNumberLabel.className =
      "supernote-embed-page supernote-fixed-page-number";
    pageNumberLabel.textContent = options.spec.pageReference
      ? `Page ${options.spec.pageReference}`
      : "Invalid page";
    header.append(title, pageNumberLabel);
    container.appendChild(header);

    this.surface = document.createElement("div");
    this.surface.className =
      "supernote-embed-surface supernote-fixed-page-surface";
    this.surface.tabIndex = 0;
    this.surface.setAttribute("role", "link");
    this.surface.setAttribute(
      "aria-label",
      `${name}, ${options.spec.message}. Open notebook`,
    );
    this.surface.textContent = options.spec.message;
    container.appendChild(this.surface);
  }

  onload(): void {
    this.registerDomEvent(this.surface, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.openNotebook();
    });
    this.registerDomEvent(this.surface, "keydown", (event) => {
      if (!fixedPageActivationKey(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.options.openNotebook();
    });
  }
}
