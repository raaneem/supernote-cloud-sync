import { Modal, Setting, type App } from "obsidian";

import type {
  MarkdownSendFormat,
  SendCollisionDecision,
} from "../sync/send-to-supernote";

class MarkdownSendFormatModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly resolve: (format: MarkdownSendFormat | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Send Markdown to Supernote");
    this.contentEl.createEl("p", {
      text: "Choose the file format to upload.",
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.finish(null)),
      )
      .addButton((button) =>
        button.setButtonText("Plain text").onClick(() => this.finish("text")),
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("PDF")
          .onClick(() => this.finish("pdf")),
      );
  }

  onClose(): void {
    this.finish(null);
    this.contentEl.empty();
  }

  private finish(format: MarkdownSendFormat | null): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(format);
    this.close();
  }
}

class SendCollisionModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly fileName: string,
    private readonly remotePath: string,
    private readonly resolve: (decision: SendCollisionDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("File already exists");
    this.contentEl.createEl("p", {
      text: `${this.remotePath}/${this.fileName} already exists in Supernote Cloud.`,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.finish("cancel")),
      )
      .addButton((button) =>
        button
          .setButtonText("Keep both")
          .onClick(() => this.finish("keep-both")),
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Replace")
          .onClick(() => this.finish("replace")),
      );
  }

  onClose(): void {
    this.finish("cancel");
    this.contentEl.empty();
  }

  private finish(decision: SendCollisionDecision): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(decision);
    this.close();
  }
}

export const chooseMarkdownSendFormat = (
  app: App,
): Promise<MarkdownSendFormat | null> =>
  new Promise((resolve) => new MarkdownSendFormatModal(app, resolve).open());

export const chooseSendCollision = (
  app: App,
  fileName: string,
  remotePath: string,
): Promise<SendCollisionDecision> =>
  new Promise((resolve) => {
    new SendCollisionModal(app, fileName, remotePath, resolve).open();
  });

class PairLocalRemovalModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly fileCount: number,
    private readonly actionLabel: string,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`${this.actionLabel} Paired folder?`);
    this.contentEl.createEl("p", {
      text: `${this.fileCount} local file${
        this.fileCount === 1 ? "" : "s"
      } are not covered by a Mirrored folder and will move to Obsidian Trash. Supernote Cloud will not change.`,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.finish(false)),
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText(this.actionLabel)
          .onClick(() => this.finish(true)),
      );
  }

  onClose(): void {
    this.finish(false);
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

export const confirmPairLocalRemoval = (
  app: App,
  fileCount: number,
  actionLabel: "Disable" | "Change",
): Promise<boolean> =>
  new Promise((resolve) => {
    new PairLocalRemovalModal(app, fileCount, actionLabel, resolve).open();
  });
