import SparkMD5 from "spark-md5";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudDirectory,
  CloudFile,
  CloudItem,
  DownloadDescriptor,
  UploadResult,
} from "../src/cloud/types";
import {
  emptyPairBaseline,
  PairInventoryIncompleteError,
  PairSyncService,
  type PairBaseline,
} from "../src/sync/pair-sync-service";
import type { VaultStore } from "../src/sync/vault-store";

const checksum = (bytes: Uint8Array): string =>
  SparkMD5.ArrayBuffer.hash(Uint8Array.from(bytes).buffer);

const remoteFile = (
  id: string,
  fileName: string,
  bytes: Uint8Array,
): CloudFile => ({
  id,
  directoryId: "pair",
  fileName,
  isFolder: false,
  md5: checksum(bytes),
  size: bytes.byteLength,
  createTime: 1,
  updateTime: 1,
});

const folder = (
  id: string,
  directoryId: string,
  fileName: string,
): CloudDirectory => ({
  id,
  directoryId,
  fileName,
  isFolder: true,
  md5: "",
  size: 0,
  createTime: 1,
  updateTime: 1,
});

const remoteFolder: CloudDirectory = {
  id: "pair",
  directoryId: "0",
  fileName: "Obsidian",
  isFolder: true,
  md5: "",
  size: 0,
  createTime: 1,
  updateTime: 1,
};

class MemoryPairVault implements VaultStore {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([
    "supernote",
    "supernote/Document",
    "supernote/Document/Obsidian",
  ]);
  readonly createDirectory = vi.fn(async (path: string): Promise<void> => {
    this.directories.add(path);
  });
  readonly listDirectories = vi.fn(async (path: string): Promise<string[]> => {
    const prefix = `${path}/`;
    return [...this.directories].filter((entry) => entry.startsWith(prefix));
  });
  readonly move = vi.fn(async (from: string, to: string): Promise<void> => {
    const content = this.files.get(from);
    if (!content) {
      throw new Error(`Missing ${from}`);
    }
    this.files.set(to, content);
    this.files.delete(from);
  });
  readonly delete = vi.fn(async (path: string): Promise<void> => {
    this.files.delete(path);
    this.directories.delete(path);
  });

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async getRevision(path: string): Promise<string | null> {
    return this.files.has(path) ? "revision" : null;
  }

  async readText(): Promise<string | null> {
    return null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async writeText(): Promise<void> {}

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, Uint8Array.from(content));
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()].filter((file) => file.startsWith(prefix));
  }
}

class MemoryPairCloud {
  readonly items = new Map<string, CloudItem>([
    [remoteFolder.id, remoteFolder],
  ]);
  readonly bytes = new Map<string, Uint8Array>();
  readonly uploadFile = vi.fn(
    async (
      directoryId: string,
      fileName: string,
      content: Uint8Array,
    ): Promise<UploadResult> => {
      const file = remoteFile(`uploaded-${fileName}`, fileName, content);
      file.directoryId = directoryId;
      this.items.set(file.id, file);
      this.bytes.set(file.id, Uint8Array.from(content));
      return { md5: file.md5 };
    },
  );
  readonly replaceFile = vi.fn(
    async (file: CloudFile, content: Uint8Array): Promise<UploadResult> => {
      file.md5 = checksum(content);
      this.bytes.set(file.id, Uint8Array.from(content));
      return { md5: file.md5 };
    },
  );
  readonly recycleItem = vi.fn(async (item: CloudItem): Promise<void> => {
    this.items.delete(item.id);
    this.bytes.delete(item.id);
  });
  readonly createDirectory = vi.fn(
    async (directoryId: string, fileName: string): Promise<void> => {
      const directory = folder(
        `created-${directoryId}-${fileName}`,
        directoryId,
        fileName,
      );
      this.items.set(directory.id, directory);
    },
  );
  readonly listDirectory = vi.fn(
    async (directoryId: string): Promise<CloudItem[]> =>
      [...this.items.values()].filter(
        (item) => item.directoryId === directoryId,
      ),
  );

  add(fileName: string, content: Uint8Array): CloudFile {
    const file = remoteFile(`remote-${fileName}`, fileName, content);
    this.items.set(file.id, file);
    this.bytes.set(file.id, Uint8Array.from(content));
    return file;
  }

  addDirectory(fileName: string): CloudDirectory {
    const directory = folder(`remote-${fileName}`, "pair", fileName);
    this.items.set(directory.id, directory);
    return directory;
  }

  async getDownloadDescriptor(fileId: string): Promise<DownloadDescriptor> {
    const file = this.items.get(fileId);
    if (!file || file.isFolder) {
      throw new Error(`Missing ${fileId}`);
    }
    return { url: `https://download.example/${fileId}`, md5: file.md5 };
  }

  async download(url: string): Promise<Uint8Array> {
    const id = new URL(url).pathname.slice(1);
    const bytes = this.bytes.get(id);
    if (!bytes) {
      throw new Error(`Missing ${id}`);
    }
    return Uint8Array.from(bytes);
  }
}

const localPath = (name: string): string =>
  `supernote/Document/Obsidian/${name}`;

const baselineFor = (
  file: CloudFile,
  bytes: Uint8Array,
  localFileName = file.fileName,
): PairBaseline => ({
  version: 1,
  initialized: true,
  entries: {
    [localFileName]: {
      localRelativePath: localFileName,
      remoteRelativePath: file.fileName,
      remoteId: file.id,
      directoryId: file.directoryId,
      fileName: file.fileName,
      checksum: checksum(bytes),
    },
  },
  directories: {},
  conflicts: {},
});

const service = (
  vault: MemoryPairVault,
  cloud: MemoryPairCloud,
): PairSyncService =>
  new PairSyncService({
    vault,
    cloud,
    targetFolder: "supernote",
    remoteFolder: "Document/Obsidian",
    remoteDirectoryId: "pair",
  });

describe("PairSyncService", () => {
  it("adopts equal current content when both sides changed from the baseline", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const now = new Uint8Array([2]);
    const file = cloud.add("equal.pdf", now);
    vault.files.set(localPath("equal.pdf"), now);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );

    expect(result.conflicts).toEqual([]);
    expect(result.unchanged).toEqual(["Document/Obsidian/equal.pdf"]);
    expect(result.baseline.entries["equal.pdf"]?.checksum).toBe(checksum(now));
    expect(cloud.replaceFile).not.toHaveBeenCalled();
  });

  it("recycles an unchanged Remote file deleted from the Vault", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("deleted-local.pdf", content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.deletedRemote).toEqual([
      "Document/Obsidian/deleted-local.pdf",
    ]);
    expect(cloud.recycleItem).toHaveBeenCalledWith(file);
    expect(result.baseline.entries).toEqual({});
  });

  it("moves an unchanged Vault file to Trash after Remote deletion", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const missing = remoteFile("missing", "deleted-remote.pdf", content);
    vault.files.set(localPath("deleted-remote.pdf"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(missing, content),
    );

    expect(result.deletedLocal).toEqual([
      "Document/Obsidian/deleted-remote.pdf",
    ]);
    expect(vault.delete).toHaveBeenCalledWith(localPath("deleted-remote.pdf"));
    expect(result.baseline.entries).toEqual({});
  });

  it("preserves an edit when the other side deleted", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const edited = new Uint8Array([2]);
    const missing = remoteFile("missing", "edited.pdf", before);
    vault.files.set(localPath("edited.pdf"), edited);

    const result = await service(vault, cloud).reconcile(
      baselineFor(missing, before),
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "vault-edited-remote-deleted",
        localRelativePath: "edited.pdf",
      }),
    ]);
    expect(vault.files.get(localPath("edited.pdf"))).toEqual(edited);
    expect(vault.delete).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it("does no work when a Remote inventory is incomplete", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    vault.files.set(localPath("local.pdf"), content);
    cloud.listDirectory.mockRejectedValueOnce(new Error("offline"));

    await expect(
      service(vault, cloud).reconcile(emptyPairBaseline()),
    ).rejects.toBeInstanceOf(PairInventoryIncompleteError);

    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.recycleItem).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it("requires confirmation before uploading a local-only first baseline item", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.files.set(localPath("local-only.pdf"), new Uint8Array([1]));

    const result = await service(vault, cloud).reconcile(emptyPairBaseline());

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "first-baseline-local-only",
        localRelativePath: "local-only.pdf",
      }),
    ]);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it("resolves a content conflict by using the Vault copy", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const local = new Uint8Array([2]);
    const remote = new Uint8Array([3]);
    const file = cloud.add("resolve.pdf", remote);
    vault.files.set(localPath("resolve.pdf"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );
    const conflict = conflicted.conflicts[0]!;

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflict.id]: "use-vault" } },
    );

    expect(resolved.conflicts).toEqual([]);
    expect(resolved.uploaded).toEqual(["Document/Obsidian/resolve.pdf"]);
    expect(cloud.bytes.get(file.id)).toEqual(local);
  });

  it("resolves a content conflict by using the Remote copy", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const local = new Uint8Array([2]);
    const remote = new Uint8Array([3]);
    const file = cloud.add("resolve.pdf", remote);
    vault.files.set(localPath("resolve.pdf"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );
    const conflict = conflicted.conflicts[0]!;

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflict.id]: "use-remote" } },
    );

    expect(resolved.conflicts).toEqual([]);
    expect(resolved.downloaded).toEqual(["Document/Obsidian/resolve.pdf"]);
    expect(vault.files.get(localPath("resolve.pdf"))).toEqual(remote);
  });

  it("keeps both divergent copies under stable Pair paths", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const local = new Uint8Array([2]);
    const remote = new Uint8Array([3]);
    const file = cloud.add("resolve.pdf", remote);
    vault.files.set(localPath("resolve.pdf"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );
    const conflict = conflicted.conflicts[0]!;

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflict.id]: "keep-both" } },
    );

    const copyName = `resolve (Vault ${checksum(local).slice(0, 8)}).pdf`;
    expect(resolved.conflicts).toEqual([]);
    expect(vault.files.get(localPath("resolve.pdf"))).toEqual(remote);
    expect(vault.files.get(localPath(copyName))).toEqual(local);
    expect(
      [...cloud.items.values()].find(
        (item) => !item.isFolder && item.fileName === copyName,
      ),
    ).toMatchObject({ md5: checksum(local) });
    expect(Object.keys(resolved.baseline.entries).sort()).toEqual(
      [copyName, "resolve.pdf"].sort(),
    );
  });

  it("propagates one unambiguous byte-identical Vault rename", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("before.pdf", content);
    vault.files.set(localPath("after.pdf"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.movedRemote).toEqual([
      "Document/Obsidian/before.pdf → Document/Obsidian/after.pdf",
    ]);
    expect(cloud.recycleItem).toHaveBeenCalledWith(file);
    expect(
      [...cloud.items.values()].find(
        (item) => !item.isFolder && item.fileName === "after.pdf",
      ),
    ).toMatchObject({ md5: checksum(content) });
    expect(Object.keys(result.baseline.entries)).toEqual(["after.pdf"]);
  });

  it("moves the Vault copy when the Remote item was renamed", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("before.pdf", content);
    vault.files.set(localPath("before.pdf"), content);
    const baseline = baselineFor(file, content);
    file.fileName = "after.pdf";

    const result = await service(vault, cloud).reconcile(baseline);

    expect(result.movedLocal).toEqual([
      "Document/Obsidian/before.pdf → Document/Obsidian/after.pdf",
    ]);
    expect(vault.move).toHaveBeenCalledWith(
      localPath("before.pdf"),
      localPath("after.pdf"),
    );
    expect(Object.keys(result.baseline.entries)).toEqual(["after.pdf"]);
  });

  it("does not guess a Vault rename when identical candidates are ambiguous", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("before.pdf", content);
    vault.files.set(localPath("candidate-a.pdf"), content);
    vault.files.set(localPath("candidate-b.pdf"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "ambiguous-rename",
        localRelativePath: "before.pdf",
      }),
    ]);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.recycleItem).not.toHaveBeenCalled();
  });

  it("preserves an empty Remote directory in the Vault", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    cloud.addDirectory("Empty");

    const result = await service(vault, cloud).reconcile(emptyPairBaseline());

    expect(vault.createDirectory).toHaveBeenCalledWith(
      "supernote/Document/Obsidian/Empty",
    );
    expect(result.createdLocalDirectories).toEqual(["Document/Obsidian/Empty"]);
    expect(result.baseline.directories.Empty).toMatchObject({
      remoteRelativePath: "Empty",
    });
  });

  it("creates a new empty Vault directory in the Remote Pair after baseline", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.directories.add("supernote/Document/Obsidian/Empty");
    const baseline = emptyPairBaseline();
    baseline.initialized = true;

    const result = await service(vault, cloud).reconcile(baseline);

    expect(cloud.createDirectory).toHaveBeenCalledWith("pair", "Empty");
    expect(result.createdRemoteDirectories).toEqual([
      "Document/Obsidian/Empty",
    ]);
  });

  it("requires confirmation before uploading a first-baseline empty local directory", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.directories.add("supernote/Document/Obsidian/Empty");

    const first = await service(vault, cloud).reconcile(emptyPairBaseline());

    expect(first.conflicts).toEqual([
      expect.objectContaining({
        kind: "first-baseline-local-only-directory",
        localRelativePath: "Empty",
      }),
    ]);
    expect(cloud.createDirectory).not.toHaveBeenCalled();

    const resolved = await service(vault, cloud).reconcile(first.baseline, {
      resolutions: { [first.conflicts[0]!.id]: "use-vault" },
    });
    expect(cloud.createDirectory).toHaveBeenCalledWith("pair", "Empty");
    expect(resolved.baseline.conflicts).toEqual({});
  });

  it("propagates deletion of an unchanged empty Vault directory", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const directory = cloud.addDirectory("Empty");
    const baseline = emptyPairBaseline();
    baseline.initialized = true;
    baseline.directories.Empty = {
      localRelativePath: "Empty",
      remoteRelativePath: "Empty",
      remoteId: directory.id,
      directoryId: directory.directoryId,
      fileName: directory.fileName,
    };

    const result = await service(vault, cloud).reconcile(baseline);

    expect(cloud.recycleItem).toHaveBeenCalledWith(directory);
    expect(result.deletedRemoteDirectories).toEqual([
      "Document/Obsidian/Empty",
    ]);
  });

  it("checkpoints each verified success before a later operation fails", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.files.set(localPath("a.pdf"), new Uint8Array([1]));
    vault.files.set(localPath("b.pdf"), new Uint8Array([2]));
    const baseline = emptyPairBaseline();
    baseline.initialized = true;
    cloud.uploadFile.mockImplementationOnce(
      async (directoryId, fileName, content) => {
        const file = remoteFile(`uploaded-${fileName}`, fileName, content);
        file.directoryId = directoryId;
        cloud.items.set(file.id, file);
        cloud.bytes.set(file.id, Uint8Array.from(content));
        return { md5: file.md5 };
      },
    );
    cloud.uploadFile.mockRejectedValueOnce(new Error("network stopped"));
    const checkpoints: PairBaseline[] = [];

    await expect(
      service(vault, cloud).reconcile(baseline, {
        onBaselineChange: (next) => {
          checkpoints.push(next);
        },
      }),
    ).rejects.toThrow("network stopped");

    expect(checkpoints.at(-1)?.entries["a.pdf"]).toBeDefined();
    expect(checkpoints.at(-1)?.entries["b.pdf"]).toBeUndefined();
  });
});
