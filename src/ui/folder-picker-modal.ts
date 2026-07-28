import {
  ButtonComponent,
  Menu,
  Modal,
  Platform,
  setIcon,
  type App,
} from "obsidian";

import type { SupernoteCloudClient } from "../cloud/client";
import type { CloudFile, CloudItem } from "../cloud/types";
import { cloudBrowserFilePresentation } from "./cloud-browser-presentation";
import type { CloudBrowserSyncStatus } from "./cloud-browser-status";

export type OpenCloudFile = (
  file: CloudFile,
  remotePath: string,
) => Promise<void>;
export type MirrorCloudFolder = (
  directoryId: string,
  remotePath: string,
) => Promise<boolean>;
export interface StopMirroringPreview {
  remoteIds: string[];
}
export type PreviewStopMirroringFolder = (
  directoryId: string,
  remotePath: string,
) => Promise<StopMirroringPreview>;
export type StopMirroringFolder = (
  directoryId: string,
  remotePath: string,
  preview: StopMirroringPreview,
) => Promise<void>;

export interface CloudBrowserItemState {
  status: CloudBrowserSyncStatus;
  includedVia?: string | null;
}

export type ResolveCloudBrowserState = (
  item: Pick<CloudItem, "id" | "isFolder" | "md5">,
  remotePath: string,
) => CloudBrowserItemState;

const STATUS_LABELS: Record<CloudBrowserSyncStatus, string> = {
  "not-synced": "Not synced",
  mirrored: "Mirrored",
  included: "Included",
  downloaded: "Downloaded",
  "update-available": "Update available",
  "writable-sync": "Paired folder",
};

interface Location {
  id: string;
  path: string;
  label: string;
}

interface FolderPickerModalOptions {
  folderActionLabel?: string;
  foldersOnly?: boolean;
  initialLocation?: {
    id: string;
    path: string;
    label?: string;
  };
  onChanged?: () => void;
  openDownloadedFile?: OpenCloudFile;
  previewStopMirroringFolder?: PreviewStopMirroringFolder;
  stopMirroringFolder?: StopMirroringFolder;
}

type RetryKind = "download" | "mirror" | "stop";
type NavigationDirection = "forward" | "back" | "replace";

interface OperationError {
  kind: RetryKind;
  message: string;
  retryStatus?: CloudBrowserSyncStatus;
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

class StopMirroringConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly remotePath: string,
    private readonly fileCount: number,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.setTitle("Stop mirroring?");
    this.contentEl.createEl("p", {
      text:
        this.fileCount === 0
          ? `${this.remotePath} will no longer receive Cloud updates. No downloaded files need to be removed.`
          : `${this.fileCount} downloaded file${
              this.fileCount === 1 ? "" : "s"
            } from ${this.remotePath} will move to Obsidian Trash. Files covered by another Mirrored folder will remain.`,
    });
    const actions = this.contentEl.createDiv({
      cls: "supernote-sync-confirm-actions",
    });
    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => this.finish(false));
    new ButtonComponent(actions)
      .setButtonText("Stop mirroring")
      .setWarning()
      .onClick(() => this.finish(true));
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }

  private finish(confirmed: boolean): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}

const confirmStopMirroring = (
  app: App,
  remotePath: string,
  fileCount: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    new StopMirroringConfirmationModal(
      app,
      remotePath,
      fileCount,
      resolve,
    ).open();
  });

export class FolderPickerModal extends Modal {
  private readonly locations: Location[] = [
    { id: "0", path: "", label: "Supernote Cloud" },
  ];
  private readonly operationErrors = new Map<string, OperationError>();
  private breadcrumbsEl!: HTMLElement;
  private currentActionEl!: HTMLElement;
  private navigationEl!: HTMLElement;
  private closed = false;
  private listEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private operationInProgress = false;
  private renderGeneration = 0;

  constructor(
    app: App,
    private readonly cloud: SupernoteCloudClient,
    private readonly openFile: OpenCloudFile,
    private readonly mirrorFolder: MirrorCloudFolder,
    private readonly resolveState?: ResolveCloudBrowserState,
    private readonly options: FolderPickerModalOptions = {},
  ) {
    super(app);
    const initial = options.initialLocation;
    if (initial?.id && initial.path) {
      this.locations.push({
        id: initial.id,
        path: initial.path,
        label:
          initial.label ??
          initial.path.slice(initial.path.lastIndexOf("/") + 1),
      });
    }
  }

  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("supernote-sync-browser-modal");
    this.modalEl.toggleClass("is-mobile", Platform.isMobile);
    this.contentEl.empty();
    this.contentEl.addClass("supernote-sync-browser");
    this.setTitle("Supernote Cloud");
    const header = this.contentEl.createDiv({
      cls: "supernote-sync-browser-header",
    });
    this.navigationEl = header.createDiv({
      cls: "supernote-sync-browser-navigation",
    });
    this.breadcrumbsEl = this.navigationEl.createDiv({
      cls: "supernote-sync-browser-breadcrumbs",
    });
    this.currentActionEl = this.navigationEl.createDiv({
      cls: "supernote-sync-browser-current-action",
    });
    this.progressEl = this.contentEl.createDiv({
      cls: "supernote-sync-browser-progress",
      attr: { "aria-live": "polite" },
    });
    this.progressEl.hidden = true;
    this.listEl = this.contentEl.createDiv({
      cls: "supernote-sync-browser-list",
      attr: { "aria-live": "polite" },
    });
    void this.renderDirectory();
  }

  onClose(): void {
    this.closed = true;
    this.renderGeneration += 1;
    this.contentEl.empty();
  }

  private async renderDirectory(
    direction: NavigationDirection = "replace",
  ): Promise<void> {
    const generation = ++this.renderGeneration;
    const location = this.currentLocation;
    this.renderBreadcrumbs();
    this.renderCurrentAction(location);
    this.renderLoadingState(direction);
    try {
      const items = await this.cloud.listDirectory(location.id);
      if (generation !== this.renderGeneration) {
        return;
      }
      this.listEl.empty();
      this.listEl.setAttr("aria-busy", "false");
      const results = this.listEl.createDiv({
        cls: `supernote-sync-browser-results ${this.transitionClass(direction)}`,
      });
      const visibleItems = items
        .filter((item) => !this.options.foldersOnly || item.isFolder)
        .sort(
          (left, right) =>
            Number(right.isFolder) - Number(left.isFolder) ||
            left.fileName.localeCompare(right.fileName),
        );
      if (visibleItems.length === 0) {
        results.createEl("p", {
          text: this.options.foldersOnly
            ? "No folders are in this location."
            : "No folders or files are in this location.",
          cls: "supernote-sync-muted",
        });
        return;
      }
      for (const item of visibleItems) {
        this.renderItem(results, item, location);
      }
    } catch (error) {
      if (generation !== this.renderGeneration) {
        return;
      }
      this.listEl.empty();
      this.listEl.setAttr("aria-busy", "false");
      const failure = this.listEl.createDiv({
        cls: "supernote-sync-browser-load-error",
      });
      failure.createEl("p", {
        text: errorMessage(error, "Could not load this folder."),
        cls: "supernote-sync-error",
      });
      this.createTextButton(failure, "Retry", () => {
        void this.renderDirectory();
      });
    }
  }

  private renderBreadcrumbs(): void {
    this.breadcrumbsEl.empty();
    this.navigationEl.hidden = this.locations.length === 1;
    if (this.locations.length === 1) {
      return;
    }
    if (Platform.isMobile) {
      const parent = this.locations.at(-2)!;
      this.createIconButton(
        this.breadcrumbsEl,
        "chevron-left",
        `Back to ${parent.label}`,
        () => {
          this.locations.pop();
          void this.renderDirectory("back");
        },
      );
      this.breadcrumbsEl.createSpan({
        text: this.currentLocation.label,
        cls: "supernote-sync-browser-mobile-location",
        attr: { "aria-current": "location" },
      });
      return;
    }
    const rootButton = this.createIconButton(
      this.breadcrumbsEl,
      "cloud",
      "Supernote Cloud",
      () => {
        this.locations.splice(1);
        void this.renderDirectory("back");
      },
    );
    rootButton.addClass("supernote-sync-browser-breadcrumb-root");
    for (const [nestedIndex, location] of this.locations.slice(1).entries()) {
      const index = nestedIndex + 1;
      this.breadcrumbsEl.createSpan({
        text: "›",
        cls: "supernote-sync-browser-breadcrumb-separator",
      });
      if (index === this.locations.length - 1) {
        this.breadcrumbsEl.createSpan({
          text: location.label,
          cls: "supernote-sync-browser-breadcrumb is-current",
          attr: { "aria-current": "location" },
        });
      } else {
        this.createTextButton(
          this.breadcrumbsEl,
          location.label,
          () => {
            this.locations.splice(index + 1);
            void this.renderDirectory("back");
          },
          "supernote-sync-browser-breadcrumb",
        );
      }
    }
  }

  private renderCurrentAction(location: Location): void {
    this.currentActionEl.empty();
    if (this.locations.length === 1) {
      return;
    }
    if (this.options.folderActionLabel) {
      this.createTextButton(
        this.currentActionEl,
        this.options.folderActionLabel,
        () => {
          void this.runOperation(
            location.path,
            "mirror",
            `Selecting ${location.label}…`,
            async () => {
              const selected = await this.mirrorFolder(
                location.id,
                location.path,
              );
              if (selected) {
                this.close();
              }
              return selected;
            },
          );
        },
      ).disabled = this.operationInProgress;
      return;
    }
    const state = this.stateForFolder(location);
    const operationError = this.operationErrors.get(location.path);
    if (operationError) {
      this.renderErrorState(this.currentActionEl, location, operationError);
      return;
    }
    if (Platform.isMobile) {
      this.renderMobileCurrentFolderMenu(location, state);
      return;
    }
    this.renderFolderStateControls(this.currentActionEl, location, state, true);
  }

  private renderMobileCurrentFolderMenu(
    location: Location,
    state: CloudBrowserItemState,
  ): void {
    const canMirror =
      state.status !== "mirrored" &&
      state.status !== "included" &&
      state.status !== "writable-sync";
    const canStopMirroring =
      state.status === "mirrored" &&
      this.options.previewStopMirroringFolder &&
      this.options.stopMirroringFolder;
    if (!canMirror && !canStopMirroring) {
      return;
    }
    const button = this.currentActionEl.createEl("button", {
      cls: "clickable-icon supernote-sync-browser-more",
      attr: {
        type: "button",
        "aria-label": `Actions for ${location.label}`,
        title: `Actions for ${location.label}`,
      },
    });
    setIcon(button, "more-horizontal");
    button.disabled = this.operationInProgress;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = new Menu();
      if (canMirror) {
        menu.addItem((item) =>
          item
            .setTitle("Mirror this folder")
            .setIcon("cloud-download")
            .onClick(() => {
              void this.runOperation(
                location.path,
                "mirror",
                `Mirroring ${location.label}…`,
                () => this.mirrorFolder(location.id, location.path),
              );
            }),
        );
      }
      if (canStopMirroring) {
        menu.addItem((item) =>
          item
            .setTitle("Stop mirroring…")
            .setIcon("trash-2")
            .onClick(() => {
              void this.confirmAndStopMirroring(location);
            }),
        );
      }
      menu.showAtMouseEvent(event);
    });
  }

  private renderLoadingState(direction: NavigationDirection): void {
    this.listEl.empty();
    this.listEl.setAttr("aria-busy", "true");
    const skeletons = this.listEl.createDiv({
      cls: `supernote-sync-browser-skeletons ${this.transitionClass(direction)}`,
      attr: { "aria-label": "Loading folder" },
    });
    for (let index = 0; index < 5; index += 1) {
      const row = skeletons.createDiv({
        cls: "supernote-sync-browser-skeleton-row",
      });
      row.createSpan({ cls: "supernote-sync-browser-skeleton-icon" });
      const text = row.createDiv({
        cls: "supernote-sync-browser-skeleton-text",
      });
      text.createSpan({ cls: "supernote-sync-browser-skeleton-name" });
      text.createSpan({ cls: "supernote-sync-browser-skeleton-subtitle" });
    }
  }

  private transitionClass(direction: NavigationDirection): string {
    return direction === "forward"
      ? "is-entering-forward"
      : direction === "back"
        ? "is-entering-back"
        : "is-entering";
  }

  private renderItem(
    container: HTMLElement,
    item: CloudItem,
    location: Location,
  ): void {
    const remotePath = `${location.path}/${item.fileName}`;
    const state = this.resolveState?.(item, remotePath) ?? {
      status: "not-synced" as const,
    };
    const row = container.createDiv({
      cls: "supernote-sync-file-row",
    });
    const primary = row.createDiv({
      cls: "supernote-sync-file-primary",
      ...(!Platform.isMobile ? { attr: { role: "button" } } : {}),
    });
    if (!Platform.isMobile) {
      primary.tabIndex = 0;
    }
    const icon = primary.createSpan({ cls: "supernote-sync-file-icon" });
    setIcon(
      icon,
      item.isFolder
        ? "folder"
        : item.fileName.toLocaleLowerCase().endsWith(".note")
          ? "notebook-tabs"
          : "file",
    );
    const description = primary.createDiv({
      cls: "supernote-sync-file-description",
    });
    description.createSpan({
      text: item.fileName,
      cls: "supernote-sync-file-name",
    });
    const subtitle = description.createSpan({
      text: this.itemStatusLabel(item, state),
      cls: "supernote-sync-file-subtitle",
    });
    const controls = row.createDiv({ cls: "supernote-sync-file-controls" });
    const operationError = this.operationErrors.get(remotePath);

    if (item.isFolder) {
      const openFolder = (): void => {
        this.locations.push({
          id: item.id,
          path: remotePath,
          label: item.fileName,
        });
        void this.renderDirectory("forward");
      };
      this.makeKeyboardClickable(Platform.isMobile ? row : primary, openFolder);
      if (Platform.isMobile) {
        this.addTrailingIcon(controls, "chevron-right");
      } else if (!this.options.foldersOnly) {
        if (operationError) {
          this.renderErrorState(
            controls,
            { id: item.id, path: remotePath, label: item.fileName },
            operationError,
          );
        } else {
          this.renderFolderStateControls(
            controls,
            { id: item.id, path: remotePath, label: item.fileName },
            state,
            false,
          );
        }
      }
      return;
    }

    const file = item as CloudFile;
    const openStatus = operationError?.retryStatus ?? state.status;
    const open = (): void => {
      if (this.operationInProgress) {
        return;
      }
      this.showRowProgress(row, openStatus);
      void this.openCloudFile(file, remotePath, openStatus);
    };
    if (operationError) {
      if (Platform.isMobile) {
        subtitle.setText(operationError.message);
        subtitle.addClass("is-error");
        row.setAttr(
          "aria-label",
          `${item.fileName}. ${operationError.message}. Retry.`,
        );
        this.makeKeyboardClickable(row, open);
        this.addTrailingIcon(controls, "refresh-cw");
        return;
      }
      this.makeKeyboardClickable(primary, open);
      this.renderFileError(controls, operationError, open);
      return;
    }
    this.makeKeyboardClickable(Platform.isMobile ? row : primary, open);
    if (Platform.isMobile) {
      const presentation = cloudBrowserFilePresentation(state.status);
      row.setAttr(
        "aria-label",
        `${item.fileName}. ${presentation.statusLabel}. ${presentation.actionLabel}.`,
      );
      this.addTrailingIcon(controls, presentation.trailingIcon);
      return;
    }
    this.createTextButton(
      controls,
      cloudBrowserFilePresentation(state.status).actionLabel.replace(
        "Download and open",
        "Download",
      ),
      open,
      "supernote-sync-file-action",
    ).disabled = this.operationInProgress;
  }

  private itemStatusLabel(
    item: CloudItem,
    state: CloudBrowserItemState,
  ): string {
    if (!item.isFolder) {
      return cloudBrowserFilePresentation(state.status).statusLabel;
    }
    if (state.status === "not-synced") {
      return "Cloud folder";
    }
    return this.statusLabel(state);
  }

  private addTrailingIcon(
    container: HTMLElement,
    icon: Parameters<typeof setIcon>[1],
  ): void {
    const trailing = container.createSpan({
      cls: "supernote-sync-file-trailing-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(trailing, icon);
  }

  private showRowProgress(
    row: HTMLElement,
    status: CloudBrowserSyncStatus,
  ): void {
    row.addClass("is-working");
    row.setAttr("aria-busy", "true");
    const progressLabel =
      status === "downloaded" ||
      status === "mirrored" ||
      status === "writable-sync"
        ? "Opening…"
        : "Downloading…";
    row
      .querySelector<HTMLElement>(".supernote-sync-file-subtitle")
      ?.setText(progressLabel);
    const trailing = row.querySelector<HTMLElement>(
      ".supernote-sync-file-trailing-icon",
    );
    if (trailing) {
      trailing.empty();
      trailing.addClass("is-spinning");
      setIcon(trailing, "loader-circle");
    }
    const action = row.querySelector<HTMLButtonElement>(
      ".supernote-sync-file-action",
    );
    if (action) {
      action.disabled = true;
      action.empty();
      const spinner = action.createSpan({
        cls: "supernote-sync-file-action-spinner is-spinning",
      });
      setIcon(spinner, "loader-circle");
      action.createSpan({
        text: progressLabel,
      });
    }
  }

  private renderFolderStateControls(
    container: HTMLElement,
    location: Location,
    state: CloudBrowserItemState,
    currentFolder: boolean,
  ): void {
    if (state.status === "mirrored") {
      if (currentFolder) {
        this.addStatus(container, "Mirrored", false, state.status);
      }
      this.addStopMirroringMenu(container, location);
      return;
    }
    if (state.status === "included") {
      if (currentFolder) {
        this.addStatus(container, this.statusLabel(state), false, state.status);
      }
      return;
    }
    if (state.status === "writable-sync") {
      if (currentFolder) {
        this.addStatus(
          container,
          STATUS_LABELS[state.status],
          false,
          state.status,
        );
      }
      return;
    }
    const mirror = (): void => {
      void this.runOperation(
        location.path,
        "mirror",
        `Mirroring ${location.label}…`,
        () => this.mirrorFolder(location.id, location.path),
      );
    };
    if (currentFolder) {
      this.createIconButton(
        container,
        "cloud-download",
        "Mirror this folder",
        mirror,
      ).disabled = this.operationInProgress;
    } else {
      this.createTextButton(container, "Mirror", mirror).disabled =
        this.operationInProgress;
    }
  }

  private addStopMirroringMenu(
    container: HTMLElement,
    location: Location,
  ): void {
    if (
      !this.options.previewStopMirroringFolder ||
      !this.options.stopMirroringFolder
    ) {
      return;
    }
    const button = container.createEl("button", {
      cls: "clickable-icon supernote-sync-browser-more",
      attr: {
        type: "button",
        "aria-label": `Manage ${location.label}`,
        title: `Manage ${location.label}`,
      },
    });
    setIcon(button, "more-horizontal");
    button.disabled = this.operationInProgress;
    button.addEventListener("click", (event) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Stop mirroring…")
          .setIcon("trash-2")
          .onClick(() => {
            void this.confirmAndStopMirroring(location);
          }),
      );
      menu.showAtMouseEvent(event);
    });
  }

  private async confirmAndStopMirroring(location: Location): Promise<void> {
    const preview = this.options.previewStopMirroringFolder;
    const stop = this.options.stopMirroringFolder;
    if (!preview || !stop || this.operationInProgress) {
      return;
    }
    this.operationInProgress = true;
    this.progressEl.hidden = false;
    this.progressEl.setText(`Checking ${location.label}…`);
    this.setMutationButtonsDisabled(true);
    try {
      const snapshot = await preview(location.id, location.path);
      if (this.closed) {
        return;
      }
      this.progressEl.hidden = true;
      const confirmed = await confirmStopMirroring(
        this.app,
        location.path,
        snapshot.remoteIds.length,
      );
      if (!confirmed) {
        return;
      }
      this.progressEl.hidden = false;
      this.progressEl.setText(`Stopping mirroring for ${location.label}…`);
      await stop(location.id, location.path, snapshot);
      this.operationErrors.delete(location.path);
      this.options.onChanged?.();
    } catch (error) {
      this.operationErrors.set(location.path, {
        kind: "stop",
        message: errorMessage(error, "Could not stop mirroring."),
      });
    } finally {
      this.operationInProgress = false;
      this.progressEl.hidden = true;
      if (!this.closed) {
        await this.renderDirectory();
      }
    }
  }

  private async openCloudFile(
    file: CloudFile,
    remotePath: string,
    status: CloudBrowserSyncStatus,
  ): Promise<void> {
    const useLocalCopy =
      status === "downloaded" ||
      status === "mirrored" ||
      status === "writable-sync";
    const action =
      useLocalCopy && this.options.openDownloadedFile
        ? this.options.openDownloadedFile
        : this.openFile;
    await this.runOperation(
      remotePath,
      "download",
      `${useLocalCopy ? "Opening" : "Downloading"} ${file.fileName}…`,
      async () => {
        await action(file, remotePath);
        this.close();
        return true;
      },
      status,
    );
  }

  private renderFileError(
    container: HTMLElement,
    error: OperationError,
    retry: () => void,
  ): void {
    this.addStatus(container, error.message, true);
    this.createTextButton(container, "Retry", retry).disabled =
      this.operationInProgress;
  }

  private renderErrorState(
    container: HTMLElement,
    location: Location,
    error: OperationError,
  ): void {
    this.addStatus(container, error.message, true);
    this.createTextButton(container, "Retry", () => {
      if (error.kind === "stop") {
        void this.confirmAndStopMirroring(location);
        return;
      }
      void this.runOperation(
        location.path,
        "mirror",
        `Mirroring ${location.label}…`,
        () => this.mirrorFolder(location.id, location.path),
      );
    }).disabled = this.operationInProgress;
  }

  private async runOperation(
    path: string,
    kind: RetryKind,
    progress: string,
    action: () => Promise<boolean>,
    retryStatus?: CloudBrowserSyncStatus,
  ): Promise<void> {
    if (this.operationInProgress) {
      return;
    }
    this.operationInProgress = true;
    this.progressEl.hidden = false;
    this.progressEl.setText(progress);
    this.setMutationButtonsDisabled(true);
    try {
      if (!(await action())) {
        throw new Error(
          kind === "mirror"
            ? "Couldn’t mirror · Retry"
            : "Couldn’t complete this action · Retry",
        );
      }
      this.operationErrors.delete(path);
      this.options.onChanged?.();
    } catch (error) {
      this.operationErrors.set(path, {
        kind,
        message: errorMessage(
          error,
          kind === "download"
            ? "Couldn’t download · Retry"
            : kind === "stop"
              ? "Couldn’t stop mirroring · Retry"
              : "Couldn’t mirror · Retry",
        ),
        ...(retryStatus ? { retryStatus } : {}),
      });
    } finally {
      this.operationInProgress = false;
      this.progressEl.hidden = true;
      if (!this.closed) {
        await this.renderDirectory();
      }
    }
  }

  private setMutationButtonsDisabled(disabled: boolean): void {
    for (const button of this.contentEl.querySelectorAll<HTMLButtonElement>(
      ".supernote-sync-file-controls button, .supernote-sync-browser-current-action button",
    )) {
      button.disabled = disabled;
    }
  }

  private statusLabel(state: CloudBrowserItemState): string {
    return state.status === "included" && state.includedVia
      ? `Included via “${state.includedVia}”`
      : STATUS_LABELS[state.status];
  }

  private stateForFolder(location: Location): CloudBrowserItemState {
    return (
      this.resolveState?.(
        { id: location.id, isFolder: true, md5: "" },
        location.path,
      ) ?? { status: "not-synced" }
    );
  }

  private addStatus(
    container: HTMLElement,
    text: string,
    error = false,
    status?: CloudBrowserSyncStatus,
  ): void {
    container.createSpan({
      text,
      cls: `supernote-sync-status${error ? " is-error" : ""}${
        status ? ` is-${status}` : ""
      }`,
    });
  }

  private createTextButton(
    container: HTMLElement,
    text: string,
    onClick: () => void,
    cls = "",
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      text,
      cls,
      attr: { type: "button" },
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private createIconButton(
    container: HTMLElement,
    icon: Parameters<typeof setIcon>[1],
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "clickable-icon",
      attr: {
        type: "button",
        "aria-label": label,
        title: label,
      },
    });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private makeKeyboardClickable(
    element: HTMLElement,
    onActivate: () => void,
  ): void {
    element.tabIndex = 0;
    if (!element.hasAttribute("role")) {
      element.setAttr("role", "button");
    }
    element.addEventListener("click", onActivate);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    });
  }

  private get currentLocation(): Location {
    return this.locations.at(-1)!;
  }
}
