import { describe, expect, it, vi } from "vitest";
import { TFile, type Vault } from "obsidian";

import { ObsidianVaultStore } from "../src/sync/obsidian-vault-store";

const fileManager = () => ({
  trashFile: vi.fn(async () => undefined),
});

describe("ObsidianVaultStore", () => {
  it("checks indexed and hidden paths without reading file contents", async () => {
    const indexed = { path: "Journal/existing.md" };
    const adapter = {
      exists: vi.fn(async (path: string) => path.startsWith(".")),
      read: vi.fn(),
      readBinary: vi.fn(),
    };
    const vault = {
      adapter,
      getAbstractFileByPath: vi.fn((path: string) =>
        path === indexed.path ? indexed : null,
      ),
    } as unknown as Vault;
    const store = new ObsidianVaultStore(vault, fileManager());

    await expect(store.exists(indexed.path)).resolves.toBe(true);
    await expect(store.exists(".hidden/state.json")).resolves.toBe(true);
    await expect(store.exists("missing.md")).resolves.toBe(false);
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.readBinary).not.toHaveBeenCalled();
  });

  it("reads a hidden manifest through the adapter after Obsidian reloads", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      read: vi.fn(async () => '{"version":1,"files":{}}'),
    };
    const vault = {
      adapter,
      getAbstractFileByPath: vi.fn(() => null),
    } as unknown as Vault;

    const store = new ObsidianVaultStore(vault, fileManager());

    await expect(store.readText("supernote/.sync-manifest.json")).resolves.toBe(
      '{"version":1,"files":{}}',
    );
    expect(adapter.exists).toHaveBeenCalledWith(
      "supernote/.sync-manifest.json",
    );
  });

  it("reads a hidden manifest revision without reading its contents", async () => {
    const adapter = {
      read: vi.fn(),
      readBinary: vi.fn(),
      stat: vi.fn(async () => ({ mtime: 42, size: 7 })),
    };
    const vault = {
      adapter,
      getAbstractFileByPath: vi.fn(() => null),
    } as unknown as Vault;

    const store = new ObsidianVaultStore(vault, fileManager());

    await expect(
      store.getRevision("supernote/.sync-manifest.json"),
    ).resolves.toBe("42:7");
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.readBinary).not.toHaveBeenCalled();
  });

  it("updates a hidden manifest through the adapter when it is not indexed", async () => {
    const adapter = {
      write: vi.fn(async () => undefined),
    };
    const vault = {
      adapter,
      getAbstractFileByPath: vi.fn((path: string) =>
        path === "supernote" ? {} : null,
      ),
    } as unknown as Vault;

    const store = new ObsidianVaultStore(vault, fileManager());
    await store.writeText(
      "supernote/.sync-manifest.json",
      '{"version":1,"files":{"42":{}}}',
    );

    expect(adapter.write).toHaveBeenCalledWith(
      "supernote/.sync-manifest.json",
      '{"version":1,"files":{"42":{}}}',
    );
  });

  it("updates indexed text atomically through Vault.process", async () => {
    const file = Object.setPrototypeOf(
      { path: "supernote/Document/Obsidian/report.md" },
      TFile.prototype,
    ) as TFile;
    const process = vi.fn(
      async (_file: TFile, update: (current: string) => string) => {
        expect(update("stale")).toBe("fresh");
      },
    );
    const vault = {
      adapter: {},
      getAbstractFileByPath: vi.fn(() => file),
      process,
      modify: vi.fn(),
    } as unknown as Vault;

    await new ObsidianVaultStore(vault, fileManager()).writeText(
      file.path,
      "fresh",
    );

    expect(process).toHaveBeenCalledOnce();
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("lists indexed files recursively beneath a writable subtree", async () => {
    const getFiles = vi.fn(() => {
      throw new Error("Whole-vault scan should not run");
    });
    const vault = {
      getFiles,
      getAbstractFileByPath: vi.fn(() => ({
        path: "supernote/Document/Obsidian",
        children: [
          { path: "supernote/Document/Obsidian/report.pdf" },
          {
            path: "supernote/Document/Obsidian/nested",
            children: [
              {
                path: "supernote/Document/Obsidian/nested/note.txt",
              },
            ],
          },
        ],
      })),
    } as unknown as Vault;

    await expect(
      new ObsidianVaultStore(vault, fileManager()).listFiles(
        "supernote/Document/Obsidian",
      ),
    ).resolves.toEqual([
      "supernote/Document/Obsidian/nested/note.txt",
      "supernote/Document/Obsidian/report.pdf",
    ]);
    expect(getFiles).not.toHaveBeenCalled();
  });

  it("lists empty directories beneath a Paired folder", async () => {
    const vault = {
      getAbstractFileByPath: vi.fn(() => ({
        path: "supernote/Document/Obsidian",
        children: [
          {
            path: "supernote/Document/Obsidian/Empty",
            children: [],
          },
          {
            path: "supernote/Document/Obsidian/Nested",
            children: [
              {
                path: "supernote/Document/Obsidian/Nested/Leaf",
                children: [],
              },
            ],
          },
        ],
      })),
    } as unknown as Vault;

    await expect(
      new ObsidianVaultStore(vault, fileManager()).listDirectories(
        "supernote/Document/Obsidian",
      ),
    ).resolves.toEqual([
      "supernote/Document/Obsidian",
      "supernote/Document/Obsidian/Empty",
      "supernote/Document/Obsidian/Nested",
      "supernote/Document/Obsidian/Nested/Leaf",
    ]);
  });

  it("moves an indexed mirrored file to the user's configured Trash", async () => {
    const file = Object.setPrototypeOf(
      { path: "supernote/Note/Journal.note" },
      TFile.prototype,
    ) as TFile;
    const adapter = {
      exists: vi.fn(async () => false),
      remove: vi.fn(),
    };
    const vault = {
      adapter,
      getAbstractFileByPath: vi.fn(() => file),
      delete: vi.fn(),
    } as unknown as Vault;
    const trashFile = vi.fn(async () => undefined);

    await new ObsidianVaultStore(vault, { trashFile }).delete(file.path);

    expect(trashFile).toHaveBeenCalledWith(file);
    expect(vault.delete).not.toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("fails safely when a mirrored file is not indexed for Trash", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      remove: vi.fn(),
    };
    const vault = {
      adapter,
      getAbstractFileByPath: vi.fn(() => null),
    } as unknown as Vault;

    await expect(
      new ObsidianVaultStore(vault, fileManager()).delete(
        "supernote/Note/.hidden.note",
      ),
    ).rejects.toThrow("Cannot move unindexed vault file to Trash");
    expect(adapter.remove).not.toHaveBeenCalled();
  });
});
