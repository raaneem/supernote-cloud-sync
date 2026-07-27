import { setIcon, type App } from "obsidian";

const FILE_EXPLORER_VIEW_TYPE = "file-explorer";
const INDICATOR_CLASS = "supernote-sync-mirror-tree-indicator";

export class MirroredFolderTreeIndicator {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private started = false;
  private refreshQueued = false;

  constructor(
    private readonly app: App,
    private readonly paths: () => readonly string[],
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.refresh();
  }

  refresh(): void {
    if (!this.started || this.refreshQueued) {
      return;
    }
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.started) {
        this.decorateVisibleFolders();
      }
    });
  }

  stop(): void {
    this.started = false;
    for (const [container, observer] of this.observers) {
      observer.disconnect();
      this.removeIndicators(container);
    }
    this.observers.clear();
  }

  private decorateVisibleFolders(): void {
    const containers = new Set(
      this.app.workspace
        .getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)
        .map((leaf) => leaf.view.containerEl),
    );
    for (const [container, observer] of this.observers) {
      if (!containers.has(container)) {
        observer.disconnect();
        this.removeIndicators(container);
        this.observers.delete(container);
      }
    }
    for (const container of containers) {
      if (!this.observers.has(container)) {
        const observer = new MutationObserver(() => this.refresh());
        observer.observe(container, { childList: true, subtree: true });
        this.observers.set(container, observer);
      }
      this.decorateContainer(container);
    }
  }

  private decorateContainer(container: HTMLElement): void {
    const mirroredPaths = new Set(this.paths());
    for (const title of container.querySelectorAll<HTMLElement>(
      ".nav-folder-title[data-path]",
    )) {
      const existing = title.querySelector<HTMLElement>(`.${INDICATOR_CLASS}`);
      const path = title.dataset.path;
      if (!path || !mirroredPaths.has(path)) {
        existing?.remove();
        continue;
      }
      if (existing) {
        continue;
      }
      const indicator = title.createSpan({ cls: INDICATOR_CLASS });
      indicator.setAttr("aria-label", "Synced with Supernote Cloud");
      setIcon(indicator, "cloud");
    }
  }

  private removeIndicators(container: HTMLElement): void {
    for (const indicator of container.querySelectorAll(`.${INDICATOR_CLASS}`)) {
      indicator.remove();
    }
  }
}
