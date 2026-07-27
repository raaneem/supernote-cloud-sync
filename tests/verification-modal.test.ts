import type { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupernoteVerificationChallenge } from "../src/cloud/client";
import { SupernoteVerificationModal } from "../src/ui/verification-modal";
import { FakeVerificationHost } from "./verification-host-fake";

const challenge: SupernoteVerificationChallenge = {
  email: "person@example.com",
  timestamp: "123",
  validCodeKey: "verification-key",
};

describe("Supernote verification modal", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("verifies the normalized rendered code through its host", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const host = new FakeVerificationHost();
    const onVerified = vi.fn();
    const modal = new SupernoteVerificationModal(
      {} as App,
      host,
      challenge,
      onVerified,
    );

    modal.open();

    expect(modal.contentEl.textContent).toContain("pe…n@example.com");
    const input = modal.contentEl.querySelector("input");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    input.value = "d7a6bs";
    input.dispatchEvent(new Event("input"));

    const verifyButton = [...modal.contentEl.querySelectorAll("button")].find(
      (button) => button.textContent === "Verify and log in",
    );
    expect(verifyButton).toBeDefined();
    verifyButton?.dispatchEvent(new Event("click"));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.verificationAttempts).toEqual([{ challenge, code: "D7A6BS" }]);
    expect(onVerified).toHaveBeenCalledOnce();
    expect(modal.contentEl.textContent).toBe("");
  });
});
