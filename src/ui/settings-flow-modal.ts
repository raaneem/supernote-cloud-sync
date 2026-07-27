import { Modal, Platform, Setting, type App } from "obsidian";

import { SettingsFlowController } from "../settings-ux/flow-navigation";

export interface SettingsFlowView {
  id: string;
  title: string;
  render(host: SettingsFlowModal, container: HTMLElement): void;
}

class ConfirmActionModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly actionLabel: string,
    private readonly action: () => void | Promise<void>,
    private readonly cancelLabel: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", {
      text: this.message,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(this.cancelLabel).onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText(this.actionLabel)
          .onClick(async () => {
            button.setDisabled(true);
            await this.action();
            this.close();
          }),
      );
  }
}

export class SettingsFlowModal extends Modal {
  private readonly navigation: SettingsFlowController;
  private readonly views: SettingsFlowView[];
  private forceClose = false;

  constructor(
    app: App,
    initialView: SettingsFlowView,
    private readonly afterClose?: () => void,
  ) {
    super(app);
    this.views = [initialView];
    this.navigation = new SettingsFlowController(initialView.id);
  }

  get depth(): number {
    return this.navigation.depth;
  }

  onOpen(): void {
    this.modalEl.addClass("supernote-settings-flow");
    if (Platform.isMobile) {
      this.modalEl.addClass("is-mobile");
    }
    this.renderCurrent();
  }

  onClose(): void {
    this.contentEl.empty();
    this.afterClose?.();
  }

  override close(): void {
    if (this.forceClose) {
      super.close();
      return;
    }
    this.leave();
  }

  push(view: SettingsFlowView): void {
    this.views.push(view);
    this.navigation.push(view.id);
    this.renderCurrent();
  }

  setDirty(dirty: boolean): void {
    this.navigation.setDirty(dirty);
  }

  renderCurrent(): void {
    const view = this.views.at(-1)!;
    this.setTitle(view.title);
    this.contentEl.empty();
    this.contentEl.addClass("supernote-settings-flow-content");
    if (this.navigation.depth > 1) {
      new Setting(this.contentEl).addButton((button) =>
        button
          .setIcon("arrow-left")
          .setButtonText("Back to setup")
          .onClick(() => this.leave()),
      );
    }
    const body = this.contentEl.createDiv({
      cls: "supernote-settings-flow-body",
    });
    view.render(this, body);
  }

  leave(): void {
    const result = this.navigation.requestLeave();
    if (result === "confirm-discard") {
      this.confirm(
        "Discard changes?",
        "Your unsaved changes will be lost.",
        "Discard changes",
        () => {
          this.applyLeave(this.navigation.discardAndLeave());
        },
        "Continue editing",
      );
      return;
    }
    this.applyLeave(result);
  }

  saved(): void {
    this.applyLeave(this.navigation.afterSave());
  }

  confirm(
    title: string,
    message: string,
    actionLabel: string,
    action: () => void | Promise<void>,
    cancelLabel = "Cancel",
  ): void {
    new ConfirmActionModal(
      this.app,
      title,
      message,
      actionLabel,
      action,
      cancelLabel,
    ).open();
  }

  private applyLeave(result: "back" | "close"): void {
    if (result === "back") {
      this.views.pop();
      this.renderCurrent();
      return;
    }
    this.forceClose = true;
    super.close();
  }
}
