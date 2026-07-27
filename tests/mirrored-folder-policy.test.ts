import { describe, expect, it } from "vitest";

import type { SyncManifest } from "../src/sync/manifest";
import {
  describeMirroredFolders,
  matchesUncoveredEntrySnapshot,
  mirroredVaultFolderPaths,
  selectMirroredFolder,
  syncedVaultFolderPaths,
  uncoveredEntriesAfterRemovingFolder,
} from "../src/ui/mirrored-folder-policy";

const folder = (directoryId: string, remotePath: string) => ({
  directoryId,
  remotePath,
});

const manifest = (): SyncManifest => ({
  version: 1,
  files: {
    journal: {
      remoteId: "journal",
      directoryId: "journal-folder",
      fileName: "Daily.note",
      remotePath: "/Note/Journal/Daily.note",
      md5: "journal-md5",
      updateTime: 1,
      vaultPath: "supernote/Note/Journal/Daily.note",
      syncedAt: "2026-07-27T12:00:00.000Z",
    },
    work: {
      remoteId: "work",
      directoryId: "work-folder",
      fileName: "Plan.note",
      remotePath: "/Note/Work/Plan.note",
      md5: "work-md5",
      updateTime: 1,
      vaultPath: "supernote/Note/Work/Plan.note",
      syncedAt: "2026-07-27T12:00:00.000Z",
    },
    document: {
      remoteId: "document",
      directoryId: "document-folder",
      fileName: "Reference.pdf",
      remotePath: "/Document/Reference.pdf",
      md5: "document-md5",
      updateTime: 1,
      vaultPath: "supernote/Document/Reference.pdf",
      syncedAt: "2026-07-27T12:00:00.000Z",
    },
  },
});

describe("Mirrored folder policy", () => {
  it("replaces redundant child selections when their parent is selected", () => {
    expect(
      selectMirroredFolder(
        [folder("work", "/Note/Work"), folder("document", "/Document")],
        folder("note", "/Note"),
      ),
    ).toEqual([folder("document", "/Document"), folder("note", "/Note")]);

    expect(
      selectMirroredFolder(
        [folder("note", "/Note")],
        folder("work", "/Note/Work"),
      ),
    ).toEqual([folder("note", "/Note")]);
  });

  it("finds only copies uncovered by the remaining Mirrored folders", () => {
    expect(
      uncoveredEntriesAfterRemovingFolder({
        manifest: manifest(),
        removed: folder("note", "/Note"),
        remaining: [folder("work", "/Note/Work")],
        protectedRemoteFolders: ["/Note/Journal"],
      }).map((entry) => entry.remoteId),
    ).toEqual([]);

    expect(
      uncoveredEntriesAfterRemovingFolder({
        manifest: manifest(),
        removed: folder("note", "/Note"),
        remaining: [],
        protectedRemoteFolders: ["/Note/Journal"],
      }).map((entry) => entry.remoteId),
    ).toEqual(["work"]);
  });

  it("validates the exact entries shown in a stop-mirroring confirmation", () => {
    const entries = Object.values(manifest().files).slice(0, 2);

    expect(matchesUncoveredEntrySnapshot(entries, ["journal", "work"])).toBe(
      true,
    );
    expect(matchesUncoveredEntrySnapshot(entries, ["journal"])).toBe(false);
    expect(
      matchesUncoveredEntrySnapshot(entries, ["journal", "document"]),
    ).toBe(false);
  });

  it("maps only explicitly selected roots into vault folder paths", () => {
    expect(
      mirroredVaultFolderPaths("supernote", [
        folder("note", "/Note"),
        folder("screenshots", "/Screen:shot"),
      ]),
    ).toEqual(["supernote/Note", "supernote/Screen_shot"]);
  });

  it("adds only the exact Paired folder to the marked vault roots", () => {
    expect(
      syncedVaultFolderPaths(
        "supernote",
        [folder("note", "/Note")],
        "Document/Obsidian",
      ),
    ).toEqual(["supernote/Note", "supernote/Document/Obsidian"]);
  });

  it("summarizes the selected roots without listing their descendants", () => {
    expect(describeMirroredFolders([])).toBe(
      "No folders mirrored yet. Browse Supernote Cloud to choose one.",
    );
    expect(describeMirroredFolders([folder("note", "/Note")])).toBe(
      "1 folder mirrored: Note.",
    );
  });
});
