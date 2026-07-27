import { App, Platform, PluginSettingTab, Setting } from "obsidian";

import type SupernoteSyncPlugin from "./main";
import { setupReadiness } from "./onboarding/setup";
import { sortAutomationList } from "./settings-ux/automation-draft";
import type { WatchHookDefinition } from "./sync/watch-hooks";
import { automationEditorView } from "./ui/automation-editor";
import {
  SettingsFlowModal,
  type SettingsFlowView,
} from "./ui/settings-flow-modal";
import { setupFlowView } from "./ui/setup-flow";
import { transcriptionEditorView } from "./ui/transcription-editor";

const actionLabel = (action: WatchHookDefinition["action"]): string =>
  action === "claude"
    ? "Claude Code"
    : action === "codex"
      ? "Codex CLI"
      : "Custom command";

const syncOutcomeLabel = (
  outcome: SupernoteSyncPlugin["lastSyncOutcome"],
): string =>
  outcome === "succeeded"
    ? "Succeeded"
    : outcome === "failed"
      ? "Failed"
      : "Never run";

export class SupernoteSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly syncPlugin: SupernoteSyncPlugin,
  ) {
    super(app, syncPlugin);
  }

  private open(view: SettingsFlowView): void {
    new SettingsFlowModal(this.app, view, () => this.display()).open();
  }

  private renderSetup(container: HTMLElement): void {
    new Setting(container).setName("Setup").setHeading();
    const readiness = setupReadiness(this.syncPlugin.setupPrerequisites());
    new Setting(container)
      .setName(readiness.ready ? "Ready" : `${readiness.missingCount} missing`)
      .setDesc(
        readiness.firstBlocker?.detail ??
          "Account, Mirror, Paired folder, and Transcription can be inspected or changed.",
      )
      .addButton((button) =>
        button
          .setButtonText("Open setup")
          .setCta()
          .onClick(() => this.open(setupFlowView(this.syncPlugin))),
      );
  }

  private renderSync(container: HTMLElement): void {
    new Setting(container).setName("Sync").setHeading();
    new Setting(container)
      .setName("Last sync")
      .setDesc(
        this.syncPlugin.lastSyncAt
          ? `${syncOutcomeLabel(this.syncPlugin.lastSyncOutcome)} — ${new Date(
              this.syncPlugin.lastSyncAt,
            ).toLocaleString()}`
          : syncOutcomeLabel(this.syncPlugin.lastSyncOutcome),
      );
    new Setting(container)
      .setName("Automatic sync")
      .setDesc("Minutes between syncs. Use 0 to turn it off.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text
          .setValue(String(this.syncPlugin.autoSyncMinutes))
          .onChange(async (value) => {
            const interval = Number(value);
            if (Number.isFinite(interval) && interval >= 0) {
              await this.syncPlugin.updateInstanceExecutionSettings({
                autoSyncMinutes: interval,
              });
            }
          });
      });
    new Setting(container)
      .setName("Run Automations on this device")
      .setDesc("Not synced — applies after automatic and manual sync here.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.syncPlugin.runAutomationsOnThisDevice)
          .onChange((value) =>
            this.syncPlugin.updateInstanceExecutionSettings({
              runAutomationsOnThisDevice: value,
            }),
          ),
      );

    const browseReason = this.syncPlugin.isLoggedIn
      ? null
      : "Sign in to Supernote Cloud first.";
    new Setting(container)
      .setName("Mirrored folders")
      .setDesc(this.syncPlugin.mirroredFoldersDescription)
      .addButton((button) => {
        button
          .setButtonText("Browse cloud")
          .setDisabled(Boolean(browseReason))
          .onClick(() =>
            this.syncPlugin.openCloudBrowser(() => this.display()),
          );
        if (browseReason) {
          button.setTooltip(browseReason);
        }
      });
    const syncReason = this.syncPlugin.syncBlockingReason;
    new Setting(container)
      .setName("Sync now")
      .setDesc(
        syncReason ??
          "Download Mirror changes and synchronize the optional Paired folder.",
      )
      .addButton((button) => {
        button
          .setCta()
          .setButtonText("Sync now")
          .setDisabled(Boolean(syncReason))
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Syncing…");
            await this.syncPlugin.syncMirroredNotebooks();
            this.display();
          });
        if (syncReason) {
          button.setTooltip(syncReason);
        }
      });
  }

  private renderAutomations(container: HTMLElement): void {
    new Setting(container).setName("Automations").setHeading();
    const mirroredNotes = this.syncPlugin.getMirroredNotePaths();
    const automations = sortAutomationList(
      this.syncPlugin.settings.watchHooks,
      (automation) =>
        this.syncPlugin.getAutomationBlockingReason(automation, mirroredNotes),
    );
    if (automations.length === 0) {
      new Setting(container)
        .setName("No Automations")
        .setDesc("Create an Automation to deliver changed notebook pages.");
    }
    for (const item of automations) {
      const { automation, blockingReason } = item;
      new Setting(container)
        .setName(automation.name || "Untitled Automation")
        .setDesc(
          [
            automation.sourceNote || "No source notebook",
            actionLabel(automation.action),
            blockingReason ?? "Ready",
          ].join(" · "),
        )
        .addButton((button) => {
          button
            .setButtonText("Run now")
            .setDisabled(Boolean(blockingReason))
            .onClick(async () => {
              button.setDisabled(true).setButtonText("Running…");
              await this.syncPlugin.runWatchHookManually(automation.id);
              this.display();
            });
          if (blockingReason) {
            button.setTooltip(blockingReason);
          }
        })
        .addButton((button) =>
          button
            .setButtonText("Edit")
            .onClick(() =>
              this.open(automationEditorView(this.syncPlugin, automation)),
            ),
        );
    }
    new Setting(container).addButton((button) =>
      button
        .setButtonText("Add Automation")
        .onClick(() => this.open(automationEditorView(this.syncPlugin))),
    );
  }

  private renderTranscription(container: HTMLElement): void {
    new Setting(container).setName("Transcription").setHeading();
    const row = this.syncPlugin
      .setupPrerequisites()
      .find((prerequisite) => prerequisite.id === "transcription");
    const configuredEngine = this.syncPlugin.settings.transcriptionEngine;
    const engine = Platform.isDesktopApp ? configuredEngine : "api";
    const model =
      engine === "api"
        ? this.syncPlugin.settings.transcriptionApiModel
        : engine === "claude"
          ? this.syncPlugin.settings.transcriptionClaudeModel
          : engine === "codex"
            ? this.syncPlugin.settings.transcriptionCodexModel
            : "";
    const label =
      engine === "api"
        ? "OpenAI-compatible API"
        : engine === "claude"
          ? "Claude Code"
          : engine === "codex"
            ? "Codex CLI"
            : "Custom command";
    new Setting(container)
      .setName(label)
      .setDesc(
        [
          model ? `Model: ${model}` : null,
          row?.detail ?? "Configure Transcription.",
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .addButton((button) =>
        button
          .setButtonText("Configure")
          .onClick(() => this.open(transcriptionEditorView(this.syncPlugin))),
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderSetup(containerEl);
    this.renderSync(containerEl);
    this.renderAutomations(containerEl);
    this.renderTranscription(containerEl);
  }
}
