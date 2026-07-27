import {
  FileView,
  Menu,
  Notice,
  Platform,
  setIcon,
  TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";

import type {
  NotebookBitmapHandle,
  NotebookSessionProvider,
} from "../note/notebook-service";
import {
  NoteReader,
  type ViewerExporter,
  type ViewerExportDefaults,
} from "./note-reader";
import type { TranscriptionAvailability } from "./export-options";
import {
  MobileReaderNavbarVisibility,
  READER_TOOLBAR_ACTION_CATALOG,
  readerToolbarIsCompact,
  readerToolbarNativeActionIdsForPhone,
  readerToolbarPresentation,
  type ReaderToolbarActionId,
  type ReaderToolbarContext,
  type ReaderToolbarPresentation,
} from "./reader-toolbar";
import { pageFromViewState, planPageOpen, planRevisionHandoff } from "./state";

export const NOTE_VIEW_TYPE = "supernote-note-view";

const MOBILE_READER_ACTIVE_CLASS = "supernote-mobile-reader-active";
const mobileReaderNavbarVisibility =
  new MobileReaderNavbarVisibility<WorkspaceLeaf>((hidden) =>
    document.body.toggleClass(MOBILE_READER_ACTIVE_CLASS, hidden),
  );

interface NoteViewDependencies {
  notebooks: NotebookSessionProvider;
  getTranscriptionAvailability: () => TranscriptionAvailability;
  getTargetFolder: () => string;
  exportPages: ViewerExporter;
  getExportDefaults: ViewerExportDefaults;
}

export class SupernoteNoteView extends FileView {
  private reader: NoteReader | null = null;
  private loadGeneration = 0;
  private pendingPage: number | null = null;
  private readerToolbarContext: ReaderToolbarContext | null = null;
  private readerToolbarCompact = true;
  private currentReaderToolbarPresentation: ReaderToolbarPresentation | null =
    null;
  private readerToolbarTrigger: HTMLElement | null = null;
  private readonly readerToolbarActions = new Map<
    ReaderToolbarActionId,
    HTMLElement
  >();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly dependencies: NoteViewDependencies,
  ) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return NOTE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Supernote";
  }

  private installReaderToolbar(): void {
    if (this.readerToolbarTrigger) {
      return;
    }
    for (const id of readerToolbarNativeActionIdsForPhone(Platform.isPhone)) {
      const definition = READER_TOOLBAR_ACTION_CATALOG[id];
      const element = this.addAction(definition.icon, definition.label, () =>
        this.runReaderToolbarAction(id),
      );
      element.addClass("supernote-reader-toolbar-action");
      element.hidden = true;
      this.readerToolbarActions.set(id, element);
    }
    this.readerToolbarTrigger = this.addAction(
      "book-open",
      "Reader actions",
      (event) => this.openReaderToolbarMenu(event),
    );
    this.readerToolbarTrigger.addClass("supernote-reader-toolbar-action");
    this.readerToolbarTrigger.hidden = true;

    const resizeObserver = new ResizeObserver(() => {
      const compact =
        Platform.isPhone ||
        readerToolbarIsCompact(this.containerEl.clientWidth);
      if (compact !== this.readerToolbarCompact) {
        this.readerToolbarCompact = compact;
        this.renderReaderToolbar();
      }
    });
    resizeObserver.observe(this.containerEl);
    this.register(() => resizeObserver.disconnect());
    this.readerToolbarCompact =
      Platform.isPhone || readerToolbarIsCompact(this.containerEl.clientWidth);
    this.renderReaderToolbar();
  }

  private syncMobileReaderBottomNavigation(active: boolean): void {
    mobileReaderNavbarVisibility.sync(
      this.leaf,
      Platform.isPhone && active && this.reader !== null,
    );
  }

  private setReaderToolbarContext(context: ReaderToolbarContext | null): void {
    this.readerToolbarContext = context;
    this.renderReaderToolbar();
  }

  private renderReaderToolbar(): void {
    for (const element of this.readerToolbarActions.values()) {
      element.hidden = true;
      element.removeClass("is-disabled");
      element.removeAttribute("aria-disabled");
      element.querySelector(".supernote-reader-action-badge")?.remove();
    }
    const context = this.readerToolbarContext;
    if (!context) {
      this.currentReaderToolbarPresentation = null;
      if (this.readerToolbarTrigger) {
        this.readerToolbarTrigger.hidden = true;
      }
      return;
    }
    const presentation = readerToolbarPresentation({
      ...context,
      compact: this.readerToolbarCompact,
    });
    this.currentReaderToolbarPresentation = presentation;
    for (const action of presentation.visibleActions) {
      const element = this.readerToolbarActions.get(action.id);
      if (!element) {
        continue;
      }
      element.hidden = false;
      setIcon(element, action.icon);
      element.setAttribute("aria-label", action.label);
      element.toggleClass("is-disabled", action.disabled);
      if (action.disabled) {
        element.setAttribute("aria-disabled", "true");
      }
      if (action.badge !== null) {
        element.createSpan({
          cls: "supernote-reader-action-badge",
          text: String(action.badge),
        });
      }
    }
    if (this.readerToolbarTrigger) {
      this.readerToolbarTrigger.hidden = presentation.menuActions.length === 0;
    }
  }

  private runReaderToolbarAction(id: ReaderToolbarActionId): void {
    const action = this.currentReaderToolbarPresentation?.visibleActions.find(
      (candidate) => candidate.id === id,
    );
    if (!action || action.disabled) {
      return;
    }
    this.reader?.runToolbarAction(id);
  }

  private openReaderToolbarMenu(event: MouseEvent): void {
    const actions = this.currentReaderToolbarPresentation?.menuActions ?? [];
    if (actions.length === 0) {
      return;
    }
    const menu = new Menu();
    for (const action of actions) {
      menu.addItem((item) => {
        item
          .setTitle(action.label)
          .setIcon(action.icon)
          .setDisabled(action.disabled)
          .onClick(() => {
            if (!action.disabled) {
              this.reader?.runToolbarAction(action.id);
            }
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  getEphemeralState(): Record<string, unknown> {
    return {
      ...super.getEphemeralState(),
      ...(this.reader ? { page: this.reader.currentPage } : {}),
    };
  }

  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    this.applyPageState(state);
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    this.installReaderToolbar();
    if (Platform.isPhone) {
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) =>
          this.syncMobileReaderBottomNavigation(leaf === this.leaf),
        ),
      );
      this.syncMobileReaderBottomNavigation(
        this.app.workspace.getActiveViewOfType(SupernoteNoteView) === this,
      );
    }
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.file?.path) {
          void this.loadRevision(file).catch((error: unknown) => {
            new Notice(
              error instanceof Error
                ? error.message
                : "Could not refresh this Supernote notebook.",
              10_000,
            );
          });
        }
      }),
    );
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.pendingPage = pageFromViewState(state);
    await super.setState(state, result);
    this.applyPendingPage();
  }

  private applyPageState(state: unknown): void {
    const page = pageFromViewState(state);
    if (page !== null) {
      this.pendingPage = page;
      this.applyPendingPage();
    }
  }

  private applyPendingPage(): void {
    const requestedPage = this.pendingPage;
    const reader = this.reader;
    if (requestedPage === null || !reader) {
      return;
    }
    this.pendingPage = null;
    const plan = planPageOpen(
      requestedPage,
      reader.currentPage,
      reader.pageCount,
    );
    if (plan.unavailablePage !== null) {
      this.reportUnavailablePage(plan.unavailablePage, reader.pageCount);
      return;
    }
    reader.goToPage(plan.page);
  }

  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.loadRevision(file);
  }

  private async loadRevision(file: TFile): Promise<void> {
    const revision = `${file.stat.mtime}:${file.stat.size}`;
    const previous = this.reader;
    if (previous?.sourcePath === file.path && previous.revision === revision) {
      return;
    }
    const generation = ++this.loadGeneration;
    const sameNotebook = previous?.sourcePath === file.path;
    if (previous && !sameNotebook) {
      previous.destroy();
      this.reader = null;
      this.syncMobileReaderBottomNavigation(false);
      this.setReaderToolbarContext(null);
      this.contentEl.empty();
    }
    this.contentEl.addClass("supernote-note-view");
    let session;
    try {
      session = await this.dependencies.notebooks.open({
        path: file.path,
        revision,
        load: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      });
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      throw error;
    }
    if (generation !== this.loadGeneration) {
      session.close();
      return;
    }
    const pageOpen = planPageOpen(
      this.pendingPage,
      (sameNotebook ? previous?.currentPage : null) ??
        session.descriptor.devicePage ??
        1,
      session.descriptor.pageCount,
    );
    const handoff = planRevisionHandoff(
      pageOpen.page,
      sameNotebook ? (previous?.selectedPages ?? []) : [],
      session.descriptor.pageCount,
    );
    let replacementHandle: NotebookBitmapHandle | null = null;
    try {
      const admission = session.updateView({
        visible: true,
        currentPage: handoff.currentPage,
        gridOpen: false,
        canvasBytes: 0,
      });
      if (!admission.admitted) {
        throw new Error(
          admission.reason === "resource-budget"
            ? "Could not reserve memory for the updated Supernote notebook."
            : "Supernote rendering is unavailable for the updated notebook.",
        );
      }
      replacementHandle = await session.bitmap(handoff.currentPage);
    } catch (error) {
      replacementHandle?.release();
      session.close();
      if (generation !== this.loadGeneration) {
        return;
      }
      if (sameNotebook && previous) {
        new Notice(
          `${
            error instanceof Error
              ? error.message
              : "Could not render the updated Supernote notebook."
          } Reopen the note or sync again to retry.`,
          10_000,
        );
        return;
      }
      throw error;
    }
    if (generation !== this.loadGeneration) {
      replacementHandle.release();
      session.close();
      return;
    }
    const staging = this.contentEl.createDiv({
      cls: "supernote-reader-staging",
    });
    let replacement: NoteReader;
    try {
      replacement = new NoteReader({
        app: this.app,
        container: staging,
        rawNotePath: file.path,
        session,
        getTranscriptionAvailability:
          this.dependencies.getTranscriptionAvailability,
        getTargetFolder: this.dependencies.getTargetFolder,
        exportPages: this.dependencies.exportPages,
        getExportDefaults: this.dependencies.getExportDefaults,
        initialPage: handoff.currentPage,
        initialSelectedPages: handoff.selectedPages,
        initialPageHandle: {
          pageNumber: handoff.currentPage,
          handle: replacementHandle,
        },
        toolbarChanged: (context) => {
          if (this.reader?.revision === revision) {
            this.setReaderToolbarContext(context);
          }
        },
      });
    } catch (error) {
      replacementHandle.release();
      staging.remove();
      session.close();
      if (sameNotebook && previous) {
        new Notice(
          `${
            error instanceof Error
              ? error.message
              : "Could not present the updated Supernote notebook."
          } Reopen the note or sync again to retry.`,
          10_000,
        );
        return;
      }
      throw error;
    }
    if (sameNotebook && previous && replacement.rejectedInitialPageAdmission) {
      replacement.destroy();
      staging.remove();
      return;
    }
    previous?.destroy();
    replacement.attachTo(this.contentEl);
    staging.remove();
    this.reader = replacement;
    this.syncMobileReaderBottomNavigation(
      this.app.workspace.getActiveViewOfType(SupernoteNoteView) === this,
    );
    this.setReaderToolbarContext(replacement.toolbarContext);
    if (handoff.discardedPages.length > 0) {
      new Notice(
        "The notebook became shorter. Review and select pages again before exporting.",
        10_000,
      );
    }
    this.pendingPage = null;
    if (pageOpen.unavailablePage !== null) {
      this.reportUnavailablePage(
        pageOpen.unavailablePage,
        session.descriptor.pageCount,
      );
    }
  }

  private reportUnavailablePage(
    requestedPage: number,
    pageCount: number,
  ): void {
    new Notice(
      `Page ${requestedPage} is not available in ${
        this.file?.basename ?? "this notebook"
      }; it has ${pageCount} page${pageCount === 1 ? "" : "s"}.`,
      10_000,
    );
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.loadGeneration += 1;
    this.reader?.destroy();
    this.reader = null;
    this.syncMobileReaderBottomNavigation(false);
    this.setReaderToolbarContext(null);
    await super.onUnloadFile(file);
  }

  async onClose(): Promise<void> {
    this.syncMobileReaderBottomNavigation(false);
    await super.onClose();
  }
}
