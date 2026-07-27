import { Notice, Setting } from "obsidian";

import type SupernoteSyncPlugin from "../main";
import type {
  SetupPrerequisite,
  SetupPrerequisiteId,
} from "../onboarding/setup";
import { SupernoteVerificationModal } from "./verification-modal";
import { VaultFolderPickerModal } from "./vault-folder-picker-modal";
import { transcriptionEditorView } from "./transcription-editor";
import { confirmPairLocalRemoval } from "./send-to-supernote-modal";
import type {
  SettingsFlowModal,
  SettingsFlowView,
} from "./settings-flow-modal";

const prerequisite = (
  plugin: SupernoteSyncPlugin,
  id: SetupPrerequisiteId,
): SetupPrerequisite =>
  plugin.setupPrerequisites().find((candidate) => candidate.id === id) ?? {
    id,
    state: "missing",
    detail: "This setup item needs attention.",
  };

const chooseMirrorFolder = (
  plugin: SupernoteSyncPlugin,
  host: SettingsFlowModal,
  move: boolean,
): void => {
  new VaultFolderPickerModal(
    plugin.app,
    move ? plugin.settings.targetFolder : "",
    (path) => {
      if (!path) {
        new Notice("Choose a folder below the vault root.");
        return;
      }
      if (!move) {
        void plugin.chooseMirrorFolder(path).then((selected) => {
          if (selected) {
            host.renderCurrent();
          }
        });
        return;
      }
      host.confirm(
        "Move Mirror?",
        `Move the Mirror from “${plugin.settings.targetFolder}” to “${path}”? The destination must be empty.`,
        "Move Mirror",
        async () => {
          if (await plugin.moveMirror(path)) {
            host.renderCurrent();
          }
        },
      );
    },
    {
      includeRoot: false,
      placeholder: move
        ? "Choose an empty destination for the Mirror"
        : "Choose the Supernote Mirror folder",
    },
  ).open();
};

export const setupFlowView = (
  plugin: SupernoteSyncPlugin,
): SettingsFlowView => ({
  id: "setup",
  title: "Supernote setup",
  render: (host, container) => {
    let email = "";
    let password = "";
    let passwordInput: HTMLInputElement | null = null;
    new Setting(container)
      .setName("Account")
      .setDesc(prerequisite(plugin, "account").detail)
      .addText((text) => {
        text.inputEl.hidden = plugin.isLoggedIn;
        text.setPlaceholder("Email").onChange((value) => {
          email = value;
        });
      })
      .addText((text) => {
        text.inputEl.hidden = plugin.isLoggedIn;
        text.inputEl.type = "password";
        passwordInput = text.inputEl;
        text.setPlaceholder("Password").onChange((value) => {
          password = value;
        });
      })
      .addButton((button) => {
        if (plugin.isLoggedIn) {
          button.setButtonText("Log out").onClick(async () => {
            await plugin.logout();
            host.renderCurrent();
          });
          return;
        }
        button
          .setCta()
          .setButtonText("Sign in")
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Signing in…");
            try {
              const result = await plugin.login(email, password);
              password = "";
              if (passwordInput) {
                passwordInput.value = "";
              }
              if (result?.status === "verification-required") {
                new SupernoteVerificationModal(
                  plugin.app,
                  plugin,
                  result.challenge,
                  () => host.renderCurrent(),
                ).open();
              } else {
                host.renderCurrent();
              }
            } catch {
              button.setDisabled(false).setButtonText("Sign in");
            }
          });
      });

    const mirror = prerequisite(plugin, "mirror");
    const mirrorBusyReason =
      plugin.isSyncRunning ||
      plugin.isAutomationRunning ||
      plugin.isMirrorMoveRunning
        ? "Wait for the current sync, Automation run, or Mirror move to finish."
        : null;
    new Setting(container)
      .setName("Mirror")
      .setDesc(mirrorBusyReason ?? mirror.detail)
      .addButton((button) =>
        button
          .setButtonText(
            mirror.state === "satisfied" ? "Move Mirror" : "Choose",
          )
          .setDisabled(Boolean(mirrorBusyReason))
          .setTooltip(
            mirrorBusyReason ?? "Choose the vault folder used for the Mirror.",
          )
          .onClick(() =>
            chooseMirrorFolder(plugin, host, mirror.state === "satisfied"),
          ),
      );

    const send = prerequisite(plugin, "send-to-supernote");
    const sendReason = !plugin.isLoggedIn
      ? "Sign in to Supernote Cloud first."
      : plugin.isSyncRunning || plugin.isMirrorMoveRunning
        ? "Wait for the current sync or Mirror move to finish."
        : null;
    const sendSetting = new Setting(container)
      .setName("Paired folder")
      .setDesc(sendReason ?? send.detail);
    if (!plugin.sendToSupernoteEnabled) {
      sendSetting.addButton((button) =>
        button
          .setButtonText("Enable")
          .setDisabled(Boolean(sendReason))
          .setTooltip(sendReason ?? "Choose a Supernote Cloud folder.")
          .onClick(() =>
            plugin.openSendToSupernoteFolderPicker(() => host.renderCurrent()),
          ),
      );
    } else {
      sendSetting
        .addButton((button) =>
          button
            .setButtonText("Change folder")
            .setDisabled(Boolean(sendReason))
            .onClick(() =>
              plugin.openSendToSupernoteFolderPicker(() =>
                host.renderCurrent(),
              ),
            ),
        )
        .addButton((button) =>
          button
            .setWarning()
            .setButtonText("Disable")
            .setDisabled(Boolean(sendReason))
            .onClick(async () => {
              const preview = await plugin.previewDisablePair();
              if (!preview.coveredByMirror && preview.localFiles.length > 0) {
                if (
                  !(await confirmPairLocalRemoval(
                    plugin.app,
                    preview.localFiles.length,
                    "Disable",
                  ))
                ) {
                  return;
                }
                await plugin.disableSendToSupernote(preview);
                host.renderCurrent();
                return;
              }
              host.confirm(
                "Disable Paired folder?",
                "Two-way synchronization will stop. Supernote Cloud will not change.",
                "Disable",
                async () => {
                  await plugin.disableSendToSupernote(preview);
                  host.renderCurrent();
                },
              );
            }),
        );
    }

    new Setting(container)
      .setName("Transcription")
      .setDesc(prerequisite(plugin, "transcription").detail)
      .addButton((button) =>
        button
          .setButtonText("Configure")
          .onClick(() => host.push(transcriptionEditorView(plugin))),
      );

    new Setting(container)
      .setName("Diagnostics")
      .setDesc("Copy a secret-free report for a bug report.")
      .addButton((button) =>
        button
          .setButtonText("Copy diagnostics")
          .onClick(() => void plugin.copyDiagnostics()),
      );
  },
});
