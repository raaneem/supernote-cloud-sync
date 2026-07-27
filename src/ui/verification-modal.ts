import {
  Modal,
  Notice,
  Setting,
  type App,
  type ButtonComponent,
  type TextComponent,
} from "obsidian";

import type { SupernoteVerificationChallenge } from "../cloud/client";
import {
  isValidVerificationCode,
  normalizeVerificationCode,
} from "../cloud/verification-code";

export interface VerificationHost {
  verifyLogin(
    challenge: SupernoteVerificationChallenge,
    code: string,
  ): Promise<void>;
  resendVerificationCode(
    challenge: SupernoteVerificationChallenge,
  ): Promise<SupernoteVerificationChallenge>;
}

const maskEmail = (email: string): string => {
  const [name = "", domain = ""] = email.split("@");
  const visibleName =
    name.length <= 2
      ? `${name.slice(0, 1)}…`
      : `${name.slice(0, 2)}…${name.slice(-1)}`;
  return domain ? `${visibleName}@${domain}` : email;
};

export class SupernoteVerificationModal extends Modal {
  private challenge: SupernoteVerificationChallenge;
  private code = "";
  private countdown = 120;
  private timer: number | null = null;
  private resendButton: ButtonComponent | null = null;
  private verifyButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly host: VerificationHost,
    challenge: SupernoteVerificationChallenge,
    private readonly onVerified: () => void,
  ) {
    super(app);
    this.challenge = challenge;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.setTitle("Verify your Supernote login");
    this.contentEl.createEl("p", {
      text: `Enter the six-character code sent to ${maskEmail(this.challenge.email)}.`,
    });

    let codeInput: TextComponent | null = null;
    new Setting(this.contentEl).setName("Verification code").addText((text) => {
      codeInput = text;
      text.setPlaceholder("D7A6BS");
      text.inputEl.inputMode = "text";
      text.inputEl.autocomplete = "one-time-code";
      text.inputEl.autocapitalize = "characters";
      text.inputEl.spellcheck = false;
      text.inputEl.maxLength = 6;
      text.onChange((value) => {
        const normalized = normalizeVerificationCode(value);
        this.code = normalized;
        if (normalized !== value) {
          text.setValue(normalized);
        }
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.submit();
        }
      });
    });

    new Setting(this.contentEl)
      .addButton((button) => {
        this.resendButton = button;
        button.onClick(() => void this.resend());
      })
      .addButton((button) => {
        this.verifyButton = button;
        button
          .setCta()
          .setButtonText("Verify and log in")
          .onClick(() => void this.submit());
      });

    this.updateResendButton();
    this.timer = window.setInterval(() => {
      this.countdown = Math.max(0, this.countdown - 1);
      this.updateResendButton();
    }, 1_000);
    window.setTimeout(() => codeInput?.inputEl.focus(), 0);
  }

  onClose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.code = "";
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (!isValidVerificationCode(this.code)) {
      new Notice("Enter the six-character Supernote verification code.");
      return;
    }

    this.verifyButton?.setDisabled(true).setButtonText("Verifying…");
    try {
      await this.host.verifyLogin(this.challenge, this.code);
      this.onVerified();
      this.close();
    } catch {
      this.verifyButton?.setDisabled(false).setButtonText("Verify and log in");
    }
  }

  private async resend(): Promise<void> {
    if (this.countdown > 0) {
      return;
    }

    this.resendButton?.setDisabled(true).setButtonText("Sending…");
    try {
      this.challenge = await this.host.resendVerificationCode(this.challenge);
      this.countdown = 120;
      this.updateResendButton();
      new Notice("A new Supernote verification code was sent.");
    } catch {
      this.countdown = 0;
      this.updateResendButton();
    }
  }

  private updateResendButton(): void {
    if (this.countdown > 0) {
      this.resendButton
        ?.setDisabled(true)
        .setButtonText(`Resend in ${this.countdown}s`);
    } else {
      this.resendButton?.setDisabled(false).setButtonText("Resend code");
    }
  }
}
