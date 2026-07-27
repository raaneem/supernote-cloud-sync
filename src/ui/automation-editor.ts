import { Notice, Setting } from "obsidian";

import type SupernoteSyncPlugin from "../main";
import {
  automationDraftErrors,
  type AutomationDraftErrors,
} from "../settings-ux/automation-draft";
import type { WatchHookDefinition } from "../sync/watch-hooks";
import { addClaudeModelPicker } from "./transcription-model-picker";
import type {
  SettingsFlowModal,
  SettingsFlowView,
} from "./settings-flow-modal";

const changed = (
  draft: WatchHookDefinition,
  original: WatchHookDefinition,
): boolean => JSON.stringify(draft) !== JSON.stringify(original);

export const automationEditorView = (
  plugin: SupernoteSyncPlugin,
  automation?: WatchHookDefinition,
): SettingsFlowView => {
  const isNew = automation === undefined;
  const original = automation ?? plugin.createWatchHookDraft();
  let draft = { ...original };
  let errors: AutomationDraftErrors = {};

  const update = (
    host: SettingsFlowModal,
    patch: Partial<WatchHookDefinition>,
    rerender = false,
  ): void => {
    draft = { ...draft, ...patch };
    host.setDirty(changed(draft, original));
    if (rerender) {
      host.renderCurrent();
    }
  };

  return {
    id: `automation:${draft.id}`,
    title: isNew ? "Add Automation" : "Edit Automation",
    render: (host, container) => {
      const configurationBlock = plugin.automationConfigurationBlockingReason;
      if (configurationBlock) {
        container.createEl("p", {
          cls: "supernote-sync-error",
          text: configurationBlock,
        });
      }
      new Setting(container).setName("Basics").setHeading();
      new Setting(container)
        .setName("Name")
        .setDesc(errors.name ?? "A unique name for this Automation.")
        .addText((text) =>
          text
            .setPlaceholder("Daily notes")
            .setValue(draft.name)
            .onChange((value) => update(host, { name: value })),
        );

      const mirroredNotes = plugin.getMirroredNotePaths();
      new Setting(container)
        .setName("Source notebook")
        .setDesc(errors.sourceNote ?? "Choose a mirrored Supernote notebook.")
        .addDropdown((dropdown) => {
          if (draft.sourceNote && !mirroredNotes.includes(draft.sourceNote)) {
            dropdown.addOption(
              draft.sourceNote,
              `${draft.sourceNote} (missing)`,
            );
          }
          if (mirroredNotes.length === 0 && !draft.sourceNote) {
            dropdown.addOption("", "No mirrored notebooks");
          }
          for (const path of mirroredNotes) {
            dropdown.addOption(path, path);
          }
          dropdown
            .setValue(draft.sourceNote)
            .setDisabled(mirroredNotes.length === 0)
            .onChange((value) => update(host, { sourceNote: value }));
        });

      new Setting(container).setName("Batch").setHeading();
      if (draft.action === "command") {
        new Setting(container)
          .setName("Format")
          .setDesc(
            "Images contain page PNGs. Markdown uses existing device recognition.",
          )
          .addDropdown((dropdown) =>
            dropdown
              .addOption("images", "Images")
              .addOption("markdown", "Markdown")
              .setValue(draft.format)
              .onChange((value) =>
                update(host, {
                  format: value === "markdown" ? "markdown" : "images",
                }),
              ),
          );
      } else {
        new Setting(container)
          .setName("Page images")
          .setDesc("Agent actions receive native-resolution page images.");
      }

      new Setting(container).setName("Action").setHeading();
      new Setting(container)
        .setName("Action type")
        .setDesc(errors.action ?? "Choose what receives each batch.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("command", "Custom command")
            .addOption("claude", "Claude Code")
            .addOption("codex", "Codex CLI")
            .setValue(draft.action)
            .onChange((value) =>
              update(
                host,
                {
                  action:
                    value === "claude" || value === "codex" ? value : "command",
                },
                true,
              ),
            ),
        );

      if (draft.action === "command") {
        new Setting(container)
          .setName("Command")
          .setDesc(
            errors.action ??
              "Use {{folder}} for the batch and {{note}} for the source path.",
          )
          .addTextArea((text) =>
            text
              .setPlaceholder('/absolute/path/to/tool "{{folder}}" "{{note}}"')
              .setValue(draft.command)
              .onChange((value) => update(host, { command: value })),
          );
      } else {
        new Setting(container)
          .setName("Prompt")
          .setDesc(
            errors.action ??
              "Instructions sent with the exported notebook pages.",
          )
          .addTextArea((text) =>
            text
              .setPlaceholder("/supernote-dispatch")
              .setValue(draft.prompt)
              .onChange((value) => update(host, { prompt: value })),
          );
        if (draft.action === "claude") {
          const modelSetting = new Setting(container)
            .setName("Model")
            .setDesc("Blank uses the Claude Code default.");
          addClaudeModelPicker(modelSetting, {
            value: draft.model,
            onChange: (value) => update(host, { model: value }),
          });
          new Setting(container)
            .setName("Allowed tools")
            .setDesc(
              "Comma-separated tools available without an interactive prompt.",
            )
            .addText((text) =>
              text
                .setValue(draft.claudeAllowedTools)
                .onChange((value) =>
                  update(host, { claudeAllowedTools: value }),
                ),
            );
        } else {
          new Setting(container)
            .setName("Model")
            .setDesc("Blank uses the Codex CLI default.")
            .addText((text) =>
              text
                .setPlaceholder("Default")
                .setValue(draft.model)
                .onChange((value) => update(host, { model: value })),
            );
          new Setting(container)
            .setName("Sandbox")
            .setDesc(
              draft.codexSandbox === "danger-full-access"
                ? "Warning: full access disables process and filesystem isolation."
                : "Controls the files and processes Codex may access.",
            )
            .addDropdown((dropdown) =>
              dropdown
                .addOption("workspace-write", "Workspace write")
                .addOption("read-only", "Read only")
                .addOption("danger-full-access", "Danger: full access")
                .setValue(draft.codexSandbox)
                .onChange((value) =>
                  update(host, {
                    codexSandbox:
                      value === "read-only" || value === "danger-full-access"
                        ? value
                        : "workspace-write",
                  }),
                ),
            );
        }
      }

      new Setting(container).setName("Retention").setHeading();
      new Setting(container)
        .setName("Keep folder")
        .setDesc(
          errors.keepFolder ??
            "Optional vault folder for saved batches. Blank removes successful temporary batches.",
        )
        .addText((text) =>
          text
            .setPlaceholder("Automation batches")
            .setValue(draft.keepFolder)
            .onChange((value) => update(host, { keepFolder: value })),
        );

      const actions = new Setting(container);
      if (!isNew) {
        actions.addButton((button) =>
          button
            .setWarning()
            .setButtonText("Delete Automation")
            .setDisabled(Boolean(configurationBlock))
            .setTooltip(
              configurationBlock ?? "Delete only this Automation definition.",
            )
            .onClick(() =>
              host.confirm(
                "Delete Automation?",
                `Delete “${original.name}”? Kept batches and notebook content will remain.`,
                "Delete Automation",
                async () => {
                  const currentBlock =
                    plugin.automationConfigurationBlockingReason;
                  if (currentBlock) {
                    errors.action = currentBlock;
                    host.renderCurrent();
                    return;
                  }
                  try {
                    await plugin.removeWatchHook(original.id);
                  } catch (error) {
                    errors.action =
                      error instanceof Error
                        ? error.message
                        : "Could not delete this Automation.";
                    host.renderCurrent();
                    return;
                  }
                  host.setDirty(false);
                  new Notice("Automation deleted.");
                  host.saved();
                },
              ),
            ),
        );
      }
      actions
        .addButton((button) =>
          button.setButtonText("Cancel").onClick(() => host.leave()),
        )
        .addButton((button) =>
          button
            .setCta()
            .setButtonText("Save")
            .setDisabled(Boolean(configurationBlock))
            .setTooltip(configurationBlock ?? "Save this Automation.")
            .onClick(async () => {
              errors = automationDraftErrors(
                draft,
                plugin.settings.watchHooks,
                plugin.settings.targetFolder,
              );
              if (Object.keys(errors).length > 0) {
                host.renderCurrent();
                return;
              }
              const currentBlock = plugin.automationConfigurationBlockingReason;
              if (currentBlock) {
                errors.action = currentBlock;
                host.renderCurrent();
                return;
              }
              try {
                await plugin.saveWatchHookDraft(draft);
              } catch (error) {
                errors.action =
                  error instanceof Error
                    ? error.message
                    : "Could not save this Automation.";
                host.renderCurrent();
                return;
              }
              host.setDirty(false);
              new Notice("Automation saved.");
              host.saved();
            }),
        );
    },
  };
};
