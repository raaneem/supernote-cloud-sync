import { describe, expect, it } from "vitest";

import type { CloudDirectory, CloudFile } from "../src/cloud/types";
import type { SyncManifest, SyncManifestFile } from "../src/sync/manifest";
import { CloudBrowserStatusIndex } from "../src/ui/cloud-browser-status";

const directory = (id: string, fileName: string): CloudDirectory => ({
  id,
  directoryId: "parent",
  fileName,
  isFolder: true,
  md5: "",
  size: 0,
  createTime: 1,
  updateTime: 1,
});

const file = (id: string, fileName: string, md5: string): CloudFile => ({
  id,
  directoryId: "parent",
  fileName,
  isFolder: false,
  md5,
  size: 10,
  createTime: 1,
  updateTime: 1,
});

const manifestEntry = (
  remoteId: string,
  remotePath: string,
  md5: string,
): SyncManifestFile => ({
  remoteId,
  directoryId: "parent",
  fileName: remotePath.split("/").at(-1)!,
  remotePath,
  md5,
  updateTime: 1,
  vaultPath: `supernote/${remotePath.replace(/^\/+/, "")}`,
  syncedAt: "2026-07-24T12:00:00.000Z",
});

const createIndex = (
  files: SyncManifest["files"] = {},
): CloudBrowserStatusIndex =>
  new CloudBrowserStatusIndex({
    mirroredFolders: [
      {
        directoryId: "journal",
        remotePath: "/Note/Journal",
      },
    ],
    pushFolder: "Document/Obsidian",
    manifest: {
      version: 1,
      files,
    },
  });

describe("CloudBrowserStatusIndex", () => {
  it("distinguishes configured mirror roots from their included descendants", () => {
    const index = createIndex();

    expect(
      index.statusFor(directory("journal", "Journal"), "/Note/Journal"),
    ).toBe("mirrored");
    expect(
      index.statusFor(directory("year-2026", "2026"), "/Note/Journal/2026"),
    ).toBe("included");
    expect(index.statusFor(directory("note", "Note"), "/Note")).toBe(
      "not-synced",
    );
  });

  it("distinguishes a downloaded file from a file covered by a Mirrored folder", () => {
    const downloaded = manifestEntry("note-1", "/Note/Loose.note", "ABC123");
    const mirrored = manifestEntry(
      "journal-note",
      "/Note/Journal/Entry.note",
      "same-md5",
    );
    const index = createIndex({
      [downloaded.remoteId]: downloaded,
      [mirrored.remoteId]: mirrored,
    });

    expect(
      index.statusFor(
        file("note-1", "Loose.note", "abc123"),
        "/Note/Loose.note",
      ),
    ).toBe("downloaded");
    expect(
      index.statusFor(
        file("journal-note", "Entry.note", "same-md5"),
        "/Note/Journal/Entry.note",
      ),
    ).toBe("mirrored");
    expect(index.includedVia("/Note/Journal/2026")).toBe("Journal");
  });

  it("detects an available update by remote id or stable cloud path", () => {
    const entry = manifestEntry(
      "old-id",
      "/Note/Journal/Entry.note",
      "old-md5",
    );
    const index = createIndex({ [entry.remoteId]: entry });

    expect(
      index.statusFor(
        file("old-id", "Entry.note", "new-md5"),
        "/Note/Journal/Entry.note",
      ),
    ).toBe("update-available");
    expect(
      index.statusFor(
        file("replacement-id", "Entry.note", "new-md5"),
        "/Note/Journal/Entry.note",
      ),
    ).toBe("update-available");
  });

  it("marks scheduled but not-yet-downloaded files as included", () => {
    const index = createIndex();

    expect(
      index.statusFor(
        file("new-note", "New.note", "new-md5"),
        "/Note/Journal/New.note",
      ),
    ).toBe("included");
  });

  it("gives the Paired folder precedence over mirror and update state", () => {
    const entry = manifestEntry(
      "draft",
      "/Document/Obsidian/Drafts/draft.pdf",
      "old-md5",
    );
    const index = createIndex({ [entry.remoteId]: entry });

    expect(
      index.statusFor(directory("obsidian", "Obsidian"), "/Document/Obsidian"),
    ).toBe("writable-sync");
    expect(
      index.statusFor(
        file("draft", "draft.pdf", "new-md5"),
        "\\Document\\Obsidian\\Drafts\\draft.pdf",
      ),
    ).toBe("writable-sync");
  });
});
