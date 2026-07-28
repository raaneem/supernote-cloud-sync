import { describe, expect, it } from "vitest";

import { cloudBrowserFilePresentation } from "../src/ui/cloud-browser-presentation";

describe("Cloud browser file presentation", () => {
  it("describes the action a user gets by opening a file", () => {
    expect(cloudBrowserFilePresentation("not-synced")).toEqual({
      statusLabel: "Cloud only",
      actionLabel: "Download and open",
      trailingIcon: "download",
    });
    expect(cloudBrowserFilePresentation("downloaded")).toEqual({
      statusLabel: "Downloaded",
      actionLabel: "Open",
      trailingIcon: "chevron-right",
    });
    expect(cloudBrowserFilePresentation("update-available")).toEqual({
      statusLabel: "Update available",
      actionLabel: "Update and open",
      trailingIcon: "refresh-cw",
    });
    expect(cloudBrowserFilePresentation("included").statusLabel).toBe(
      "Mirrored",
    );
    expect(cloudBrowserFilePresentation("writable-sync").statusLabel).toBe(
      "Paired",
    );
  });
});
