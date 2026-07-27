import { Notice, Platform, Setting } from "obsidian";

import type SupernoteSyncPlugin from "../main";
import type { TranscriptionEngine } from "../ocr/configuration";
import {
  createTranscriptionDraft,
  materializeTranscriptionDraft,
  transcriptionDraftChanged,
  validateTranscriptionDraft,
  type TranscriptionDraft,
  type TranscriptionDraftErrors,
} from "../settings-ux/transcription-draft";
import { agentSetupDetail, agentTestResultDetail } from "../onboarding/setup";
import {
  addApiModelPicker,
  addClaudeModelPicker,
} from "./transcription-model-picker";
import type {
  SettingsFlowModal,
  SettingsFlowView,
} from "./settings-flow-modal";

const engineLabel = (engine: TranscriptionEngine): string =>
  engine === "api"
    ? "OpenAI-compatible API"
    : engine === "claude"
      ? "Claude Code"
      : engine === "codex"
        ? "Codex CLI"
        : "Custom command";

export const transcriptionEditorView = (
  plugin: SupernoteSyncPlugin,
): SettingsFlowView => {
  const active = plugin.settings;
  let draft = createTranscriptionDraft(active);
  if (!Platform.isDesktopApp && draft.engine !== "api") {
    draft = { ...draft, engine: "api" };
  }
  let errors: TranscriptionDraftErrors = {};
  const candidateDetails: Partial<Record<"claude" | "codex", string>> = {};

  const changed = (host: SettingsFlowModal): void => {
    host.setDirty(transcriptionDraftChanged(draft, active));
  };

  const update = (
    host: SettingsFlowModal,
    patch: Partial<TranscriptionDraft>,
    rerender = false,
  ): void => {
    draft = { ...draft, ...patch };
    changed(host);
    if (rerender) {
      host.renderCurrent();
    }
  };

  const renderAgent = (
    host: SettingsFlowModal,
    container: HTMLElement,
    engine: "claude" | "codex",
  ): void => {
    const path = engine === "claude" ? draft.claudePath : draft.codexPath;
    const label = engine === "claude" ? "Claude Code" : "Codex CLI";
    const setting = new Setting(container)
      .setName(`${label} path`)
      .setDesc(
        candidateDetails[engine] ?? "Blank uses automatic PATH detection.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Automatic PATH detection")
          .setValue(path)
          .onChange((value) => {
            delete candidateDetails[engine];
            setting.setDesc("Blank uses automatic PATH detection.");
            update(
              host,
              engine === "claude"
                ? { claudePath: value }
                : { codexPath: value },
            );
          }),
      );
    const test = async (testLabel: "Detect" | "Test"): Promise<void> => {
      const candidatePath =
        engine === "claude" ? draft.claudePath : draft.codexPath;
      const status = await plugin.testAgentCandidate(engine, candidatePath);
      candidateDetails[engine] =
        testLabel === "Test"
          ? agentTestResultDetail(engine, status)
          : agentSetupDetail(engine, status);
      setting.setDesc(candidateDetails[engine]!);
    };
    setting
      .addButton((button) =>
        button.setButtonText("Detect").onClick(async () => {
          button.setDisabled(true);
          await test("Detect");
          button.setDisabled(false);
        }),
      )
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          await test("Test");
          button.setDisabled(false);
        }),
      );
  };

  return {
    id: "transcription",
    title: "Transcription",
    render: (host, container) => {
      if (errors.save) {
        container.createEl("p", {
          cls: "supernote-sync-error",
          text: errors.save,
        });
      }
      new Setting(container)
        .setName("Engine")
        .setDesc(
          errors.engine ?? `Active after Save: ${engineLabel(draft.engine)}.`,
        )
        .addDropdown((dropdown) => {
          dropdown.addOption("api", "OpenAI-compatible API");
          if (Platform.isDesktopApp) {
            dropdown
              .addOption("claude", "Claude Code")
              .addOption("codex", "Codex CLI")
              .addOption("command", "Custom command");
          }
          dropdown
            .setValue(draft.engine)
            .onChange((value) =>
              update(host, { engine: value as TranscriptionEngine }, true),
            );
        });

      if (draft.engine === "api") {
        new Setting(container)
          .setName("API base URL")
          .setDesc(errors.apiBaseUrl ?? "OpenAI-compatible endpoint.")
          .addText((text) =>
            text
              .setValue(draft.apiBaseUrl)
              .onChange((value) => update(host, { apiBaseUrl: value })),
          );
        const apiKeySetting = new Setting(container)
          .setName("API key")
          .setDesc(
            errors.apiKey ??
              (draft.apiKey.state === "clear"
                ? "The saved key will be cleared."
                : draft.apiKey.currentlySet
                  ? "API key: Set"
                  : "API key: Not set"),
          );
        if (draft.apiKey.state === "replace") {
          apiKeySetting.addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder(
                draft.apiKey.currentlySet
                  ? "Blank keeps the saved key"
                  : "New API key",
              )
              .setValue(draft.apiKey.replacement)
              .onChange((value) => {
                draft = {
                  ...draft,
                  apiKey: {
                    ...draft.apiKey,
                    replacement: value,
                  },
                };
                changed(host);
              });
          });
        }
        apiKeySetting
          .addButton((button) =>
            button
              .setButtonText(draft.apiKey.currentlySet ? "Replace" : "Set")
              .onClick(() => {
                draft = {
                  ...draft,
                  apiKey: {
                    ...draft.apiKey,
                    state: "replace",
                  },
                };
                changed(host);
                host.renderCurrent();
              }),
          )
          .addButton((button) =>
            button.setButtonText("Clear").onClick(() => {
              draft = {
                ...draft,
                apiKey: {
                  ...draft.apiKey,
                  state: "clear",
                  replacement: "",
                },
              };
              changed(host);
              host.renderCurrent();
            }),
          );
        const modelSetting = new Setting(container)
          .setName("Model")
          .setDesc(
            "Choose a vision-capable model or enter a compatible model ID.",
          );
        addApiModelPicker(modelSetting, {
          value: draft.apiModel,
          loadModels: () => plugin.loadApiModels(draft.apiBaseUrl),
          onChange: (value) => update(host, { apiModel: value }),
        });
        new Setting(container)
          .setName("Extra instructions")
          .setDesc("Optional additions to the verbatim transcription prompt.")
          .addTextArea((text) =>
            text
              .setValue(draft.extraInstructions)
              .onChange((value) => update(host, { extraInstructions: value })),
          );
      } else if (draft.engine === "command") {
        new Setting(container)
          .setName("Command")
          .setDesc(
            errors.command ??
              "Use {{folder}}, {{note}}, and {{mode}} placeholders.",
          )
          .addTextArea((text) =>
            text
              .setValue(draft.command)
              .onChange((value) => update(host, { command: value })),
          );
      } else if (draft.engine === "claude") {
        renderAgent(host, container, "claude");
        const modelSetting = new Setting(container)
          .setName("Model")
          .setDesc("Blank uses the Claude Code default.");
        addClaudeModelPicker(modelSetting, {
          value: draft.claudeModel,
          onChange: (value) => update(host, { claudeModel: value }),
        });
        new Setting(container)
          .setName("Maximum budget")
          .setDesc(
            errors.claudeMaxBudgetUsd ?? "Maximum USD spend per export batch.",
          )
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.min = "0";
            text.setValue(String(draft.claudeMaxBudgetUsd)).onChange((value) =>
              update(host, {
                claudeMaxBudgetUsd: Number(value),
              }),
            );
          });
      } else {
        renderAgent(host, container, "codex");
        new Setting(container)
          .setName("Model")
          .setDesc("Blank uses the Codex CLI default.")
          .addText((text) =>
            text
              .setValue(draft.codexModel)
              .onChange((value) => update(host, { codexModel: value })),
          );
      }

      if (draft.engine !== "api") {
        new Setting(container)
          .setName("Timeout")
          .setDesc(
            errors.timeoutMinutes ??
              "Minutes before the whole process batch is stopped.",
          )
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.min = "1";
            text.setValue(String(draft.timeoutMinutes)).onChange((value) =>
              update(host, {
                timeoutMinutes: Number(value),
              }),
            );
          });
      }

      new Setting(container)
        .addButton((button) =>
          button.setButtonText("Cancel").onClick(() => host.leave()),
        )
        .addButton((button) =>
          button
            .setCta()
            .setButtonText("Save")
            .onClick(async () => {
              errors = validateTranscriptionDraft(draft, Platform.isDesktopApp);
              if (Object.keys(errors).length > 0) {
                host.renderCurrent();
                return;
              }
              try {
                await plugin.updateSettings(
                  materializeTranscriptionDraft(draft, plugin.settings),
                );
              } catch (error) {
                errors.save =
                  error instanceof Error
                    ? error.message
                    : "Could not save Transcription settings.";
                host.renderCurrent();
                return;
              }
              host.setDirty(false);
              new Notice("Transcription settings saved.");
              host.saved();
            }),
        );
    },
  };
};
