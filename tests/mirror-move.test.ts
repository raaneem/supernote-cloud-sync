import { describe, expect, it, vi } from "vitest";

import {
  moveMirrorTransaction,
  rewriteMirrorReferences,
} from "../src/sync/mirror-move";
import type { SyncManifest } from "../src/sync/manifest";
import type { WatchHookDefinition } from "../src/sync/watch-hooks";

const manifest = (): SyncManifest => ({
  version: 1,
  files: {
    journal: {
      remoteId: "journal",
      directoryId: "notes",
      fileName: "Journal.note",
      remotePath: "/Note/Journal.note",
      md5: "abc",
      updateTime: 1,
      vaultPath: "supernote/Note/Journal.note",
      syncedAt: "2026-07-27T00:00:00.000Z",
    },
  },
});

const automation = (): WatchHookDefinition => ({
  id: "daily",
  name: "Daily dispatch",
  sourceNote: "supernote/Note/Journal.note",
  format: "images",
  action: "command",
  command: "dispatch {{folder}}",
  prompt: "",
  model: "",
  claudeAllowedTools: "Read,Write,Glob,Bash",
  codexSandbox: "workspace-write",
  keepFolder: "Automation batches",
});

describe("Mirror move", () => {
  it("rewrites every plugin-owned Mirror reference", () => {
    expect(
      rewriteMirrorReferences({
        source: "supernote",
        destination: "Archive/Supernote",
        manifest: manifest(),
        automations: [automation()],
        missingCloudNotes: ["supernote/Note/Missing.note"],
      }),
    ).toEqual({
      targetFolder: "Archive/Supernote",
      manifest: {
        version: 1,
        files: {
          journal: {
            ...manifest().files.journal,
            vaultPath: "Archive/Supernote/Note/Journal.note",
          },
        },
      },
      automations: [
        {
          ...automation(),
          sourceNote: "Archive/Supernote/Note/Journal.note",
        },
      ],
      missingCloudNotes: ["Archive/Supernote/Note/Missing.note"],
    });
  });

  it("moves, rewrites, and saves before reporting success", async () => {
    const calls: string[] = [];
    const result = await moveMirrorTransaction(
      {
        source: "supernote",
        destination: "Archive/Supernote",
        manifest: manifest(),
        automations: [automation()],
        missingCloudNotes: [],
      },
      {
        preflight: async () => {
          calls.push("preflight");
        },
        moveFolder: async () => {
          calls.push("move");
        },
        writeManifest: async (path) => {
          calls.push(`manifest:${path}`);
        },
        saveState: async () => {
          calls.push("save");
        },
        rollbackFolder: async () => {
          calls.push("rollback");
        },
        restoreDestination: async () => {
          calls.push("restore");
        },
      },
    );

    expect(result.targetFolder).toBe("Archive/Supernote");
    expect(calls).toEqual([
      "preflight",
      "move",
      "manifest:Archive/Supernote/.sync-manifest.json",
      "save",
    ]);
  });

  it("rolls back the folder and original manifest when state save fails", async () => {
    const calls: string[] = [];

    await expect(
      moveMirrorTransaction(
        {
          source: "supernote",
          destination: "Archive/Supernote",
          manifest: manifest(),
          automations: [automation()],
          missingCloudNotes: [],
        },
        {
          preflight: async () => undefined,
          moveFolder: async () => {
            calls.push("move");
          },
          writeManifest: async (path, value) => {
            calls.push(`manifest:${path}:${value.files.journal?.vaultPath}`);
          },
          saveState: async () => {
            calls.push("save");
            throw new Error("save failed");
          },
          rollbackFolder: async () => {
            calls.push("rollback");
          },
          restoreDestination: async () => {
            calls.push("restore");
          },
        },
      ),
    ).rejects.toThrow("save failed");

    expect(calls).toEqual([
      "move",
      "manifest:Archive/Supernote/.sync-manifest.json:Archive/Supernote/Note/Journal.note",
      "save",
      "rollback",
      "manifest:supernote/.sync-manifest.json:supernote/Note/Journal.note",
      "restore",
    ]);
  });

  it("does not write state when the folder move fails", async () => {
    const writeManifest = vi.fn();
    const saveState = vi.fn();
    const rollbackFolder = vi.fn();

    await expect(
      moveMirrorTransaction(
        {
          source: "supernote",
          destination: "Archive/Supernote",
          manifest: manifest(),
          automations: [automation()],
          missingCloudNotes: [],
        },
        {
          preflight: async () => undefined,
          moveFolder: async () => {
            throw new Error("move failed");
          },
          writeManifest,
          saveState,
          rollbackFolder,
          restoreDestination: vi.fn(),
        },
      ),
    ).rejects.toThrow("move failed");

    expect(writeManifest).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(rollbackFolder).not.toHaveBeenCalled();
  });

  it("restores the source and original manifest when manifest rewrite fails", async () => {
    let folder = "supernote";
    const written: string[] = [];
    const saveState = vi.fn();

    await expect(
      moveMirrorTransaction(
        {
          source: "supernote",
          destination: "Archive/Supernote",
          manifest: manifest(),
          automations: [automation()],
          missingCloudNotes: [],
        },
        {
          preflight: async () => undefined,
          moveFolder: async (_from, to) => {
            folder = to;
          },
          writeManifest: async (path, value) => {
            written.push(`${path}:${value.files.journal?.vaultPath}`);
            if (path.startsWith("Archive/")) {
              throw new Error("manifest failed");
            }
          },
          saveState,
          rollbackFolder: async (_from, to) => {
            folder = to;
          },
          restoreDestination: async () => undefined,
        },
      ),
    ).rejects.toThrow("manifest failed");

    expect(folder).toBe("supernote");
    expect(saveState).not.toHaveBeenCalled();
    expect(written).toEqual([
      "Archive/Supernote/.sync-manifest.json:Archive/Supernote/Note/Journal.note",
      "supernote/.sync-manifest.json:supernote/Note/Journal.note",
    ]);
  });

  it.each([
    ["unavailable", "Choose an existing empty vault folder."],
    ["non-empty", "The new Mirror folder must be empty."],
    ["not writable", "That vault folder could not be written."],
  ])(
    "leaves the source untouched when preflight reports %s",
    async (_case, message) => {
      const moveFolder = vi.fn();
      const saveState = vi.fn();

      await expect(
        moveMirrorTransaction(
          {
            source: "supernote",
            destination: "Archive/Supernote",
            manifest: manifest(),
            automations: [automation()],
            missingCloudNotes: [],
          },
          {
            preflight: async () => {
              throw new Error(message);
            },
            moveFolder,
            writeManifest: vi.fn(),
            saveState,
            rollbackFolder: vi.fn(),
            restoreDestination: vi.fn(),
          },
        ),
      ).rejects.toThrow(message);
      expect(moveFolder).not.toHaveBeenCalled();
      expect(saveState).not.toHaveBeenCalled();
    },
  );

  it("rejects an equal destination before preflight", async () => {
    const preflight = vi.fn();

    await expect(
      moveMirrorTransaction(
        {
          source: "supernote",
          destination: "supernote",
          manifest: manifest(),
          automations: [],
          missingCloudNotes: [],
        },
        {
          preflight,
          moveFolder: vi.fn(),
          writeManifest: vi.fn(),
          saveState: vi.fn(),
          rollbackFolder: vi.fn(),
          restoreDestination: vi.fn(),
        },
      ),
    ).rejects.toThrow("different Mirror destination");
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects the source and its descendants before preflight", async () => {
    const preflight = vi.fn();

    await expect(
      moveMirrorTransaction(
        {
          source: "supernote",
          destination: "supernote/Archive",
          manifest: manifest(),
          automations: [],
          missingCloudNotes: [],
        },
        {
          preflight,
          moveFolder: vi.fn(),
          writeManifest: vi.fn(),
          saveState: vi.fn(),
          rollbackFolder: vi.fn(),
          restoreDestination: vi.fn(),
        },
      ),
    ).rejects.toThrow("inside the current Mirror");
    expect(preflight).not.toHaveBeenCalled();
  });
});
