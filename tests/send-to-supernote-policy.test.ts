import { describe, expect, it } from "vitest";

import {
  isInsideSendToSupernoteFolder,
  resolveSendToSupernoteEnabled,
} from "../src/sync/send-to-supernote-policy";

describe("Send to Supernote policy", () => {
  it("migrates fresh, existing-enabled, and existing-disabled data", () => {
    expect(resolveSendToSupernoteEnabled({})).toBe(false);
    expect(
      resolveSendToSupernoteEnabled({
        settings: { pushFolder: "Document/Obsidian" },
      }),
    ).toBe(true);
    expect(
      resolveSendToSupernoteEnabled({
        writableSubtreeConfigured: true,
      }),
    ).toBe(true);
    expect(
      resolveSendToSupernoteEnabled({
        sendToSupernoteEnabled: false,
        writableSubtreeConfigured: true,
      }),
    ).toBe(false);
  });

  it("still excludes the remembered Paired folder from one-way Mirror downloads", () => {
    expect(
      isInsideSendToSupernoteFolder(
        "/Document/Obsidian/Export.pdf",
        "Document/Obsidian",
      ),
    ).toBe(true);
    expect(
      isInsideSendToSupernoteFolder("/Note/Journal.note", "Document/Obsidian"),
    ).toBe(false);
  });
});
