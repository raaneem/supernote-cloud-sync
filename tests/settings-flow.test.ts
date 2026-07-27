import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SettingsFlowController } from "../src/settings-ux/flow-navigation";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("Settings flow navigation", () => {
  it("returns a delegated editor to Setup after Save", () => {
    const flow = new SettingsFlowController("setup");
    flow.push("transcription");
    flow.setDirty(true);

    expect(flow.afterSave()).toBe("back");
    expect(flow.current).toBe("setup");
    expect(flow.dirty).toBe(false);
  });

  it("closes a directly opened editor after Save", () => {
    const flow = new SettingsFlowController("transcription");
    flow.setDirty(true);

    expect(flow.afterSave()).toBe("close");
    expect(flow.dirty).toBe(false);
  });

  it("guards every dirty leave request until discard is confirmed", () => {
    const flow = new SettingsFlowController("setup");
    flow.push("automation");
    flow.setDirty(true);

    expect(flow.requestLeave()).toBe("confirm-discard");
    expect(flow.current).toBe("automation");

    expect(flow.discardAndLeave()).toBe("back");
    expect(flow.current).toBe("setup");
    expect(flow.dirty).toBe(false);
  });

  it("keeps the mobile title and close button below the top safe area", async () => {
    const styles = await source("../styles.css");

    expect(styles).toMatch(
      /\.supernote-settings-flow\.is-mobile\s*\{[^}]*padding-top:\s*max\(\s*var\(--size-4-4\),\s*calc\(\s*var\(--safe-area-inset-top\)\s*\+\s*var\(--size-4-2\)\s*\)\s*\)/,
    );
    expect(styles).toMatch(
      /\.supernote-settings-flow\.is-mobile\s+\.modal-close-button\s*\{[^}]*top:\s*calc\(\s*var\(--safe-area-inset-top\)\s*\+\s*var\(--size-4-2\)\s*\)/,
    );
  });
});
