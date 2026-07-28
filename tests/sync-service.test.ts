import { describe, expect, it, vi } from "vitest";
import SparkMD5 from "spark-md5";

import type { CloudFile, DownloadDescriptor } from "../src/cloud/types";
import type {
  NotebookDescriptor,
  NotebookSessionProvider,
} from "../src/note/notebook-service";
import { emptyManifest, type SyncManifestFile } from "../src/sync/manifest";
import {
  allocateMirrorPaths,
  shouldRemoveMissingMirrorEntry,
  SyncService,
} from "../src/sync/sync-service";
import type { VaultStore } from "../src/sync/vault-store";

class MemoryVault implements VaultStore {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();

  async exists(path: string): Promise<boolean> {
    return this.text.has(path) || this.binary.has(path);
  }

  async getRevision(path: string): Promise<string | null> {
    return this.text.get(path) ?? null;
  }

  async readText(path: string): Promise<string | null> {
    return this.text.get(path) ?? null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    return this.binary.get(path) ?? null;
  }

  async writeText(path: string, content: string): Promise<void> {
    this.text.set(path, content);
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.binary.set(path, content);
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.binary.keys(), ...this.text.keys()].filter(
      (filePath) => filePath === path || filePath.startsWith(prefix),
    );
  }

  async delete(path: string): Promise<void> {
    this.text.delete(path);
    this.binary.delete(path);
  }
}

const file: CloudFile = {
  id: "42",
  directoryId: "7",
  fileName: "7 July 2026.note",
  isFolder: false,
  md5: "listing-md5",
  size: 100,
  createTime: 1,
  updateTime: 2,
};

const descriptor: DownloadDescriptor = {
  url: "https://download.example/7-July-2026.note",
  md5: SparkMD5.ArrayBuffer.hash(new Uint8Array([9]).buffer),
};

const createNotebooks = (
  pageCount = 12,
): NotebookSessionProvider & {
  open: ReturnType<typeof vi.fn<NotebookSessionProvider["open"]>>;
} => {
  const open = vi.fn<NotebookSessionProvider["open"]>(
    async ({ path, revision }) => {
      const descriptor: NotebookDescriptor = {
        path,
        revision,
        pageCount,
        devicePage: null,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          pageNumber: index + 1,
          fingerprint: `page-${index + 1}`,
          recognitionText: null,
          recognitionSpans: [],
        })),
        textBoxes: [],
      };
      return {
        descriptor,
        retain: vi.fn(() => {
          throw new Error("Unexpected lease retention");
        }),
        bitmap: vi.fn(),
        thumbnailBitmap: vi.fn(),
        renderPng: vi.fn(),
        updateView: vi.fn(),
        close: vi.fn(),
      };
    },
  );
  return { open };
};

const createService = (
  vault: MemoryVault,
  downloadDescriptor: DownloadDescriptor = descriptor,
) => {
  const cloud = {
    getDownloadDescriptor: vi.fn(async () => downloadDescriptor),
    download: vi.fn(async () => new Uint8Array([9])),
  };
  const notebooks = createNotebooks();
  return {
    cloud,
    notebooks,
    service: new SyncService({
      cloud,
      vault,
      notebooks,
      targetFolder: "supernote",
      now: () => new Date("2026-07-24T12:00:00Z"),
    }),
  };
};

describe("SyncService mirror", () => {
  it("only removes an absent remote file after a complete Mirror snapshot", () => {
    const entry: SyncManifestFile = {
      remoteId: "42",
      directoryId: "7",
      fileName: "Journal.note",
      remotePath: "/Note/Journal.note",
      md5: "md5",
      updateTime: 2,
      vaultPath: "supernote/Note/Journal.note",
      syncedAt: "2026-07-24T12:00:00.000Z",
    };
    const snapshot = {
      complete: true,
      remoteIds: new Set<string>(),
      remoteFolders: ["/Note"],
    };

    expect(shouldRemoveMissingMirrorEntry(entry, snapshot)).toBe(true);
    expect(
      shouldRemoveMissingMirrorEntry(entry, {
        ...snapshot,
        complete: false,
      }),
    ).toBe(false);
    expect(
      shouldRemoveMissingMirrorEntry(entry, {
        ...snapshot,
        remoteIds: new Set(["42"]),
      }),
    ).toBe(false);
    expect(
      shouldRemoveMissingMirrorEntry(entry, {
        ...snapshot,
        remoteFolders: ["/Document"],
      }),
    ).toBe(false);
  });

  it("allocates stable writable paths for unsafe and colliding remote names", async () => {
    const vault = new MemoryVault();
    const { service } = createService(vault);
    const manifest = emptyManifest();
    const cases = [
      { id: "lt", name: "draft<.pdf" },
      { id: "gt", name: "draft>.pdf" },
      { id: "colon", name: "draft:.pdf" },
      { id: "quote", name: 'draft".pdf' },
      { id: "pipe", name: "draft|.pdf" },
      { id: "question", name: "draft?.pdf" },
      { id: "star", name: "draft*.pdf" },
      { id: "control", name: "draft\u0001.pdf" },
      { id: "dot", name: "draft.pdf." },
      { id: "space", name: "draft.pdf " },
      { id: "reserved", name: "CON.note" },
      { id: "backslash", name: "folder\\child.pdf" },
      { id: "case-upper", name: "Report.pdf" },
      { id: "case-lower", name: "report.pdf" },
    ];
    const inputs = cases.map((input) => ({
      file: {
        ...file,
        id: input.id,
        fileName: input.name,
      },
      remotePath: `/Document/${input.name}`,
    }));
    service.planMirrorPaths(inputs);

    const paths: string[] = [];
    for (const input of inputs) {
      const result = await service.mirrorFile(input, manifest);
      paths.push(result.vaultPath);
    }

    expect(new Set(paths.map((path) => path.toLocaleLowerCase())).size).toBe(
      cases.length,
    );
    for (const path of paths) {
      expect(
        [...path].some(
          (character) =>
            character.charCodeAt(0) <= 31 || '\\<>:"|?*'.includes(character),
        ),
      ).toBe(false);
      expect(path.split("/").at(-1)).not.toMatch(/[. ]$/);
    }
    expect(paths).toContain("supernote/Document/_CON.note");
    expect(paths).toContain("supernote/Document/folder_child.pdf");
    expect(paths).toEqual([
      "supernote/Document/draft_~6c74.pdf",
      "supernote/Document/draft_~6774.pdf",
      "supernote/Document/draft_~636f6c6f6e.pdf",
      "supernote/Document/draft_~71756f7465.pdf",
      "supernote/Document/draft_~70697065.pdf",
      "supernote/Document/draft_~7175657374696f6e.pdf",
      "supernote/Document/draft_~73746172.pdf",
      "supernote/Document/draft_~636f6e74726f6c.pdf",
      "supernote/Document/draft~646f74.pdf_",
      "supernote/Document/draft~7370616365.pdf_",
      "supernote/Document/_CON.note",
      "supernote/Document/folder_child.pdf",
      "supernote/Document/Report~636173652d7570706572.pdf",
      "supernote/Document/report~636173652d6c6f776572.pdf",
    ]);
    expect(paths.filter((path) => /report/i.test(path))).toEqual([
      "supernote/Document/Report~636173652d7570706572.pdf",
      "supernote/Document/report~636173652d6c6f776572.pdf",
    ]);
    expect(manifest.files.backslash?.remotePath).toBe(
      "/Document/folder\\child.pdf",
    );

    const repeated = await service.mirrorFile(
      {
        file: {
          ...file,
          id: "case-lower",
          fileName: "report.pdf",
        },
        remotePath: "/Document/report.pdf",
      },
      manifest,
    );
    expect(repeated).toMatchObject({
      status: "skipped",
      vaultPath: "supernote/Document/report~636173652d6c6f776572.pdf",
    });
  });

  it("allocates the same collision targets regardless of listing order", () => {
    const inputs = [
      {
        file: { ...file, id: "upper", fileName: "Report.pdf" },
        remotePath: "/Document/Report.pdf",
      },
      {
        file: { ...file, id: "lower", fileName: "report.pdf" },
        remotePath: "/Document/report.pdf",
      },
      {
        file: { ...file, id: "natural", fileName: "Report~7570706572.pdf" },
        remotePath: "/Document/Report~7570706572.pdf",
      },
    ];

    expect([...allocateMirrorPaths("supernote", inputs)].sort()).toEqual(
      [...allocateMirrorPaths("supernote", [...inputs].reverse())].sort(),
    );
    expect(
      new Set(
        [...allocateMirrorPaths("supernote", inputs).values()].map((path) =>
          path.toLocaleLowerCase(),
        ),
      ).size,
    ).toBe(inputs.length);
  });

  it("mutates a caller-owned manifest without loading or saving it", async () => {
    const vault = new MemoryVault();
    const { service } = createService(vault);
    const readManifest = vi.spyOn(vault, "readText");
    const writeManifest = vi.spyOn(vault, "writeText");
    const manifest = emptyManifest();

    await service.mirrorFile(
      {
        file,
        remotePath: "/Note/Journal/2026/7 July 2026.note",
      },
      manifest,
    );

    expect(manifest.files["42"]).toMatchObject({
      remoteId: "42",
      md5: descriptor.md5,
    });
    expect(readManifest).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
  });

  it("mirrors the device folder tree without generated artifacts", async () => {
    const vault = new MemoryVault();
    const { notebooks, service } = createService(vault);

    await expect(
      service.mirrorFile({
        file,
        remotePath: "/Note/Journal/2026/7 July 2026.note",
      }),
    ).resolves.toEqual({
      status: "mirrored",
      vaultPath: "supernote/Note/Journal/2026/7 July 2026.note",
      pageCount: 12,
    });

    expect([...vault.binary.keys()]).toEqual([
      "supernote/Note/Journal/2026/7 July 2026.note",
    ]);
    expect(notebooks.open).toHaveBeenCalledWith(
      expect.objectContaining({ transfer: "copy" }),
    );
    expect(
      JSON.parse(vault.text.get("supernote/.sync-manifest.json") ?? "{}"),
    ).toEqual({
      version: 1,
      files: {
        "42": {
          remoteId: "42",
          directoryId: "7",
          fileName: "7 July 2026.note",
          remotePath: "/Note/Journal/2026/7 July 2026.note",
          md5: descriptor.md5,
          updateTime: 2,
          pageCount: 12,
          vaultPath: "supernote/Note/Journal/2026/7 July 2026.note",
          syncedAt: "2026-07-24T12:00:00.000Z",
        },
      },
    });
  });

  it("skips an unchanged mirrored notebook", async () => {
    const vault = new MemoryVault();
    const { cloud, service } = createService(vault);
    const input = {
      file,
      remotePath: "/Note/Journal/2026/7 July 2026.note",
    };
    await service.mirrorFile(input);
    cloud.download.mockClear();

    await expect(service.mirrorFile(input)).resolves.toMatchObject({
      status: "skipped",
    });
    expect(cloud.download).not.toHaveBeenCalled();
  });

  it("removes a cloud-deleted file from the Mirror and its manifest", async () => {
    const vault = new MemoryVault();
    const { service } = createService(vault);
    const manifest = emptyManifest();
    const input = {
      file,
      remotePath: "/Note/Journal/2026/7 July 2026.note",
    };
    await service.mirrorFile(input, manifest);

    await expect(
      service.removeMirroredFile(file.id, manifest),
    ).resolves.toEqual({
      remotePath: "/Note/Journal/2026/7 July 2026.note",
      vaultPath: "supernote/Note/Journal/2026/7 July 2026.note",
      status: "removed",
    });

    expect(
      vault.binary.has("supernote/Note/Journal/2026/7 July 2026.note"),
    ).toBe(false);
    expect(manifest.files).toEqual({});
  });

  it("preserves a divergent local edit when the Cloud file disappears", async () => {
    const vault = new MemoryVault();
    const { service } = createService(vault);
    const manifest = emptyManifest();
    const input = {
      file,
      remotePath: "/Note/Journal/2026/7 July 2026.note",
    };
    const mirrored = await service.mirrorFile(input, manifest);
    await vault.writeBinary(mirrored.vaultPath, new Uint8Array([9, 9, 9]));

    await expect(
      service.removeMirroredFile(file.id, manifest),
    ).resolves.toMatchObject({
      status: "protected",
      vaultPath: mirrored.vaultPath,
    });

    expect(vault.binary.has(mirrored.vaultPath)).toBe(true);
    expect(manifest.files[file.id]).toBeDefined();
  });

  it("updates mirror bytes without touching previous exports", async () => {
    const vault = new MemoryVault();
    const first = createService(vault);
    const input = {
      file,
      remotePath: "/Note/Journal/2026/7 July 2026.note",
    };
    await first.service.mirrorFile(input);
    const manifest = JSON.parse(
      vault.text.get("supernote/.sync-manifest.json") ?? "{}",
    ) as {
      files: Record<string, Record<string, unknown>>;
    };
    manifest.files["42"]!.lastExport = {
      destination: "Journal",
      format: "markdown-images",
    };
    manifest.files["42"]!.transcriptionCache = {
      pages: {
        "3": {
          md5: descriptor.md5,
          fingerprint: "backend",
          text: "cached",
        },
      },
      documents: {},
    };
    manifest.files["42"]!.watchHooks = {
      scratch: {
        noteMd5: descriptor.md5,
        pageMd5s: { "1": "page-md5" },
      },
    };
    vault.text.set("supernote/.sync-manifest.json", JSON.stringify(manifest));
    vault.text.set("Journal/entry.md", "User-owned snapshot");

    const changed = createService(vault, {
      ...descriptor,
      md5: "changed-md5",
    });
    await changed.service.mirrorFile(input);

    expect(vault.text.get("Journal/entry.md")).toBe("User-owned snapshot");
    const updated = JSON.parse(
      vault.text.get("supernote/.sync-manifest.json") ?? "{}",
    ) as {
      files: Record<string, Record<string, unknown>>;
    };
    expect(updated.files["42"]).toMatchObject({
      md5: "changed-md5",
      lastExport: {
        destination: "Journal",
        format: "markdown-images",
      },
      watchHooks: {
        scratch: {
          noteMd5: descriptor.md5,
          pageMd5s: { "1": "page-md5" },
        },
      },
    });
    expect(updated.files["42"]).not.toHaveProperty("transcriptionCache");
  });

  it("mirrors a non-note cloud file without parsing it", async () => {
    const vault = new MemoryVault();
    const cloud = {
      getDownloadDescriptor: vi.fn(async () => ({
        url: "https://download.example/report.pdf",
        md5: "pdf-md5",
      })),
      download: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    };
    const notebooks = createNotebooks();
    const service = new SyncService({
      cloud,
      vault,
      notebooks,
      targetFolder: "supernote",
      now: () => new Date("2026-07-24T12:00:00Z"),
    });
    const pdf: CloudFile = {
      ...file,
      id: "pdf-1",
      fileName: "Reference.pdf",
    };

    await expect(
      service.mirrorFile({
        file: pdf,
        remotePath: "/Document/Research/Reference.pdf",
      }),
    ).resolves.toEqual({
      status: "mirrored",
      vaultPath: "supernote/Document/Research/Reference.pdf",
    });

    expect(notebooks.open).not.toHaveBeenCalled();
    expect(
      vault.binary.get("supernote/Document/Research/Reference.pdf"),
    ).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it("protects a locally edited mirrored file from cloud overwrite", async () => {
    const vault = new MemoryVault();
    const original = new Uint8Array([1, 2, 3]);
    const edited = new Uint8Array([4, 5, 6]);
    const originalMd5 = SparkMD5.ArrayBuffer.hash(
      Uint8Array.from(original).buffer,
    );
    const cloud = {
      getDownloadDescriptor: vi.fn(async () => ({
        url: "https://download.example/file.txt",
        md5: "new-cloud-md5",
      })),
      download: vi.fn(async () => new Uint8Array([7, 8, 9])),
    };
    const service = new SyncService({
      cloud,
      vault,
      notebooks: createNotebooks(),
      targetFolder: "supernote",
    });
    vault.binary.set("supernote/Document/file.txt", edited);
    vault.text.set(
      "supernote/.sync-manifest.json",
      JSON.stringify({
        version: 1,
        files: {
          "txt-1": {
            remoteId: "txt-1",
            directoryId: "doc",
            fileName: "file.txt",
            remotePath: "/Document/file.txt",
            md5: originalMd5,
            updateTime: 1,
            vaultPath: "supernote/Document/file.txt",
            syncedAt: "2026-07-24T12:00:00.000Z",
          },
        },
      }),
    );

    await expect(
      service.mirrorFile({
        file: {
          ...file,
          id: "txt-1",
          directoryId: "doc",
          fileName: "file.txt",
        },
        remotePath: "/Document/file.txt",
      }),
    ).resolves.toEqual({
      status: "protected",
      vaultPath: "supernote/Document/file.txt",
    });

    expect(cloud.getDownloadDescriptor).not.toHaveBeenCalled();
    expect(cloud.download).not.toHaveBeenCalled();
    expect(vault.binary.get("supernote/Document/file.txt")).toEqual(edited);
  });

  it("names the file and buffered size when a download fails", async () => {
    const vault = new MemoryVault();
    const cloud = {
      getDownloadDescriptor: vi.fn(async () => ({
        url: "https://download.example/large.pdf",
        md5: "cloud-md5",
      })),
      download: vi.fn(async () => {
        throw new Error("HTTP 413");
      }),
    };
    const service = new SyncService({
      cloud,
      vault,
      notebooks: createNotebooks(),
      targetFolder: "supernote",
    });

    await expect(
      service.mirrorFile({
        file: {
          ...file,
          id: "large",
          fileName: "large.pdf",
          size: 125 * 1024 * 1024,
        },
        remotePath: "/Document/large.pdf",
      }),
    ).rejects.toThrow("Download failed for large.pdf (125.0 MB): HTTP 413");
  });
});
