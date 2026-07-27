import { App, Modal, Notice, Platform, setIcon } from "obsidian";

import {
  type RunIndicator,
  type RunRecord,
  type RunRegistrySignal,
  RunRegistry,
} from "./run-registry";
import { RunLogPaintScheduler } from "./run-log-paint-scheduler";
import type {
  PairConflict,
  PairConflictResolution,
} from "../sync/pair-sync-service";

const statusLabel = (status: RunRecord["status"]): string =>
  status.replace("-", " ");

const elapsedLabel = (
  run: Pick<RunRecord, "startedAt" | "finishedAt">,
  now = Date.now(),
): string => {
  const elapsed = Math.max(0, (run.finishedAt ?? now) - run.startedAt);
  if (elapsed < 1_000) {
    return `${elapsed}ms`;
  }
  return `${(elapsed / 1_000).toFixed(1)}s`;
};

interface RunElements {
  batch: HTMLElement;
  batchCode: HTMLElement;
  cancel: HTMLButtonElement;
  cursor: number;
  details: HTMLDetailsElement;
  exitCode: HTMLElement;
  firstSequence: number | null;
  log: HTMLElement;
  status: RunRecord["status"];
  statusIcon: HTMLElement;
  statusText: HTMLElement;
  stickToBottom: boolean;
  timing: HTMLElement;
  title: HTMLElement;
}

export interface PairConflictController {
  conflicts(): readonly PairConflict[];
  resolve(
    conflictId: string,
    resolution: PairConflictResolution,
  ): Promise<void>;
}

class RunListView {
  private readonly unsubscribe: () => void;
  private readonly paintScheduler: RunLogPaintScheduler;
  private durationTimer: number | null = null;
  private readonly elements = new Map<string, RunElements>();
  private emptyState: HTMLElement | null = null;
  private conflictSection: HTMLElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly runs: RunRegistry,
    private readonly pairConflicts?: PairConflictController,
  ) {
    this.container.addClass("supernote-run-console");
    this.paintScheduler = new RunLogPaintScheduler(
      (callback) => window.requestAnimationFrame(callback),
      (handle) => window.cancelAnimationFrame(handle),
      (runIds) => {
        for (const runId of runIds) {
          this.paintLog(runId);
        }
      },
    );
    this.runs.acknowledgeFailures();
    this.unsubscribe = runs.subscribe((signal) => this.handleSignal(signal));
    this.reconcileConflicts();
    this.reconcile();
  }

  dispose(): void {
    this.unsubscribe();
    this.paintScheduler.dispose();
    if (this.durationTimer !== null) {
      window.clearTimeout(this.durationTimer);
    }
  }

  private handleSignal(signal: RunRegistrySignal): void {
    if (signal.type === "log") {
      this.paintScheduler.schedule(signal.runId);
      return;
    }
    if (signal.type === "metadata") {
      // Completion and failure must update even when animation frames pause.
      this.paintScheduler.flush();
      this.reconcile();
      return;
    }
    this.reconcileConflicts();
  }

  private reconcile(): void {
    const records = this.runs.records();
    if (records.length === 0) {
      this.removeMissingRuns(new Set());
      this.emptyState ??= this.container.createEl("p", {
        cls: "supernote-run-empty",
        text: "No Supernote activity in this session.",
      });
      return;
    }

    this.emptyState?.remove();
    this.emptyState = null;
    const retainedIds = new Set(records.map((record) => record.id));
    for (const run of records) {
      let elements = this.elements.get(run.id);
      const created = !elements;
      if (!elements) {
        elements = this.createRun(run);
        this.elements.set(run.id, elements);
      }
      this.updateRun(elements, run);
      this.container.appendChild(elements.details);
      if (created) {
        this.paintLog(run.id);
      }
    }
    this.removeMissingRuns(retainedIds);
    this.scheduleDurationRefresh(
      records.some((run) => run.status === "running"),
    );
  }

  private createRun(run: RunRecord): RunElements {
    const details = this.container.createEl("details", {
      cls: `supernote-run is-${run.status}`,
      attr: { "data-run-id": run.id },
    });
    details.open = run.status === "running";
    const summary = details.createEl("summary");
    const title = summary.createSpan({ cls: "supernote-run-title" });
    title.createSpan({ text: run.label });
    title.createSpan({
      cls: "supernote-run-kind",
      text: run.kind,
    });
    const status = summary.createSpan({
      cls: "supernote-run-status",
    });
    const statusIcon = status.createSpan();
    const statusText = status.createSpan();

    const meta = details.createDiv({ cls: "supernote-run-meta" });
    meta.createSpan({ text: `${run.engine} · ${run.model}` });
    const timing = meta.createSpan({
      text: `${new Date(run.startedAt).toLocaleTimeString()} · `,
    });
    const duration = timing.createSpan({
      cls: "supernote-run-duration",
      attr: {
        "data-started-at": String(run.startedAt),
      },
    });
    const exitCode = meta.createSpan();

    const actions = details.createDiv({
      cls: "supernote-run-actions",
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.runs.cancel(run.id);
    });
    actions
      .createEl("button", { text: "Copy log" })
      .addEventListener("click", () => {
        const clipboard = navigator.clipboard;
        if (!clipboard) {
          new Notice("Clipboard access is unavailable.");
          return;
        }
        void clipboard
          .writeText(this.runs.logText(run.id))
          .then(() => new Notice("Run log copied."))
          .catch(() => new Notice("Could not copy the run log."));
      });

    const batch = details.createDiv({
      cls: "supernote-run-batch",
    });
    batch.createSpan({ text: "Retained batch: " });
    const batchCode = batch.createEl("code");

    const log = details.createEl("pre", {
      cls: "supernote-run-log",
      text: "Waiting for output…",
    });
    const elements: RunElements = {
      batch,
      batchCode,
      cancel,
      cursor: 0,
      details,
      exitCode,
      firstSequence: null,
      log,
      status: run.status,
      statusIcon,
      statusText,
      stickToBottom: true,
      timing: duration,
      title,
    };
    log.addEventListener(
      "scroll",
      () => {
        elements.stickToBottom =
          log.scrollHeight - log.scrollTop - log.clientHeight < 8;
      },
      { passive: true },
    );
    return elements;
  }

  private updateRun(elements: RunElements, run: RunRecord): void {
    elements.title.setText(run.label);
    if (elements.status !== run.status) {
      elements.details.removeClass(`is-${elements.status}`);
      elements.details.addClass(`is-${run.status}`);
      elements.status = run.status;
      setIcon(
        elements.statusIcon,
        run.status === "running"
          ? "loader-circle"
          : run.status === "succeeded"
            ? "circle-check"
            : "circle-alert",
      );
      elements.statusText.setText(statusLabel(run.status));
    } else if (!elements.statusText.textContent) {
      setIcon(
        elements.statusIcon,
        run.status === "running"
          ? "loader-circle"
          : run.status === "succeeded"
            ? "circle-check"
            : "circle-alert",
      );
      elements.statusText.setText(statusLabel(run.status));
    }
    elements.timing.setText(elapsedLabel(run));
    if (run.finishedAt === undefined) {
      elements.timing.removeAttribute("data-finished-at");
    } else {
      elements.timing.dataset.finishedAt = String(run.finishedAt);
    }
    elements.exitCode.toggle(run.exitCode !== undefined);
    elements.exitCode.setText(
      run.exitCode === undefined ? "" : `exit ${run.exitCode ?? "unknown"}`,
    );
    elements.cancel.toggle(run.status === "running" && run.cancellable);
    elements.batch.toggle(Boolean(run.batchPath));
    elements.batchCode.setText(run.batchPath ?? "");
  }

  private reconcileConflicts(): void {
    const conflicts = this.pairConflicts?.conflicts() ?? [];
    this.conflictSection?.remove();
    this.conflictSection = null;
    if (conflicts.length === 0) {
      return;
    }
    const section = document.createElement("section");
    section.className = "supernote-pair-conflicts";
    section.createEl("h3", {
      text: `Pair conflicts (${conflicts.length})`,
    });
    section.createEl("p", {
      text: "Choose which version should become authoritative. Keep both creates a separate Vault copy.",
    });
    for (const conflict of conflicts) {
      const row = section.createDiv({ cls: "supernote-pair-conflict" });
      row.createDiv({
        cls: "supernote-pair-conflict-path",
        text: conflict.remoteRelativePath,
      });
      row.createDiv({
        cls: "supernote-pair-conflict-kind",
        text: conflict.kind.replaceAll("-", " "),
      });
      const actions = row.createDiv({
        cls: "supernote-pair-conflict-actions",
      });
      for (const [label, resolution] of [
        ["Use Vault", "use-vault"],
        ["Use Remote", "use-remote"],
        ["Keep both", "keep-both"],
      ] as const) {
        const button = actions.createEl("button", { text: label });
        button.addEventListener("click", () => {
          for (const candidate of actions.querySelectorAll("button")) {
            candidate.disabled = true;
          }
          void this.pairConflicts
            ?.resolve(conflict.id, resolution)
            .then(() => this.reconcileConflicts())
            .catch((error: unknown) => {
              new Notice(
                error instanceof Error
                  ? error.message
                  : "Could not resolve the Pair conflict.",
              );
              this.reconcileConflicts();
            });
        });
      }
    }
    this.container.prepend(section);
    this.conflictSection = section;
  }

  private paintLog(runId: string): void {
    const elements = this.elements.get(runId);
    if (!elements) {
      return;
    }
    const priorScrollTop = elements.log.scrollTop;
    let rebuilt = false;
    let delta = this.runs.readLog(runId, elements.cursor);
    if (
      elements.firstSequence !== null &&
      elements.firstSequence < delta.oldestSequence
    ) {
      elements.log.empty();
      elements.cursor = delta.oldestSequence - 1;
      elements.firstSequence = null;
      rebuilt = true;
      delta = this.runs.readLog(runId, elements.cursor);
    }
    if (delta.entries.length === 0) {
      return;
    }
    if (elements.cursor === 0) {
      elements.log.empty();
    }
    const fragment = document.createDocumentFragment();
    for (const entry of delta.entries) {
      fragment.append(document.createTextNode(entry.text));
    }
    elements.log.appendChild(fragment);
    elements.firstSequence ??= delta.entries[0]!.sequence;
    elements.cursor = delta.cursor;
    if (elements.stickToBottom) {
      elements.log.scrollTop = elements.log.scrollHeight;
    } else if (rebuilt) {
      elements.log.scrollTop = priorScrollTop;
    }
  }

  private removeMissingRuns(retainedIds: ReadonlySet<string>): void {
    for (const [runId, elements] of this.elements) {
      if (retainedIds.has(runId)) {
        continue;
      }
      elements.details.remove();
      this.elements.delete(runId);
    }
  }

  private scheduleDurationRefresh(hasActiveRuns: boolean): void {
    if (this.durationTimer !== null) {
      window.clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    if (!hasActiveRuns) {
      return;
    }
    this.durationTimer = window.setTimeout(() => {
      for (const element of this.container.querySelectorAll<HTMLElement>(
        ".supernote-run-duration:not([data-finished-at])",
      )) {
        const startedAt = Number(element.dataset.startedAt);
        if (Number.isFinite(startedAt)) {
          element.setText(elapsedLabel({ startedAt }));
        }
      }
      this.scheduleDurationRefresh(true);
    }, 1_000);
  }
}

class RunConsoleModal extends Modal {
  private view: RunListView | null = null;

  constructor(
    app: App,
    private readonly runs: RunRegistry,
    private readonly pairConflicts?: PairConflictController,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Supernote activity");
    this.view = new RunListView(this.contentEl, this.runs, this.pairConflicts);
  }

  onClose(): void {
    this.view?.dispose();
    this.view = null;
    this.contentEl.empty();
  }
}

export class RunConsoleController {
  private readonly unsubscribe: () => void;
  private popover: HTMLElement | null = null;
  private popoverView: RunListView | null = null;
  private successTimer: number | null = null;
  private renderedIndicator = "";
  private readonly outsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (
      target instanceof Node &&
      !this.popover?.contains(target) &&
      !this.statusEl?.contains(target)
    ) {
      this.closePopover();
    }
  };
  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.closePopover();
    }
  };

  constructor(
    private readonly app: App,
    private readonly runs: RunRegistry,
    private readonly statusEl?: HTMLElement,
    private readonly pairConflicts?: PairConflictController,
  ) {
    this.unsubscribe = runs.subscribe((signal) => {
      if (signal.type === "indicator") {
        this.renderStatus(signal.indicator);
      }
    });
    if (statusEl) {
      statusEl.addClass("supernote-run-status-item");
      statusEl.setAttr("role", "button");
      statusEl.setAttr("tabindex", "0");
      statusEl.addEventListener("click", () => this.togglePopover());
      statusEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.togglePopover();
        }
      });
    }
    this.renderStatus(this.runs.indicator());
  }

  open(): void {
    this.runs.acknowledgeFailures();
    new RunConsoleModal(this.app, this.runs, this.pairConflicts).open();
  }

  dispose(): void {
    this.unsubscribe();
    this.closePopover();
    if (this.successTimer !== null) {
      window.clearTimeout(this.successTimer);
    }
  }

  private togglePopover(): void {
    if (this.popover) {
      this.closePopover();
      return;
    }
    if (!this.statusEl || !Platform.isDesktopApp) {
      this.open();
      return;
    }
    const rect = this.statusEl.getBoundingClientRect();
    this.runs.acknowledgeFailures();
    const popover = document.body.createDiv({
      cls: "supernote-run-popover",
      attr: { role: "dialog", "aria-label": "Supernote activity" },
    });
    popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
    const heading = popover.createDiv({
      cls: "supernote-run-popover-heading",
      text: "Supernote activity",
    });
    heading.setAttr("role", "heading");
    const body = popover.createDiv();
    this.popover = popover;
    this.popoverView = new RunListView(body, this.runs, this.pairConflicts);
    document.addEventListener("mousedown", this.outsideClick);
    document.addEventListener("keydown", this.escape);
  }

  private closePopover(): void {
    document.removeEventListener("mousedown", this.outsideClick);
    document.removeEventListener("keydown", this.escape);
    this.popoverView?.dispose();
    this.popoverView = null;
    this.popover?.remove();
    this.popover = null;
  }

  private renderStatus(indicator: RunIndicator): void {
    if (!this.statusEl) {
      return;
    }
    const signature = [
      indicator.state,
      indicator.activeCount,
      indicator.activeLabel ?? "",
      indicator.attentionCount ?? 0,
      indicator.attentionLabel ?? "",
    ].join(":");
    if (signature === this.renderedIndicator) {
      if (indicator.state === "success" && this.successTimer === null) {
        this.scheduleSuccessExpiry();
      }
      return;
    }
    this.renderedIndicator = signature;
    if (this.successTimer !== null) {
      window.clearTimeout(this.successTimer);
      this.successTimer = null;
    }
    this.statusEl.show();
    this.statusEl.empty();
    this.statusEl.setAttr("aria-label", this.indicatorLabel(indicator));
    const brandIcon = this.statusEl.createSpan({
      cls: "supernote-run-brand",
    });
    setIcon(brandIcon, "pen-line");
    if (indicator.state !== "idle") {
      const stateIcon = this.statusEl.createSpan({
        cls: "supernote-run-state",
      });
      setIcon(
        stateIcon,
        indicator.state === "running"
          ? "loader-circle"
          : indicator.state === "failure"
            ? "circle-alert"
            : "circle-check",
      );
    }
    this.statusEl.toggleClass("is-running", indicator.state === "running");
    this.statusEl.toggleClass("is-failure", indicator.state === "failure");
    this.statusEl.toggleClass("is-success", indicator.state === "success");
    if (indicator.activeCount > 1) {
      this.statusEl.createSpan({
        cls: "supernote-run-count",
        text: String(indicator.activeCount),
      });
    } else if (indicator.state === "running" && indicator.activeLabel) {
      this.statusEl.createSpan({
        cls: "supernote-run-label",
        text: indicator.activeLabel,
      });
    } else if (indicator.attentionCount && indicator.attentionLabel) {
      this.statusEl.createSpan({
        cls: "supernote-run-label",
        text: indicator.attentionLabel,
      });
    }
    if (indicator.state === "success") {
      this.scheduleSuccessExpiry();
    }
  }

  private scheduleSuccessExpiry(): void {
    const delay = this.runs.nextIndicatorChangeIn();
    this.successTimer = window.setTimeout(
      () => {
        this.successTimer = null;
        this.renderStatus(this.runs.indicator());
      },
      (delay ?? 0) + 10,
    );
  }

  private indicatorLabel(indicator: RunIndicator): string {
    if (indicator.state === "running") {
      return (
        indicator.activeLabel ??
        `${indicator.activeCount} Supernote activit${indicator.activeCount === 1 ? "y" : "ies"} running`
      );
    }
    if (indicator.state === "failure") {
      return indicator.attentionLabel ?? "A Supernote run failed";
    }
    return indicator.state === "success"
      ? "Supernote activity completed"
      : "Supernote is idle";
  }
}
