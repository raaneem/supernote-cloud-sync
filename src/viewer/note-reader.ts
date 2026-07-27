import {
  Modal,
  Notice,
  Platform,
  Setting,
  setIcon,
  type App,
  type EventRef,
} from "obsidian";

import type {
  NotebookBitmapHandle,
  NotebookSessionLease,
} from "../note/notebook-service";
import {
  isNotebookRenderCancelledError,
  isNotebookRenderingUnavailableError,
} from "../note/notebook-service";
import {
  defaultExportFilename,
  type ExportDefaults,
  type PageExportResult,
} from "../export/export-service";
import type { ExportFormat } from "../sync/manifest";
import {
  addApiModelPicker,
  addClaudeModelPicker,
} from "../ui/transcription-model-picker";
import type {
  TranscriptionEngine,
  TranscriptionSelection,
} from "../ocr/configuration";
import { VaultFolderPickerModal } from "../ui/vault-folder-picker-modal";
import {
  availableExportFormats,
  coerceAvailableExportFormat,
  EXPORT_FORMAT_LABELS,
  isDocumentExportFormat,
  type TranscriptionAvailability,
} from "./export-options";
import { fixedPageEmbedMarkdown } from "./fixed-page-embed";
import { notebookEmbedMarkdown } from "./notebook-embed";
import {
  admittedPageTransition,
  navigationTarget,
  pageTransitionCommitDecision,
  pageTransitionRenderTarget,
  PagerSwipeGesture,
  reducedMotionRequested,
  type PageDirection,
} from "./pager-motion";
import {
  gridPageNumbers,
  gridScrollTopForPage,
  planGridWindow,
} from "./grid-window";
import {
  ReaderFrameBatcher,
  type ReaderFrameWrites,
} from "./reader-frame-batcher";
import {
  fitPageWithin,
  readerKeyboardZoomIntent,
  readerTouchStartIntent,
  ReaderDoubleTapGesture,
  ReaderViewportTransform,
  type ViewportPoint,
} from "./reader-viewport";
import { displayCanvasBackingSize } from "./display-canvas-size";
import type {
  ReaderToolbarActionId,
  ReaderToolbarContext,
} from "./reader-toolbar";
import { NoteViewerState } from "./state";

export interface ViewerExportOptions {
  selectedPages: readonly number[];
  useOcr: boolean;
  format: ExportFormat;
  filename: string;
  destination: string;
  customPrompt?: string;
  transcription?: TranscriptionSelection;
}

export type ViewerExporter = (
  rawNotePath: string,
  options: ViewerExportOptions,
  displayedSession?: NotebookSessionLease,
) => Promise<PageExportResult | null>;

export type ViewerExportDefaults = (
  rawNotePath: string,
) => Promise<ExportDefaults>;

interface NoteReaderOptions {
  app: App;
  container: HTMLElement;
  rawNotePath: string;
  session: NotebookSessionLease;
  getTranscriptionAvailability: () => TranscriptionAvailability;
  getTargetFolder: () => string;
  exportPages: ViewerExporter;
  getExportDefaults: ViewerExportDefaults;
  initialPage?: number;
  initialSelectedPages?: readonly number[];
  initialPageHandle?: {
    pageNumber: number;
    handle: NotebookBitmapHandle;
  };
  toolbarChanged?: (context: ReaderToolbarContext) => void;
}

interface PageSurface {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  pageNumber: number | null;
  renderSequence: number;
}

interface PageSurfaces {
  previous: PageSurface;
  current: PageSurface;
  next: PageSurface;
}

interface ActiveTransition {
  targetPage: number;
  direction: PageDirection;
}

interface PageSurfacePlan {
  incoming: PageSurface;
  committed: PageSurfaces;
}

const iconButton = (
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement => {
  const button = parent.createEl("button", {
    cls: "clickable-icon supernote-reader-icon",
    attr: { "aria-label": label },
  });
  setIcon(button, icon);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
};

export class NoteReader {
  private readonly state: NoteViewerState;
  private readonly root: HTMLElement;
  private viewport: HTMLElement | null = null;
  private track: HTMLElement | null = null;
  private surfaces: PageSurfaces | null = null;
  private chrome: HTMLElement | null = null;
  private counter: HTMLElement | null = null;
  private zoomControl: HTMLElement | null = null;
  private zoomOutButton: HTMLButtonElement | null = null;
  private zoomValueButton: HTMLButtonElement | null = null;
  private zoomInButton: HTMLButtonElement | null = null;
  private committedZoomControlKey: string | null = null;
  private chromeTimer: number | null = null;
  private chromeLastActivity = 0;
  private transformAnimationTimer: number | null = null;
  private transitionTimer: number | null = null;
  private transitionFrame: number | null = null;
  private backingRefreshFrame: number | null = null;
  private transitionGeneration = 0;
  private transitionCompletion: (() => void) | null = null;
  private activeTransition: ActiveTransition | null = null;
  private transitionAnimationComplete = false;
  private grid: HTMLElement | null = null;
  private gridSpacer: HTMLElement | null = null;
  private gridWindow: HTMLElement | null = null;
  private gridWindowKey = "";
  private gridFrame: number | null = null;
  private gridResizeObserver: ResizeObserver | null = null;
  private gridSelecting = false;
  private gridLongPressTimer: number | null = null;
  private gridLongPressOrigin: { x: number; y: number } | null = null;
  private gridLongPressPage: number | null = null;
  private gridLongPressedPage: number | null = null;
  private gridLongPressedAt = 0;
  private readonly visibilityObserver: IntersectionObserver;
  private readonly readerResizeObserver: ResizeObserver;
  private readonly environmentObserver: MutationObserver;
  private readonly motionMedia: MediaQueryList | null;
  private readonly workspaceCssEvent: EventRef;
  private readonly frameBatcher: ReaderFrameBatcher;
  private renderSequence = 0;
  private gridGeneration = 0;
  private pagerPreparationGeneration = 0;
  private visible = true;
  private viewMode: "pager" | "grid" = "pager";
  private rtl = false;
  private reducedMotion = false;
  private initialPageHandle: NoteReaderOptions["initialPageHandle"];
  private readonly canvasAllocations = new Map<HTMLCanvasElement, number>();
  private retainedCanvasBytes = 0;
  private readonly viewportTransform = new ReaderViewportTransform({
    viewport: { width: 1, height: 1 },
    page: { width: 1, height: 1 },
  });
  private readonly doubleTapGesture = new ReaderDoubleTapGesture();
  private suppressDblClickUntil = 0;
  private swipeGesture: PagerSwipeGesture | null = null;
  private swipeOffset = 0;
  private pinchDistance: number | null = null;
  private dragging: { x: number; y: number } | null = null;
  private resourceBudgetNoticeShown = false;
  private initialPageAdmissionRejected = false;
  private pageDisplayBounds: { width: number; height: number } | null = null;
  private toolbarNotificationsEnabled = false;

  constructor(private readonly options: NoteReaderOptions) {
    this.state = new NoteViewerState(
      options.session.descriptor.pageCount,
      options.initialPage,
    );
    for (const pageNumber of options.initialSelectedPages ?? []) {
      if (
        Number.isInteger(pageNumber) &&
        pageNumber >= 1 &&
        pageNumber <= options.session.descriptor.pageCount
      ) {
        this.state.toggleSelected(pageNumber);
      }
    }
    this.initialPageHandle = options.initialPageHandle;
    this.root = options.container.createDiv({
      cls: "supernote-reader",
    });
    this.motionMedia =
      window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.frameBatcher = new ReaderFrameBatcher(
      (callback) => window.requestAnimationFrame(callback),
      (handle) => window.cancelAnimationFrame(handle),
      (writes) => this.commitFrameWrites(writes),
    );
    this.refreshMotionPreferences();
    this.motionMedia?.addEventListener("change", this.handleEnvironmentChange);
    this.workspaceCssEvent = options.app.workspace.on(
      "css-change",
      this.handleEnvironmentChange,
    );
    this.root.tabIndex = 0;
    this.bindReaderEvents();
    this.visibilityObserver = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) {
        this.setVisible(entry.isIntersecting);
      }
    });
    this.visibilityObserver.observe(this.root);
    this.readerResizeObserver = new ResizeObserver(() => {
      if (this.refreshPageDisplayBounds()) {
        if (this.syncTransformGeometry()) {
          this.applyTransform();
        }
        this.schedulePageBackingRefresh();
      }
    });
    this.readerResizeObserver.observe(this.root);
    this.environmentObserver = new MutationObserver(
      this.handleEnvironmentChange,
    );
    this.environmentObserver.observe(this.root.ownerDocument.body, {
      attributes: true,
      attributeFilter: ["class", "dir"],
    });
    this.environmentObserver.observe(this.root.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ["class", "dir"],
    });
    this.renderPager();
    this.toolbarNotificationsEnabled = true;
  }

  get currentPage(): number {
    return this.state.currentPage;
  }

  get selectedPages(): readonly number[] {
    return this.state.selectedPages;
  }

  get pageCount(): number {
    return this.state.pageCount;
  }

  get sourcePath(): string {
    return this.options.rawNotePath;
  }

  get revision(): string {
    return this.options.session.descriptor.revision;
  }

  get rejectedInitialPageAdmission(): boolean {
    return this.initialPageAdmissionRejected;
  }

  get toolbarContext(): ReaderToolbarContext {
    return {
      mode: this.viewMode,
      selecting: this.gridSelecting,
      selectedPages: this.state.selectedPages.length,
    };
  }

  attachTo(container: HTMLElement): void {
    this.visibilityObserver.disconnect();
    container.appendChild(this.root);
    this.visibilityObserver.observe(this.root);
  }

  goToPage(pageNumber: number): void {
    if (this.root.hasClass("is-grid")) {
      this.renderPager(pageNumber);
      return;
    }
    this.showPage(pageNumber);
  }

  runToolbarAction(action: ReaderToolbarActionId): void {
    switch (action) {
      case "pages":
        this.renderGrid();
        break;
      case "copy-page":
        void this.copyCurrentPageEmbed();
        break;
      case "copy-notebook":
        void this.copyNotebookEmbed();
        break;
      case "export-current":
        this.state.clearSelection();
        this.state.toggleSelected(this.state.currentPage);
        void this.openExportSheet();
        break;
      case "back":
        this.renderPager();
        break;
      case "toggle-selection":
        this.setGridSelecting(!this.gridSelecting);
        break;
      case "export-selected":
        void this.openExportSheet();
        break;
    }
  }

  destroy(): void {
    this.renderSequence += 1;
    this.pagerPreparationGeneration += 1;
    this.destroyGridResources();
    this.visibilityObserver.disconnect();
    this.readerResizeObserver.disconnect();
    this.environmentObserver.disconnect();
    this.motionMedia?.removeEventListener(
      "change",
      this.handleEnvironmentChange,
    );
    this.options.app.workspace.offref(this.workspaceCssEvent);
    this.frameBatcher.cancel();
    this.cancelPageBackingRefresh();
    this.clearTransitionTimer();
    if (this.chromeTimer !== null) {
      window.clearTimeout(this.chromeTimer);
    }
    this.clearTransformAnimation();
    this.initialPageHandle?.handle.release();
    this.initialPageHandle = undefined;
    this.releaseCanvasResources(false);
    this.options.session.updateView({
      visible: false,
      currentPage: null,
      gridOpen: false,
      canvasBytes: 0,
    });
    this.options.session.close();
    this.root.remove();
  }

  private bindReaderEvents(): void {
    this.root.addEventListener("keydown", (event) => {
      const zoomIntent = readerKeyboardZoomIntent({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        editable: this.isEditableTarget(event.target),
      });
      if (zoomIntent) {
        event.preventDefault();
        if (zoomIntent === "in") {
          this.changeZoomByStep(1);
        } else if (zoomIntent === "out") {
          this.changeZoomByStep(-1);
        } else {
          this.returnToFit();
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.navigateBy(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.navigateBy(1);
      }
    });
    this.root.addEventListener("mousemove", () => this.revealChrome());
    this.root.addEventListener("click", () => this.revealChrome());
  }

  private renderPager(
    targetPage?: number,
    preparedCurrent?: PageSurface,
  ): void {
    if (this.viewMode === "grid" && preparedCurrent === undefined) {
      void this.preparePagerFromGrid(
        this.clampPage(targetPage ?? this.state.currentPage),
      );
      return;
    }
    const generation = ++this.renderSequence;
    this.pagerPreparationGeneration += 1;
    this.refreshPageDisplayBounds();
    this.viewMode = "pager";
    this.destroyGridResources();
    this.frameBatcher.cancel();
    this.clearTransformAnimation();
    this.cancelPageBackingRefresh();
    this.clearTransition();
    if (!preparedCurrent) {
      this.releaseCanvasResources(false);
    }
    this.root.empty();
    this.root.removeClass("is-grid");
    this.root.removeClass("is-selecting", "is-motion-active");
    this.chrome = null;
    this.counter = null;
    this.zoomControl = null;
    this.zoomOutButton = null;
    this.zoomValueButton = null;
    this.zoomInButton = null;
    this.committedZoomControlKey = null;
    this.viewportTransform.reset();

    const chrome = this.root.createDiv({
      cls: "supernote-reader-chrome",
    });
    this.chrome = chrome;

    this.viewport = this.root.createDiv({
      cls: "supernote-reader-viewport",
    });
    this.track = this.viewport.createDiv({
      cls: "supernote-reader-track",
    });
    this.surfaces = {
      previous: this.createPageSurface(),
      current: preparedCurrent ?? this.createPageSurface(),
      next: this.createPageSurface(),
    };
    this.track.addEventListener("transitionend", this.handleTrackTransitionEnd);
    this.updateSessionView();
    this.syncSurfaceOrder();
    this.writeTrackPosition(-100, 0);
    this.prepareSurface(this.surfaces.current, this.state.currentPage);
    this.prepareSurface(this.surfaces.previous, this.state.currentPage - 1);
    this.prepareSurface(this.surfaces.next, this.state.currentPage + 1);
    this.updateSurfaceAccessibility();
    this.bindCanvasGestures(this.viewport);

    const bottom = chrome.createDiv({
      cls: "supernote-reader-bottombar",
    });
    iconButton(bottom, "chevron-left", "Previous page", () => {
      this.navigateBy(-1);
    });
    this.counter = bottom.createDiv({
      cls: "supernote-reader-counter",
      text: `${this.state.currentPage} / ${this.state.pageCount}`,
    });
    iconButton(bottom, "chevron-right", "Next page", () => {
      this.navigateBy(1);
    });
    this.createZoomControl(chrome);

    this.updateCounter();
    this.syncTransformGeometry();
    this.syncZoomControl();
    this.notifyToolbarChanged();
    this.revealChrome();
    this.root.focus();
    if (
      targetPage !== undefined &&
      this.clampPage(targetPage) !== this.state.currentPage
    ) {
      window.requestAnimationFrame(() => {
        if (generation === this.renderSequence) {
          this.showPage(targetPage);
        }
      });
    }
  }

  private async preparePagerFromGrid(targetPage: number): Promise<void> {
    const preparation = ++this.pagerPreparationGeneration;
    const gridGeneration = this.gridGeneration;
    this.refreshPageDisplayBounds();
    let surface: PageSurface | null = null;
    try {
      const handle = await this.options.session.bitmap(targetPage);
      try {
        if (
          preparation !== this.pagerPreparationGeneration ||
          gridGeneration !== this.gridGeneration ||
          this.viewMode !== "grid"
        ) {
          return;
        }
        surface = this.createPageSurface();
        surface.pageNumber = targetPage;
        surface.element.addClass("is-loading");
        surface.canvas.addClass("is-loading");
        surface.canvas.setAttr(
          "aria-label",
          `Page ${targetPage} of ${this.state.pageCount}`,
        );
        if (!this.drawSurfaceBitmap(surface, targetPage, handle.bitmap)) {
          this.disposePageSurface(surface);
          surface = null;
          return;
        }
      } finally {
        handle.release();
      }
      if (
        !surface ||
        preparation !== this.pagerPreparationGeneration ||
        gridGeneration !== this.gridGeneration ||
        this.viewMode !== "grid"
      ) {
        if (surface) {
          this.disposePageSurface(surface);
        }
        return;
      }
      this.state.goTo(targetPage);
      this.renderPager(undefined, surface);
    } catch (error) {
      if (surface) {
        this.disposePageSurface(surface);
      }
      if (
        preparation === this.pagerPreparationGeneration &&
        gridGeneration === this.gridGeneration &&
        this.viewMode === "grid" &&
        !isNotebookRenderingUnavailableError(error) &&
        !isNotebookRenderCancelledError(error)
      ) {
        new Notice(
          error instanceof Error
            ? error.message
            : "Could not render this Supernote page.",
          10_000,
        );
      }
    }
  }

  private disposePageSurface(surface: PageSurface): void {
    this.releaseCanvasResource(surface.canvas);
    surface.canvas.width = 1;
    surface.canvas.height = 1;
    surface.element.remove();
  }

  private createPageSurface(): PageSurface {
    const element = document.createElement("div");
    element.addClass("supernote-reader-surface");
    const canvas = element.createEl("canvas", {
      cls: "supernote-reader-canvas is-loading",
      attr: { width: "1", height: "1" },
    });
    this.resizeCanvas(canvas, 3, 4);
    return {
      element,
      canvas,
      pageNumber: null,
      renderSequence: 0,
    };
  }

  private navigateBy(delta: -1 | 1): void {
    this.showPage(
      navigationTarget(
        this.state.currentPage,
        this.activeTransition?.targetPage ?? null,
        delta,
        this.state.pageCount,
      ),
    );
  }

  private showPage(pageNumber: number, dragOffset = 0): void {
    const targetPage = this.clampPage(pageNumber);
    if (this.activeTransition !== null) {
      this.commitTransition();
      if (this.activeTransition !== null) {
        return;
      }
    } else {
      this.clearTransitionTimer();
    }
    const surfaces = this.surfaces;
    const track = this.track;
    if (!surfaces || !track) {
      return;
    }

    const transition = admittedPageTransition(
      this.state.currentPage,
      targetPage,
      this.isRtl(),
      (page) =>
        this.admitSessionView({
          visible: this.visible,
          currentPage: this.visible ? page : null,
          gridOpen: false,
          canvasBytes: this.retainedCanvasBytes,
        }),
    );
    if (!transition) {
      this.snapTrackBack(dragOffset);
      return;
    }

    this.activeTransition = {
      targetPage,
      direction: transition.direction,
    };
    this.transitionAnimationComplete = false;
    this.resetTransformState();
    this.applyTransform();
    this.prepareSurface(
      this.surfacePlan(transition.direction).incoming,
      targetPage,
    );

    if (this.prefersReducedMotion()) {
      this.transitionAnimationComplete = true;
      this.commitTransition();
      return;
    }

    this.startTrackAnimation(transition.trackPercent, dragOffset, () => {
      this.transitionAnimationComplete = true;
      this.commitTransition();
    });
  }

  private prepareSurface(surface: PageSurface, pageNumber: number): void {
    if (pageNumber < 1 || pageNumber > this.state.pageCount) {
      surface.renderSequence += 1;
      surface.pageNumber = null;
      surface.element.addClass("is-empty");
      surface.element.removeClass("is-loading", "is-error");
      surface.canvas.setAttr("aria-hidden", "true");
      return;
    }
    if (
      surface.pageNumber === pageNumber &&
      !surface.element.hasClass("is-error")
    ) {
      return;
    }

    surface.pageNumber = pageNumber;
    surface.element.removeClass("is-empty", "is-error");
    surface.element.addClass("is-loading");
    surface.canvas.addClass("is-loading");
    this.resizeCanvas(surface.canvas, 3, 4);
    surface.canvas.setAttr(
      "aria-label",
      `Page ${pageNumber} of ${this.state.pageCount}`,
    );
    const sequence = ++surface.renderSequence;
    const generation = this.renderSequence;
    if (this.initialPageHandle?.pageNumber === pageNumber) {
      const handle = this.initialPageHandle.handle;
      this.initialPageHandle = undefined;
      try {
        if (!this.drawSurfaceBitmap(surface, pageNumber, handle.bitmap)) {
          this.initialPageAdmissionRejected = true;
        }
      } finally {
        handle.release();
      }
      return;
    }
    void this.renderSurface(surface, pageNumber, sequence, generation);
  }

  private async renderSurface(
    surface: PageSurface,
    pageNumber: number,
    sequence: number,
    generation: number,
  ): Promise<void> {
    try {
      const handle = await this.options.session.bitmap(pageNumber);
      try {
        if (
          generation !== this.renderSequence ||
          sequence !== surface.renderSequence ||
          surface.pageNumber !== pageNumber
        ) {
          return;
        }
        this.drawSurfaceBitmap(surface, pageNumber, handle.bitmap);
      } finally {
        handle.release();
      }
    } catch (error) {
      if (
        generation !== this.renderSequence ||
        sequence !== surface.renderSequence
      ) {
        return;
      }
      surface.element.removeClass("is-loading");
      surface.element.addClass("is-error");
      surface.canvas.removeClass("is-loading");
      const rejectedTransition =
        this.activeTransition?.targetPage === pageNumber;
      if (this.surfaces?.current === surface || rejectedTransition) {
        if (
          !isNotebookRenderingUnavailableError(error) &&
          !isNotebookRenderCancelledError(error)
        ) {
          new Notice(
            error instanceof Error
              ? error.message
              : "Could not render this Supernote page.",
            10_000,
          );
        }
      }
      if (rejectedTransition) {
        this.abortTransition();
      }
    }
  }

  private drawSurfaceBitmap(
    surface: PageSurface,
    pageNumber: number,
    bitmap: ImageBitmap,
    preserveOnRejection = false,
  ): boolean {
    const canvas = surface.canvas;
    canvas.style.setProperty(
      "--supernote-page-aspect-ratio",
      `${bitmap.width} / ${bitmap.height}`,
    );
    const fallbackWidth = Platform.isMobile
      ? Math.min(bitmap.width, 960)
      : bitmap.width;
    const fallbackHeight = Math.max(
      1,
      Math.round((bitmap.height * fallbackWidth) / bitmap.width),
    );
    const displayBounds = this.pageDisplayBounds;
    const backing = displayCanvasBackingSize({
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      displayWidth:
        Platform.isMobile && displayBounds
          ? displayBounds.width
          : fallbackWidth,
      displayHeight:
        Platform.isMobile && displayBounds
          ? displayBounds.height
          : fallbackHeight,
      devicePixelRatio: Platform.isMobile ? window.devicePixelRatio : 1,
    });
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error(`Could not draw Supernote page ${pageNumber}`);
    }
    if (!this.resizeCanvas(canvas, backing.width, backing.height)) {
      if (preserveOnRejection) {
        return false;
      }
      surface.element.removeClass("is-loading");
      surface.element.addClass("is-error");
      canvas.removeClass("is-loading");
      if (this.activeTransition?.targetPage === pageNumber) {
        this.abortTransition();
      }
      return false;
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, backing.width, backing.height);
    surface.element.removeClass("is-loading");
    canvas.removeClass("is-loading");
    if (this.surfaces?.current === surface) {
      this.syncTransformGeometry();
      this.applyTransform();
    }
    if (
      this.activeTransition?.targetPage === pageNumber &&
      this.transitionAnimationComplete
    ) {
      this.commitTransition();
    }
    return true;
  }

  private commitTransition(): void {
    const transition = this.activeTransition;
    const surfaces = this.surfaces;
    if (!transition || !surfaces) {
      return;
    }

    const incoming = this.surfacePlan(transition.direction).incoming;
    const decision = pageTransitionCommitDecision({
      animationComplete: this.transitionAnimationComplete,
      incomingState: incoming.element.hasClass("is-loading")
        ? "loading"
        : incoming.element.hasClass("is-error")
          ? "error"
          : "ready",
    });
    if (decision === "wait") {
      return;
    }
    if (decision === "abort") {
      this.abortTransition();
      return;
    }
    this.clearTransitionTimer();
    const { targetPage, direction } = transition;
    if (
      !this.admitSessionView({
        visible: this.visible,
        currentPage: this.visible ? targetPage : null,
        gridOpen: false,
        canvasBytes: this.retainedCanvasBytes,
      })
    ) {
      this.abortTransition();
      return;
    }
    this.activeTransition = null;
    this.transitionAnimationComplete = false;
    this.state.goTo(targetPage);
    this.resetTransformState();
    this.surfaces = this.surfacePlan(direction).committed;
    this.syncSurfaceOrder();
    this.track?.removeClass("is-animating");
    this.root.removeClass("is-motion-active");
    this.frameBatcher.cancel();
    this.writeTrackPosition(-100, 0);
    this.prepareSurface(this.surfaces.current, targetPage);
    this.prepareSurface(this.surfaces.previous, targetPage - 1);
    this.prepareSurface(this.surfaces.next, targetPage + 1);
    this.updateSurfaceAccessibility();
    this.applyTransform();
    this.updateCounter();
  }

  private surfacePlan(direction: PageDirection): PageSurfacePlan {
    const surfaces = this.surfaces;
    if (!surfaces) {
      throw new Error("Supernote reader surfaces are not mounted");
    }
    return direction === "next"
      ? {
          incoming: surfaces.next,
          committed: {
            previous: surfaces.current,
            current: surfaces.next,
            next: surfaces.previous,
          },
        }
      : {
          incoming: surfaces.previous,
          committed: {
            previous: surfaces.next,
            current: surfaces.previous,
            next: surfaces.current,
          },
        };
  }

  private syncSurfaceOrder(): void {
    if (!this.track || !this.surfaces) {
      return;
    }
    const ordered = this.isRtl()
      ? [this.surfaces.next, this.surfaces.current, this.surfaces.previous]
      : [this.surfaces.previous, this.surfaces.current, this.surfaces.next];
    for (const surface of ordered) {
      this.track.appendChild(surface.element);
    }
  }

  private updateSurfaceAccessibility(): void {
    if (!this.surfaces) {
      return;
    }
    this.surfaces.previous.canvas.setAttr("aria-hidden", "true");
    this.surfaces.current.canvas.removeAttribute("aria-hidden");
    this.surfaces.next.canvas.setAttr("aria-hidden", "true");
  }

  private startTrackAnimation(
    targetPercent: number,
    startOffset: number,
    onComplete: () => void,
  ): void {
    const track = this.track;
    if (!track) {
      return;
    }
    this.clearTransitionTimer();
    this.frameBatcher.flush();
    track.removeClass("is-animating");
    this.root.removeClass("is-motion-active");
    this.writeTrackPosition(-100, startOffset);
    const duration = Platform.isMobile ? 250 : 150;
    track.style.setProperty(
      "--supernote-reader-slide-duration",
      `${duration}ms`,
    );
    const generation = ++this.transitionGeneration;
    this.transitionCompletion = onComplete;
    this.transitionFrame = window.requestAnimationFrame(() => {
      this.transitionFrame = null;
      if (generation !== this.transitionGeneration || track !== this.track) {
        return;
      }
      this.root.addClass("is-motion-active");
      track.addClass("is-animating");
      this.writeTrackPosition(targetPercent, 0);
      this.transitionTimer = window.setTimeout(
        () => this.finishTrackAnimation(generation),
        duration + 50,
      );
    });
  }

  private snapTrackBack(offset: number): void {
    if (!this.track) {
      return;
    }
    if (this.prefersReducedMotion() || offset === 0) {
      this.track.removeClass("is-animating");
      this.root.removeClass("is-motion-active");
      this.writeTrackPosition(-100, 0);
      return;
    }
    this.startTrackAnimation(-100, offset, () => {
      this.track?.removeClass("is-animating");
      this.root.removeClass("is-motion-active");
      this.writeTrackPosition(-100, 0);
      this.clearTransitionTimer();
    });
  }

  private clearTransition(): void {
    this.activeTransition = null;
    this.transitionAnimationComplete = false;
    this.clearTransitionTimer();
    this.track?.removeClass("is-animating");
    this.root.removeClass("is-motion-active");
  }

  private abortTransition(): void {
    this.activeTransition = null;
    this.transitionAnimationComplete = false;
    this.clearTransitionTimer();
    this.track?.removeClass("is-animating");
    this.root.removeClass("is-motion-active");
    this.frameBatcher.cancel();
    this.writeTrackPosition(-100, 0);
    this.updateSessionView();
  }

  private clearTransitionTimer(): void {
    this.transitionGeneration += 1;
    this.transitionCompletion = null;
    if (this.transitionFrame !== null) {
      window.cancelAnimationFrame(this.transitionFrame);
      this.transitionFrame = null;
    }
    if (this.transitionTimer !== null) {
      window.clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  private finishTrackAnimation(generation: number): void {
    if (generation !== this.transitionGeneration) {
      return;
    }
    if (this.transitionTimer !== null) {
      window.clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    const completion = this.transitionCompletion;
    this.transitionCompletion = null;
    completion?.();
  }

  private readonly handleTrackTransitionEnd = (
    event: TransitionEvent,
  ): void => {
    if (event.target !== this.track || event.propertyName !== "transform") {
      return;
    }
    this.finishTrackAnimation(this.transitionGeneration);
  };

  private queueTrackPosition(percent: number, pixelOffset: number): void {
    this.frameBatcher.schedule({
      track: { percent, pixelOffset },
    });
  }

  private writeTrackPosition(percent: number, pixelOffset: number): void {
    if (!this.track) {
      return;
    }
    this.track.style.transform = `translate3d(calc(${percent}% + ${pixelOffset}px), 0, 0)`;
  }

  private clampPage(pageNumber: number): number {
    if (!Number.isFinite(pageNumber)) {
      return 1;
    }
    return Math.max(1, Math.min(this.state.pageCount, Math.trunc(pageNumber)));
  }

  private isRtl(): boolean {
    return this.rtl;
  }

  private prefersReducedMotion(): boolean {
    return this.reducedMotion;
  }

  private readonly handleEnvironmentChange = (): void => {
    const previousRtl = this.rtl;
    this.refreshMotionPreferences();
    if (previousRtl !== this.rtl && this.viewMode === "pager") {
      this.syncSurfaceOrder();
      this.frameBatcher.cancel();
      this.writeTrackPosition(-100, 0);
    }
  };

  private refreshMotionPreferences(): void {
    const documentElement = this.root.ownerDocument.documentElement;
    const body = this.root.ownerDocument.body;
    const obsidianClassSignal =
      documentElement.hasClass("reduce-motion") ||
      documentElement.hasClass("is-reduced-motion") ||
      body.hasClass("reduce-motion") ||
      body.hasClass("is-reduced-motion");
    this.rtl = window.getComputedStyle(this.root).direction === "rtl";
    this.reducedMotion =
      obsidianClassSignal ||
      reducedMotionRequested(
        this.motionMedia?.matches ?? false,
        window
          .getComputedStyle(this.root)
          .getPropertyValue("--anim-duration-fast"),
      );
  }

  private updateSessionView(): boolean {
    return this.admitSessionView({
      visible: this.visible,
      currentPage:
        this.visible && this.viewMode === "pager"
          ? pageTransitionRenderTarget(
              this.state.currentPage,
              this.activeTransition?.targetPage ?? null,
            )
          : null,
      gridOpen: this.visible && this.viewMode === "grid",
      canvasBytes: this.retainedCanvasBytes,
    });
  }

  private admitSessionView(
    view: Parameters<NotebookSessionLease["updateView"]>[0],
    notifyRejection = true,
  ): boolean {
    const admission = this.options.session.updateView(view);
    if (admission.admitted) {
      return true;
    }
    if (
      notifyRejection &&
      this.visible &&
      admission.reason === "resource-budget" &&
      !this.resourceBudgetNoticeShown
    ) {
      this.resourceBudgetNoticeShown = true;
      new Notice(
        "This Supernote view needs more display memory. Close another reader or the page grid, then try again.",
        10_000,
      );
    }
    return false;
  }

  private resizeCanvas(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    notifyRejection = true,
  ): boolean {
    const bytes = width * height * 4;
    const previous = this.canvasAllocations.get(canvas) ?? 0;
    const retainedCanvasBytes = this.retainedCanvasBytes - previous + bytes;
    if (
      !this.admitSessionView(
        {
          visible: this.visible,
          currentPage:
            this.visible && this.viewMode === "pager"
              ? pageTransitionRenderTarget(
                  this.state.currentPage,
                  this.activeTransition?.targetPage ?? null,
                )
              : null,
          gridOpen: this.visible && this.viewMode === "grid",
          canvasBytes: retainedCanvasBytes,
        },
        notifyRejection,
      )
    ) {
      return false;
    }
    canvas.width = width;
    canvas.height = height;
    this.canvasAllocations.set(canvas, bytes);
    this.retainedCanvasBytes = retainedCanvasBytes;
    return true;
  }

  private releaseCanvasResources(notify = true): void {
    for (const canvas of this.canvasAllocations.keys()) {
      canvas.width = 1;
      canvas.height = 1;
    }
    this.canvasAllocations.clear();
    this.retainedCanvasBytes = 0;
    if (notify) {
      this.updateSessionView();
    }
  }

  private releaseCanvasResource(
    canvas: HTMLCanvasElement,
    notifyRejection = true,
  ): void {
    const bytes = this.canvasAllocations.get(canvas);
    if (bytes === undefined) {
      return;
    }
    const retainedCanvasBytes = Math.max(0, this.retainedCanvasBytes - bytes);
    canvas.width = 1;
    canvas.height = 1;
    this.canvasAllocations.delete(canvas);
    this.retainedCanvasBytes = retainedCanvasBytes;
    if (notifyRejection) {
      this.updateSessionView();
    }
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.refreshDisplayResources();
      return;
    }
    this.renderSequence += 1;
    this.pagerPreparationGeneration += 1;
    this.destroyGridResources();
    this.frameBatcher.cancel();
    this.cancelPageBackingRefresh();
    this.clearTransition();
    this.releaseCanvasResources();
  }

  private refreshDisplayResources(): void {
    if (!this.visible) {
      this.updateSessionView();
      return;
    }
    if (this.viewMode === "grid") {
      this.renderGrid(true);
    } else {
      this.renderPager();
    }
  }

  private refreshPageDisplayBounds(): boolean {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width <= 0 || height <= 0) {
      return false;
    }
    const next = {
      width: Math.max(1, width - (Platform.isMobile ? 8 : 32)),
      height: Math.max(1, height - 32),
    };
    if (
      this.pageDisplayBounds?.width === next.width &&
      this.pageDisplayBounds.height === next.height
    ) {
      return false;
    }
    this.pageDisplayBounds = next;
    return true;
  }

  private schedulePageBackingRefresh(): void {
    if (
      !Platform.isMobile ||
      !this.visible ||
      this.viewMode !== "pager" ||
      !this.surfaces ||
      this.backingRefreshFrame !== null
    ) {
      return;
    }
    this.backingRefreshFrame = window.requestAnimationFrame(() => {
      this.backingRefreshFrame = null;
      const surfaces = this.surfaces;
      if (!surfaces || !this.visible || this.viewMode !== "pager") {
        return;
      }
      for (const surface of Object.values(surfaces)) {
        if (
          surface.pageNumber !== null &&
          !surface.element.hasClass("is-loading", "is-error")
        ) {
          void this.refreshSurfaceBacking(surface, surface.pageNumber);
        }
      }
    });
  }

  private cancelPageBackingRefresh(): void {
    if (this.backingRefreshFrame === null) {
      return;
    }
    window.cancelAnimationFrame(this.backingRefreshFrame);
    this.backingRefreshFrame = null;
  }

  private async refreshSurfaceBacking(
    surface: PageSurface,
    pageNumber: number,
  ): Promise<void> {
    const sequence = ++surface.renderSequence;
    const generation = this.renderSequence;
    try {
      const handle = await this.options.session.bitmap(pageNumber);
      try {
        if (
          generation !== this.renderSequence ||
          sequence !== surface.renderSequence ||
          surface.pageNumber !== pageNumber ||
          this.viewMode !== "pager"
        ) {
          return;
        }
        this.drawSurfaceBitmap(surface, pageNumber, handle.bitmap, true);
      } finally {
        handle.release();
      }
    } catch {
      // A layout refresh is opportunistic; keep the last admitted canvas.
    }
  }

  private updateCounter(): void {
    this.counter?.setText(
      `${this.state.currentPage} / ${this.state.pageCount}`,
    );
  }

  private createZoomControl(parent: HTMLElement): void {
    const control = parent.createDiv({
      cls: "supernote-reader-zoom-control",
      attr: {
        role: "group",
        "aria-label": "Zoom, 100 percent",
      },
    });
    this.zoomControl = control;
    this.zoomOutButton = iconButton(control, "minus", "Zoom out", () => {
      this.changeZoomByStep(-1);
    });
    this.zoomOutButton.addClass("supernote-reader-zoom-button");
    this.zoomValueButton = control.createEl("button", {
      cls: "supernote-reader-zoom-value",
      text: "100%",
      attr: {
        type: "button",
        "aria-label": "Current zoom 100 percent. Return to fit.",
      },
    });
    this.zoomValueButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.returnToFit();
    });
    this.zoomInButton = iconButton(control, "plus", "Zoom in", () => {
      this.changeZoomByStep(1);
    });
    this.zoomInButton.addClass("supernote-reader-zoom-button");
  }

  private changeZoomByStep(direction: -1 | 1): void {
    if (this.activeTransition !== null) {
      return;
    }
    this.syncTransformGeometry();
    if (this.viewportTransform.stepZoom(direction)) {
      this.applyTransform(true);
    }
  }

  private returnToFit(): void {
    if (this.activeTransition !== null) {
      return;
    }
    if (this.viewportTransform.reset()) {
      this.applyTransform(true);
    }
  }

  private syncZoomControl(zoom = this.viewportTransform.snapshot.zoom): void {
    const percentage = Math.round(zoom * 100);
    const atMinimum = !this.viewportTransform.canZoomOut;
    const atMaximum = !this.viewportTransform.canZoomIn;
    const controlKey = `${percentage}:${atMinimum}:${atMaximum}`;
    if (this.committedZoomControlKey === controlKey) {
      return;
    }
    this.committedZoomControlKey = controlKey;
    this.zoomControl?.setAttr("aria-label", `Zoom, ${percentage} percent`);
    this.zoomValueButton?.setText(`${percentage}%`);
    this.zoomValueButton?.setAttr(
      "aria-label",
      `Current zoom ${percentage} percent. Return to fit.`,
    );
    if (this.zoomOutButton) {
      this.zoomOutButton.disabled = atMinimum;
    }
    if (this.zoomInButton) {
      this.zoomInButton.disabled = atMaximum;
    }
  }

  private notifyToolbarChanged(): void {
    if (this.toolbarNotificationsEnabled) {
      this.options.toolbarChanged?.(this.toolbarContext);
    }
  }

  private async copyCurrentPageEmbed(): Promise<void> {
    await this.copyEmbed(
      fixedPageEmbedMarkdown(this.options.rawNotePath, this.state.currentPage),
      "Copied current page embed.",
      "Could not copy the current page embed.",
    );
  }

  private async copyNotebookEmbed(): Promise<void> {
    await this.copyEmbed(
      notebookEmbedMarkdown(this.options.rawNotePath),
      "Copied notebook embed.",
      "Could not copy the notebook embed.",
    );
  }

  private async copyEmbed(
    markdown: string,
    successMessage: string,
    failureMessage: string,
  ): Promise<void> {
    if (!navigator.clipboard) {
      new Notice("Clipboard access is unavailable.");
      return;
    }
    try {
      await navigator.clipboard.writeText(markdown);
      new Notice(successMessage);
    } catch {
      new Notice(failureMessage);
    }
  }

  private revealChrome(): void {
    if (!this.chrome) {
      return;
    }
    if (this.root.hasClass("is-chrome-hidden")) {
      this.root.removeClass("is-chrome-hidden");
    }
    this.chromeLastActivity = performance.now();
    if (this.chromeTimer === null) {
      this.scheduleChromeHide(2_000);
    }
  }

  private scheduleChromeHide(delay: number): void {
    this.chromeTimer = window.setTimeout(() => {
      const remaining = 2_000 - (performance.now() - this.chromeLastActivity);
      if (remaining > 0) {
        this.scheduleChromeHide(remaining);
        return;
      }
      this.chromeTimer = null;
      this.root.addClass("is-chrome-hidden");
    }, delay);
  }

  private commitFrameWrites(writes: ReaderFrameWrites): void {
    if (writes.track) {
      this.writeTrackPosition(writes.track.percent, writes.track.pixelOffset);
    }
    if (writes.canvas) {
      const canvas = this.surfaces?.current.canvas;
      if (canvas) {
        const zoomed = writes.canvas.zoom > 1;
        if (this.viewport?.hasClass("is-zoomed") !== zoomed) {
          this.viewport?.toggleClass("is-zoomed", zoomed);
        }
        if (canvas.hasClass("is-transforming") !== zoomed) {
          canvas.toggleClass("is-transforming", zoomed);
        }
        this.setTransformAnimation(
          canvas,
          writes.canvas.animate === true && !this.prefersReducedMotion(),
        );
        canvas.style.transform = `translate(${writes.canvas.panX}px, ${writes.canvas.panY}px) scale(${writes.canvas.zoom})`;
        this.syncZoomControl(writes.canvas.zoom);
      }
    }
  }

  private bindCanvasGestures(viewport: HTMLElement): void {
    viewport.addEventListener(
      "wheel",
      (event) => {
        const pageTransitionActive = this.activeTransition !== null;
        if (!pageTransitionActive) {
          this.syncTransformGeometry();
        }
        const result = this.viewportTransform.applyWheel({
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode:
            event.deltaMode === 1 || event.deltaMode === 2
              ? event.deltaMode
              : 0,
          ctrlKey: event.ctrlKey,
          pageTransitionActive,
          focalPoint: this.viewportPoint(
            viewport,
            event.clientX,
            event.clientY,
          ),
        });
        if (result.consumed) {
          event.preventDefault();
        }
        if (result.changed) {
          this.applyTransform();
        }
      },
      { passive: false },
    );
    viewport.addEventListener("dblclick", (event) => {
      if (
        this.activeTransition !== null ||
        performance.now() <= this.suppressDblClickUntil
      ) {
        return;
      }
      this.syncTransformGeometry();
      if (
        this.viewportTransform.toggleZoom(
          this.viewportPoint(viewport, event.clientX, event.clientY),
        )
      ) {
        event.preventDefault();
        this.applyTransform(true);
      }
    });
    viewport.addEventListener("pointerdown", (event) => {
      if (
        this.viewportTransform.snapshot.zoom > 1 &&
        this.pinchDistance === null
      ) {
        viewport.setPointerCapture(event.pointerId);
        this.dragging = { x: event.clientX, y: event.clientY };
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!this.dragging || this.pinchDistance !== null) {
        return;
      }
      const changed = this.viewportTransform.panBy(
        event.clientX - this.dragging.x,
        event.clientY - this.dragging.y,
      );
      this.dragging = { x: event.clientX, y: event.clientY };
      if (changed) {
        this.applyTransform();
      }
    });
    viewport.addEventListener("pointerup", () => {
      this.dragging = null;
    });
    viewport.addEventListener("pointercancel", () => {
      this.dragging = null;
    });
    viewport.addEventListener(
      "touchstart",
      (event) => {
        const intent = readerTouchStartIntent({
          touchCount: event.touches.length,
          zoom: this.viewportTransform.snapshot.zoom,
          pageDragActive: this.swipeGesture !== null,
          pageTransitionActive: this.activeTransition !== null,
        });
        if (intent.mode === "wait") {
          this.doubleTapGesture.cancel();
          return;
        }
        if (intent.mode === "pinch") {
          this.doubleTapGesture.cancel();
          if (intent.cancelPageDrag) {
            this.cancelSwipe(false);
          }
          this.dragging = null;
          this.pinchDistance = this.touchDistance(event.touches);
          return;
        }
        const touch = event.touches[0];
        if (!touch || intent.mode === "pan") {
          this.swipeGesture = null;
          if (touch) {
            this.doubleTapGesture.start(
              this.viewportPoint(viewport, touch.clientX, touch.clientY),
              performance.now(),
            );
          }
          return;
        }
        this.doubleTapGesture.start(
          this.viewportPoint(viewport, touch.clientX, touch.clientY),
          performance.now(),
        );
        this.clearTransitionTimer();
        this.track?.removeClass("is-animating");
        this.root.removeClass("is-motion-active");
        this.frameBatcher.cancel();
        this.writeTrackPosition(-100, 0);
        this.swipeOffset = 0;
        this.track?.addClass("is-interacting");
        this.swipeGesture = new PagerSwipeGesture({
          start: {
            x: touch.clientX,
            y: touch.clientY,
            time: performance.now(),
          },
          viewportWidth: viewport.clientWidth,
          currentPage: this.state.currentPage,
          pageCount: this.state.pageCount,
          rtl: this.isRtl(),
        });
      },
      { passive: true },
    );
    viewport.addEventListener(
      "touchmove",
      (event) => {
        if (event.touches.length === 2) {
          this.doubleTapGesture.cancel();
          if (this.activeTransition !== null) {
            return;
          }
          this.cancelSwipe(true);
          event.preventDefault();
          const distance = this.touchDistance(event.touches);
          if (this.pinchDistance !== null) {
            const changed = this.viewportTransform.zoomAt(
              this.viewportTransform.snapshot.zoom *
                (distance / this.pinchDistance),
              this.touchCentroid(viewport, event.touches),
            );
            if (changed) {
              this.applyTransform();
            }
          }
          this.pinchDistance = distance;
          return;
        }
        const touch = event.touches[0];
        if (touch) {
          this.doubleTapGesture.move(
            this.viewportPoint(viewport, touch.clientX, touch.clientY),
          );
        }
        if (
          !touch ||
          !this.swipeGesture ||
          this.viewportTransform.snapshot.zoom > 1
        ) {
          return;
        }
        const movement = this.swipeGesture.move({
          x: touch.clientX,
          y: touch.clientY,
          time: performance.now(),
        });
        if (movement.axis === "horizontal") {
          event.preventDefault();
          this.swipeOffset = movement.offset;
          this.track?.removeClass("is-animating");
          this.queueTrackPosition(-100, movement.offset);
        }
      },
      { passive: false },
    );
    viewport.addEventListener("touchend", (event) => {
      if (this.pinchDistance !== null) {
        this.doubleTapGesture.cancel();
        this.pinchDistance = null;
        this.swipeGesture = null;
        this.swipeOffset = 0;
        this.track?.removeClass("is-interacting");
        if (this.viewportTransform.settlePinch()) {
          this.applyTransform(true);
        }
        return;
      }
      const gesture = this.swipeGesture;
      const touch = event.changedTouches[0];
      if (
        touch &&
        this.doubleTapGesture.finish(
          this.viewportPoint(viewport, touch.clientX, touch.clientY),
          performance.now(),
        )
      ) {
        this.cancelSwipe(false);
        if (
          this.viewportTransform.toggleZoom(
            this.viewportPoint(viewport, touch.clientX, touch.clientY),
          )
        ) {
          this.suppressDblClickUntil = performance.now() + 500;
          this.applyTransform(true);
        }
        return;
      }
      this.swipeGesture = null;
      if (!gesture || !touch || this.viewportTransform.snapshot.zoom > 1) {
        this.swipeOffset = 0;
        this.track?.removeClass("is-interacting");
        return;
      }
      const finish = gesture.finish({
        x: touch.clientX,
        y: touch.clientY,
        time: performance.now(),
      });
      this.swipeOffset = 0;
      this.track?.removeClass("is-interacting");
      if (finish.action === "next") {
        this.showPage(this.state.currentPage + 1, finish.offset);
      } else if (finish.action === "previous") {
        this.showPage(this.state.currentPage - 1, finish.offset);
      } else {
        this.snapTrackBack(finish.offset);
      }
    });
    viewport.addEventListener("touchcancel", () => {
      this.doubleTapGesture.cancel();
      this.pinchDistance = null;
      this.cancelSwipe(true);
    });
  }

  private cancelSwipe(animate: boolean): void {
    const hadSwipe = this.swipeGesture !== null;
    const offset = this.swipeOffset;
    this.swipeGesture = null;
    this.swipeOffset = 0;
    this.track?.removeClass("is-interacting");
    if (!hadSwipe) {
      return;
    }
    if (animate) {
      this.snapTrackBack(offset);
    } else {
      this.track?.removeClass("is-animating");
      this.root.removeClass("is-motion-active");
      this.frameBatcher.cancel();
      this.writeTrackPosition(-100, 0);
    }
  }

  private touchDistance(touches: TouchList): number {
    const first = touches[0];
    const second = touches[1];
    if (!first || !second) {
      return 1;
    }
    return Math.hypot(
      first.clientX - second.clientX,
      first.clientY - second.clientY,
    );
  }

  private touchCentroid(
    viewport: HTMLElement,
    touches: TouchList,
  ): ViewportPoint {
    const first = touches[0];
    const second = touches[1];
    if (!first || !second) {
      return {
        x: viewport.clientWidth / 2,
        y: viewport.clientHeight / 2,
      };
    }
    return this.viewportPoint(
      viewport,
      (first.clientX + second.clientX) / 2,
      (first.clientY + second.clientY) / 2,
    );
  }

  private resetTransformState(): void {
    this.doubleTapGesture.cancel();
    this.viewportTransform.reset();
  }

  private applyTransform(animate = false): void {
    if (!this.surfaces?.current.canvas) {
      return;
    }
    const transform = this.viewportTransform.snapshot;
    this.frameBatcher.schedule({
      canvas: {
        ...transform,
        animate,
      },
    });
  }

  private syncTransformGeometry(): boolean {
    const viewport = this.viewport;
    const canvas = this.surfaces?.current.canvas;
    if (!viewport || !canvas) {
      return false;
    }
    const viewportSize = {
      width: Math.max(1, viewport.clientWidth || this.root.clientWidth),
      height: Math.max(1, viewport.clientHeight || this.root.clientHeight),
    };
    const measuredPage = {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    };
    const available = this.pageDisplayBounds ?? {
      width: Math.max(1, viewportSize.width - 32),
      height: Math.max(1, viewportSize.height - 32),
    };
    const page =
      measuredPage.width > 0 && measuredPage.height > 0
        ? measuredPage
        : fitPageWithin(available, {
            width: canvas.width,
            height: canvas.height,
          });
    return this.viewportTransform.resize({
      viewport: viewportSize,
      page,
    });
  }

  private viewportPoint(
    viewport: HTMLElement,
    clientX: number,
    clientY: number,
  ): ViewportPoint {
    const bounds = viewport.getBoundingClientRect();
    return {
      x: clientX - bounds.left,
      y: clientY - bounds.top,
    };
  }

  private setTransformAnimation(
    canvas: HTMLCanvasElement,
    animate: boolean,
  ): void {
    if (!animate) {
      if (
        this.transformAnimationTimer !== null ||
        canvas.hasClass("is-zoom-animating")
      ) {
        this.clearTransformAnimation();
      }
      return;
    }
    this.clearTransformAnimation();
    canvas.addClass("is-zoom-animating");
    this.transformAnimationTimer = window.setTimeout(() => {
      this.transformAnimationTimer = null;
      canvas.removeClass("is-zoom-animating");
    }, 150);
  }

  private clearTransformAnimation(): void {
    if (this.transformAnimationTimer !== null) {
      window.clearTimeout(this.transformAnimationTimer);
      this.transformAnimationTimer = null;
    }
    if (this.surfaces) {
      for (const surface of Object.values(this.surfaces)) {
        surface.canvas.removeClass("is-zoom-animating");
      }
    }
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      target.closest("input, textarea, select, [contenteditable='true']") !==
        null
    );
  }

  private renderGrid(preserveSelection = false): void {
    if (this.activeTransition !== null) {
      this.commitTransition();
      if (this.activeTransition !== null) {
        return;
      }
    }
    this.pagerPreparationGeneration += 1;
    this.clearTransition();
    this.cancelSwipe(false);
    this.destroyGridResources();
    this.frameBatcher.cancel();
    this.cancelPageBackingRefresh();
    this.renderSequence += 1;
    this.viewMode = "grid";
    if (!preserveSelection) {
      this.state.clearSelection();
    }
    this.releaseCanvasResources(false);
    this.root.empty();
    this.viewport = null;
    this.track = null;
    this.surfaces = null;
    this.chrome = null;
    this.counter = null;
    this.root.addClass("is-grid");
    this.root.removeClass("is-motion-active");
    this.root.removeClass("is-chrome-hidden");
    this.updateSessionView();
    if (this.chromeTimer !== null) {
      window.clearTimeout(this.chromeTimer);
      this.chromeTimer = null;
    }

    this.gridSelecting = false;
    this.notifyToolbarChanged();

    this.grid = this.root.createDiv({
      cls: "supernote-reader-grid",
    });
    this.gridSpacer = this.grid.createDiv({
      cls: "supernote-reader-grid-spacer",
    });
    this.gridWindow = this.gridSpacer.createDiv({
      cls: "supernote-reader-grid-window",
    });
    this.grid.addEventListener("scroll", () => this.scheduleGridWindow(), {
      passive: true,
    });
    this.grid.addEventListener("click", (event) => {
      const card = this.gridCardFromEvent(event);
      if (!card) {
        return;
      }
      const pageNumber = Number(card.dataset.pageNumber);
      if (
        this.gridLongPressedPage === pageNumber &&
        performance.now() - this.gridLongPressedAt < 1_000
      ) {
        this.gridLongPressedPage = null;
        return;
      }
      this.gridLongPressedPage = null;
      if (this.gridSelecting) {
        this.toggleGridSelection(pageNumber);
        this.refreshGridSelection();
        this.refreshMountedGridSelection();
        return;
      }
      this.renderPager(pageNumber);
    });
    this.grid.addEventListener(
      "touchstart",
      (event) => this.startGridLongPress(event),
      { passive: true },
    );
    this.grid.addEventListener(
      "touchmove",
      (event) => this.moveGridLongPress(event),
      { passive: true },
    );
    this.grid.addEventListener("touchend", () => this.cancelGridLongPress());
    this.grid.addEventListener("touchcancel", () => this.cancelGridLongPress());
    this.gridResizeObserver = new ResizeObserver(() =>
      this.scheduleGridWindow(true),
    );
    this.gridResizeObserver.observe(this.grid);
    this.refreshGridSelection();
    this.updateSessionView();
    this.gridFrame = window.requestAnimationFrame(() => {
      this.gridFrame = null;
      const grid = this.grid;
      if (!grid) {
        return;
      }
      const geometry = planGridWindow({
        pageCount: this.state.pageCount,
        scrollTop: 0,
        viewportHeight: grid.clientHeight,
        viewportWidth: grid.clientWidth,
      });
      if (this.gridSpacer) {
        this.gridSpacer.style.height = `${geometry.contentHeight}px`;
      }
      grid.scrollTop = gridScrollTopForPage(
        this.state.currentPage,
        grid.clientHeight,
        geometry,
      );
      this.renderGridWindow(true);
    });
  }

  private renderGridWindow(force = false): void {
    const grid = this.grid;
    const spacer = this.gridSpacer;
    const windowElement = this.gridWindow;
    if (!grid || !spacer || !windowElement) {
      return;
    }
    const plan = planGridWindow({
      pageCount: this.state.pageCount,
      scrollTop: grid.scrollTop,
      viewportHeight: grid.clientHeight,
      viewportWidth: grid.clientWidth,
    });
    const key = [
      plan.startPage,
      plan.endPage,
      plan.columns,
      Math.round(plan.cardHeight),
    ].join(":");
    spacer.style.height = `${plan.contentHeight}px`;
    if (!force && key === this.gridWindowKey) {
      return;
    }
    this.gridWindowKey = key;
    const generation = ++this.gridGeneration;
    for (const canvas of windowElement.querySelectorAll("canvas")) {
      this.releaseCanvasResource(canvas, false);
    }
    windowElement.empty();
    windowElement.style.top = `${plan.offsetTop}px`;
    windowElement.style.gridTemplateColumns = `repeat(${plan.columns}, minmax(0, 1fr))`;
    windowElement.style.setProperty(
      "--supernote-reader-grid-card-height",
      `${plan.cardHeight}px`,
    );
    for (const pageNumber of gridPageNumbers(plan)) {
      const card = windowElement.createEl("button", {
        cls:
          "supernote-reader-thumbnail" +
          (pageNumber === this.state.currentPage ? " is-current" : "") +
          (this.state.isSelected(pageNumber) ? " is-selected" : ""),
        attr: {
          "data-page-number": String(pageNumber),
          "aria-label": `Page ${pageNumber}`,
          ...(pageNumber === this.state.currentPage
            ? { "aria-current": "page" }
            : {}),
        },
      });
      const canvas = card.createEl("canvas", {
        attr: { width: "1", height: "1" },
      });
      canvas.dataset.pageNumber = String(pageNumber);
      this.resizeCanvas(canvas, 1, 1, false);
      card.createSpan({
        cls: "supernote-reader-thumbnail-label",
        text: `Page ${pageNumber}`,
      });
      const check = card.createSpan({
        cls: "supernote-reader-thumbnail-check",
      });
      setIcon(check, "check");
      void this.renderThumbnail(canvas, pageNumber, generation);
    }
    this.updateSessionView();
  }

  private scheduleGridWindow(force = false): void {
    if (force) {
      this.gridWindowKey = "";
    }
    if (this.gridFrame !== null) {
      return;
    }
    this.gridFrame = window.requestAnimationFrame(() => {
      this.gridFrame = null;
      this.renderGridWindow(force);
    });
  }

  private gridCardFromEvent(event: Event): HTMLElement | null {
    const target = event.target;
    if (!(target instanceof Element)) {
      return null;
    }
    const card = target.closest<HTMLElement>(".supernote-reader-thumbnail");
    return card && this.gridWindow?.contains(card) ? card : null;
  }

  private startGridLongPress(event: TouchEvent): void {
    this.cancelGridLongPress();
    const card = this.gridCardFromEvent(event);
    const touch = event.touches[0];
    if (!card || !touch) {
      return;
    }
    const pageNumber = Number(card.dataset.pageNumber);
    this.gridLongPressPage = pageNumber;
    this.gridLongPressOrigin = {
      x: touch.clientX,
      y: touch.clientY,
    };
    this.gridLongPressTimer = window.setTimeout(() => {
      this.gridLongPressTimer = null;
      if (this.viewMode !== "grid" || this.gridLongPressPage !== pageNumber) {
        return;
      }
      this.gridLongPressedPage = pageNumber;
      this.gridLongPressedAt = performance.now();
      this.setGridSelecting(true);
      this.toggleGridSelection(pageNumber);
      this.refreshGridSelection();
      this.refreshMountedGridSelection();
    }, 500);
  }

  private moveGridLongPress(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!touch || !this.gridLongPressOrigin) {
      return;
    }
    if (
      Math.hypot(
        touch.clientX - this.gridLongPressOrigin.x,
        touch.clientY - this.gridLongPressOrigin.y,
      ) > 10
    ) {
      this.cancelGridLongPress();
    }
  }

  private cancelGridLongPress(): void {
    if (this.gridLongPressTimer !== null) {
      window.clearTimeout(this.gridLongPressTimer);
      this.gridLongPressTimer = null;
    }
    this.gridLongPressOrigin = null;
    this.gridLongPressPage = null;
  }

  private toggleGridSelection(pageNumber: number): void {
    this.state.toggleSelected(pageNumber);
  }

  private refreshGridSelection(): void {
    this.notifyToolbarChanged();
  }

  private setGridSelecting(selecting: boolean): void {
    if (this.viewMode !== "grid" || this.gridSelecting === selecting) {
      return;
    }
    this.gridSelecting = selecting;
    this.root.toggleClass("is-selecting", selecting);
    this.notifyToolbarChanged();
  }

  private refreshMountedGridSelection(): void {
    for (const card of this.gridWindow?.querySelectorAll<HTMLElement>(
      ".supernote-reader-thumbnail",
    ) ?? []) {
      const pageNumber = Number(card.dataset.pageNumber);
      card.toggleClass("is-selected", this.state.isSelected(pageNumber));
    }
  }

  private destroyGridResources(): void {
    this.gridGeneration += 1;
    if (this.gridFrame !== null) {
      window.cancelAnimationFrame(this.gridFrame);
      this.gridFrame = null;
    }
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = null;
    this.cancelGridLongPress();
    if (this.gridWindow) {
      for (const canvas of this.gridWindow.querySelectorAll("canvas")) {
        this.releaseCanvasResource(canvas, false);
      }
    }
    this.grid = null;
    this.gridSpacer = null;
    this.gridWindow = null;
    this.gridWindowKey = "";
    this.gridSelecting = false;
    this.gridLongPressedPage = null;
    this.gridLongPressedAt = 0;
    this.root.removeClass("is-selecting");
  }

  private async renderThumbnail(
    canvas: HTMLCanvasElement,
    pageNumber: number,
    generation: number,
  ): Promise<void> {
    try {
      const handle = await this.options.session.thumbnailBitmap(
        pageNumber,
        240,
      );
      try {
        const bitmap = handle.bitmap;
        if (
          generation !== this.gridGeneration ||
          this.viewMode !== "grid" ||
          !canvas.isConnected ||
          canvas.dataset.pageNumber !== String(pageNumber)
        ) {
          return;
        }
        if (!this.resizeCanvas(canvas, bitmap.width, bitmap.height)) {
          canvas.addClass("is-error");
          return;
        }
        const context = canvas.getContext("2d", { alpha: false });
        if (context) {
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, 0);
        }
      } finally {
        handle.release();
      }
    } catch {
      canvas.addClass("is-error");
    }
  }

  private async openExportSheet(): Promise<void> {
    const selectedPages = this.state.selectedPages;
    if (selectedPages.length === 0) {
      new Notice("Select at least one page.");
      return;
    }
    let defaults: ExportDefaults;
    try {
      defaults = await this.options.getExportDefaults(this.options.rawNotePath);
    } catch (error) {
      new Notice(
        error instanceof Error
          ? error.message
          : "Could not load export defaults.",
        10_000,
      );
      return;
    }
    new ExportSheetModal(
      this.options.app,
      selectedPages,
      this.options.getTranscriptionAvailability(),
      this.options.getTargetFolder,
      defaults,
      async (selection) => {
        const exportSession = this.options.session.retain();
        const resumeReader = this.visible;
        if (resumeReader) {
          this.setVisible(false);
        }
        let result: PageExportResult | null;
        try {
          result = await this.options.exportPages(
            this.options.rawNotePath,
            {
              ...selection,
              selectedPages,
            },
            exportSession,
          );
        } finally {
          exportSession.close();
          if (resumeReader) {
            this.setVisible(true);
          }
        }
        if (result) {
          const base = `Exported ${selectedPages.length} Supernote page${selectedPages.length === 1 ? "" : "s"}.`;
          const failure =
            result.transcriptionFailures.length > 0
              ? ` Transcription unavailable for page${result.transcriptionFailures.length === 1 ? "" : "s"} ${result.transcriptionFailures.join(", ")}.`
              : "";
          const detail = result.transcriptionErrors[0]?.trim()
            ? ` ${result.transcriptionErrors[0].trim().slice(0, 500)}`
            : "";
          const batch = result.retainedBatchPath
            ? ` Batch kept at ${result.retainedBatchPath}.`
            : "";
          new Notice(
            `${base}${failure}${detail}${batch}`,
            failure ? 12_000 : 5_000,
          );
        }
        return result !== null;
      },
    ).open();
  }
}

class ExportSheetModal extends Modal {
  private useOcr = false;
  private format: ExportFormat;
  private filename: string;
  private destination: string;
  private customPrompt = "";
  private transcriptionEngine: TranscriptionEngine;
  private transcriptionModel: string;

  constructor(
    app: App,
    private readonly selectedPages: readonly number[],
    private readonly transcriptionAvailability: TranscriptionAvailability,
    private readonly getTargetFolder: () => string,
    defaults: ExportDefaults,
    private readonly exportSelection: (
      options: Omit<ViewerExportOptions, "selectedPages">,
    ) => Promise<boolean>,
  ) {
    super(app);
    this.format = coerceAvailableExportFormat(
      defaults.format,
      transcriptionAvailability,
    );
    this.destination = defaults.destination;
    this.filename = defaultExportFilename(defaults.noteFileName, selectedPages);
    this.transcriptionEngine = transcriptionAvailability.engine;
    this.transcriptionModel = transcriptionAvailability.model;
  }

  onOpen(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    this.contentEl.empty();
    this.setTitle(
      `Export ${this.selectedPages.length} page${this.selectedPages.length === 1 ? "" : "s"}`,
    );
    new Setting(this.contentEl)
      .setName("Format")
      .setDesc("Choose which files to write into the vault.")
      .addDropdown((dropdown) => {
        for (const format of availableExportFormats(
          this.transcriptionAvailability,
        )) {
          dropdown.addOption(format, EXPORT_FORMAT_LABELS[format]);
        }
        dropdown.setValue(this.format).onChange((value) => {
          this.format = value as ExportFormat;
          if (this.format === "images") {
            this.useOcr = false;
          } else if (this.isDocumentMode()) {
            this.useOcr = true;
          }
          this.renderSettings();
        });
      });

    new Setting(this.contentEl)
      .setName("Filename")
      .setDesc("Enter a filename without an extension.")
      .addText((text) =>
        text.setValue(this.filename).onChange((value) => {
          this.filename = value;
        }),
      );

    new Setting(this.contentEl)
      .setName("Destination")
      .setDesc(this.destination || "Vault root")
      .addButton((button) =>
        button.setButtonText("Choose folder").onClick(() => {
          new VaultFolderPickerModal(
            this.app,
            this.getTargetFolder(),
            (path) => {
              this.destination = path;
              this.renderSettings();
            },
          ).open();
        }),
      );

    if (this.transcriptionAvailability.visible) {
      new Setting(this.contentEl)
        .setName("AI transcription")
        .setDesc(
          this.isDocumentMode()
            ? "Required by the formatted-transcription export format."
            : this.transcriptionAvailability.hint,
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.isDocumentMode() || this.useOcr)
            .setDisabled(
              this.format === "images" ||
                this.isDocumentMode() ||
                !this.transcriptionAvailability.enabled,
            )
            .onChange((value) => {
              this.useOcr = value;
            }),
        );
    }

    if (this.transcriptionAvailability.enabled && this.format !== "images") {
      new Setting(this.contentEl)
        .setName("Transcription engine")
        .setDesc("Applies to this export only.")
        .addDropdown((dropdown) => {
          for (const option of this.transcriptionAvailability.engines) {
            dropdown.addOption(option.engine, option.label);
          }
          dropdown.setValue(this.transcriptionEngine).onChange((value) => {
            const option = this.transcriptionAvailability.engines.find(
              (candidate) => candidate.engine === value,
            );
            if (!option) {
              return;
            }
            this.transcriptionEngine = option.engine;
            this.transcriptionModel = option.model;
            this.renderSettings();
          });
        });
      this.renderTranscriptionModel();
    }

    if (this.isDocumentMode()) {
      new Setting(this.contentEl)
        .setName("Document instructions")
        .setDesc(
          "Optional. Replaces the built-in verbatim-transcription prompt for this export. Leave empty for a faithful formatted transcript.",
        )
        .addTextArea((text) =>
          text
            .setValue(this.customPrompt)
            .setPlaceholder(
              "For example: organize these notes into sections and add a short summary.",
            )
            .onChange((value) => {
              this.customPrompt = value;
            }),
        );
    }

    new Setting(this.contentEl).addButton((button) =>
      button
        .setCta()
        .setButtonText("Export")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Exporting…");
          try {
            const exported = await this.exportSelection({
              useOcr: this.isDocumentMode() || this.useOcr,
              format: this.format,
              filename: this.filename,
              destination: this.destination,
              transcription: {
                engine: this.transcriptionEngine,
                model: this.transcriptionModel.trim(),
              },
              ...(this.isDocumentMode() && this.customPrompt.trim()
                ? { customPrompt: this.customPrompt.trim() }
                : {}),
            });
            if (exported) {
              this.close();
            } else {
              button.setDisabled(false).setButtonText("Export");
            }
          } catch (error) {
            new Notice(
              error instanceof Error
                ? error.message
                : "Could not export these pages.",
              10_000,
            );
            button.setDisabled(false).setButtonText("Export");
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private isDocumentMode(): boolean {
    return isDocumentExportFormat(this.format);
  }

  private renderTranscriptionModel(): void {
    if (this.transcriptionEngine === "command") {
      return;
    }
    if (this.transcriptionEngine === "claude") {
      const setting = new Setting(this.contentEl)
        .setName("Model")
        .setDesc("Default lets Claude Code choose its model.");
      addClaudeModelPicker(setting, {
        value: this.transcriptionModel,
        onChange: (value) => {
          this.transcriptionModel = value;
        },
      });
      return;
    }
    if (this.transcriptionEngine === "codex") {
      new Setting(this.contentEl)
        .setName("Model")
        .setDesc("Blank lets Codex CLI choose its model.")
        .addText((text) =>
          text
            .setValue(this.transcriptionModel)
            .setPlaceholder("Default")
            .onChange((value) => {
              this.transcriptionModel = value.trim();
            }),
        );
      return;
    }

    const setting = new Setting(this.contentEl)
      .setName("Model")
      .setDesc("Models load when opened; free text remains available.");
    addApiModelPicker(setting, {
      value: this.transcriptionModel,
      loadModels: () => this.transcriptionAvailability.loadApiModels(),
      onChange: (value) => {
        this.transcriptionModel = value;
      },
    });
  }
}
