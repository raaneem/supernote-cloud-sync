import type { CloudDownloadPort, CloudFile } from "../cloud/types";
import type { NotebookSessionProvider } from "../note/notebook-service";
import { md5, sameMd5 } from "../shared/md5";
import {
  normalizeOptionalRelativePath,
  normalizeRelativePath,
  normalizeRemotePath,
  vaultSafeName,
} from "../shared/path";
import {
  loadManifest,
  saveManifest,
  type SyncManifest,
  type SyncManifestFile,
} from "./manifest";
import type { VaultStore } from "./vault-store";

interface SyncServiceOptions {
  cloud: CloudDownloadPort;
  vault: VaultStore;
  notebooks: NotebookSessionProvider;
  targetFolder: string;
  now?: () => Date;
}

export interface FileMirror {
  file: CloudFile;
  remotePath: string;
}

export interface MirrorResult {
  status: "mirrored" | "skipped" | "protected";
  vaultPath: string;
  pageCount?: number;
}

export interface MirroredFileRemovalResult {
  remotePath: string;
  vaultPath: string;
  status: "removed" | "protected";
}

export interface MirrorSnapshot {
  complete: boolean;
  remoteIds: ReadonlySet<string>;
  remoteFolders: readonly string[];
}

export const shouldRemoveMissingMirrorEntry = (
  entry: SyncManifestFile,
  snapshot: MirrorSnapshot,
): boolean => {
  if (!snapshot.complete || snapshot.remoteIds.has(entry.remoteId)) {
    return false;
  }
  const remotePath = normalizeOptionalRelativePath(entry.remotePath);
  return snapshot.remoteFolders.some((folder) => {
    const normalizedFolder = normalizeOptionalRelativePath(folder);
    return (
      !normalizedFolder ||
      remotePath === normalizedFolder ||
      remotePath.startsWith(`${normalizedFolder}/`)
    );
  });
};

export const mirrorFilePath = (
  targetFolder: string,
  remotePath: string,
  fileName: string,
): string => {
  const mirrorSegments = normalizeRemotePath(remotePath).split("/");
  if (mirrorSegments.length === 0) {
    mirrorSegments.push(fileName);
  } else {
    mirrorSegments[mirrorSegments.length - 1] = fileName;
  }
  return `${normalizeRelativePath(targetFolder)}/${mirrorSegments
    .map(vaultSafeName)
    .join("/")}`;
};

const encodedRemoteId = (remoteId: string): string =>
  [...new TextEncoder().encode(remoteId)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const withRemoteIdSuffix = (path: string, remoteId: string): string => {
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const suffix = `~${encodedRemoteId(remoteId)}`;
  return dot > 0
    ? `${folder}${name.slice(0, dot)}${suffix}${name.slice(dot)}`
    : `${folder}${name}${suffix}`;
};

export const allocateMirrorPaths = (
  targetFolder: string,
  inputs: Iterable<FileMirror>,
): Map<string, string> => {
  const allocations = new Map<string, string>();
  for (const input of inputs) {
    allocations.set(
      input.file.id,
      mirrorFilePath(targetFolder, input.remotePath, input.file.fileName),
    );
  }

  while (true) {
    const groups = new Map<string, string[]>();
    for (const [remoteId, path] of allocations) {
      const key = path.toLocaleLowerCase();
      const group = groups.get(key) ?? [];
      group.push(remoteId);
      groups.set(key, group);
    }
    const collisions = [...groups.values()].filter(
      (remoteIds) => remoteIds.length > 1,
    );
    if (collisions.length === 0) {
      return allocations;
    }
    for (const remoteIds of collisions) {
      for (const remoteId of remoteIds) {
        allocations.set(
          remoteId,
          withRemoteIdSuffix(allocations.get(remoteId)!, remoteId),
        );
      }
    }
  }
};

const allocatedVaultPath = (
  targetFolder: string,
  input: FileMirror,
  manifest: SyncManifest,
): string => {
  const allocations = allocateMirrorPaths(targetFolder, [
    ...Object.values(manifest.files).map((entry) => ({
      file: {
        id: entry.remoteId,
        directoryId: entry.directoryId,
        fileName: entry.fileName,
        isFolder: false as const,
        md5: entry.md5,
        size: 0,
        createTime: 0,
        updateTime: entry.updateTime,
      },
      remotePath: entry.remotePath,
    })),
    input,
  ]);
  return (
    allocations.get(input.file.id) ??
    mirrorFilePath(targetFolder, input.remotePath, input.file.fileName)
  );
};

export class SyncService {
  private readonly cloud: CloudDownloadPort;
  private readonly vault: VaultStore;
  private readonly notebooks: NotebookSessionProvider;
  private readonly targetFolder: string;
  private readonly now: () => Date;
  private plannedVaultPaths = new Map<string, string>();

  constructor(options: SyncServiceOptions) {
    this.cloud = options.cloud;
    this.vault = options.vault;
    this.notebooks = options.notebooks;
    this.targetFolder = normalizeRelativePath(options.targetFolder);
    this.now = options.now ?? (() => new Date());
  }

  get manifestPath(): string {
    return `${this.targetFolder}/.sync-manifest.json`;
  }

  planMirrorPaths(inputs: Iterable<FileMirror>, manifest?: SyncManifest): void {
    const plannedInputs = new Map<string, FileMirror>();
    for (const input of inputs) {
      plannedInputs.set(input.file.id, input);
    }
    for (const entry of Object.values(manifest?.files ?? {})) {
      if (plannedInputs.has(entry.remoteId)) {
        continue;
      }
      plannedInputs.set(entry.remoteId, {
        file: {
          id: entry.remoteId,
          directoryId: entry.directoryId,
          fileName: entry.fileName,
          isFolder: false,
          md5: entry.md5,
          size: 0,
          createTime: 0,
          updateTime: entry.updateTime,
        },
        remotePath: entry.remotePath,
      });
    }
    this.plannedVaultPaths = allocateMirrorPaths(
      this.targetFolder,
      plannedInputs.values(),
    );
  }

  async mirrorFile(
    input: FileMirror,
    callerManifest?: SyncManifest,
  ): Promise<MirrorResult> {
    const manifest =
      callerManifest ?? (await loadManifest(this.vault, this.manifestPath));
    const existing = manifest.files[input.file.id];
    const remotePath = `/${normalizeRemotePath(input.remotePath)}`;
    const plannedVaultPath = this.plannedVaultPaths.get(input.file.id);
    const vaultPath =
      plannedVaultPath ??
      (existing?.remotePath === remotePath &&
      existing.vaultPath.startsWith(`${this.targetFolder}/`)
        ? existing.vaultPath
        : allocatedVaultPath(this.targetFolder, input, manifest));
    let localBytes = await this.vault.readBinary(vaultPath);
    if (plannedVaultPath && existing && existing.vaultPath !== vaultPath) {
      const previousBytes = await this.vault.readBinary(existing.vaultPath);
      if (
        previousBytes !== null &&
        !sameMd5(md5(previousBytes), existing.md5)
      ) {
        return {
          status: "protected",
          vaultPath: existing.vaultPath,
          ...(existing.pageCount !== undefined
            ? { pageCount: existing.pageCount }
            : {}),
        };
      }
      if (previousBytes !== null && localBytes === null) {
        await this.vault.writeBinary(vaultPath, previousBytes);
        await this.vault.delete(existing.vaultPath);
        localBytes = previousBytes;
        existing.vaultPath = vaultPath;
      }
    }
    if (
      localBytes !== null &&
      (!existing ||
        existing.vaultPath !== vaultPath ||
        !sameMd5(md5(localBytes), existing.md5))
    ) {
      return {
        status: "protected",
        vaultPath,
        ...(existing?.pageCount !== undefined
          ? { pageCount: existing.pageCount }
          : {}),
      };
    }
    let descriptor;
    try {
      descriptor = await this.cloud.getDownloadDescriptor(input.file.id);
    } catch (error) {
      throw this.downloadError(input.file, error);
    }

    if (
      existing &&
      sameMd5(existing.md5, descriptor.md5) &&
      existing.vaultPath === vaultPath &&
      localBytes !== null
    ) {
      return {
        status: "skipped",
        vaultPath,
        ...(existing.pageCount !== undefined
          ? { pageCount: existing.pageCount }
          : {}),
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.cloud.download(descriptor.url);
    } catch (error) {
      throw this.downloadError(input.file, error);
    }
    const isNote = input.file.fileName.toLocaleLowerCase().endsWith(".note");
    let pageCount: number | undefined;
    if (isNote) {
      const session = await this.notebooks.open({
        // These bytes have not entered the Mirror yet, so they are a
        // candidate source rather than a revision of the mirrored path.
        path: `candidate:${descriptor.md5}:${vaultPath}`,
        revision: descriptor.md5,
        bytes,
        transfer: "copy",
      });
      pageCount = session.descriptor.pageCount;
      session.close();
    }
    const entry: SyncManifestFile = {
      remoteId: input.file.id,
      directoryId: input.file.directoryId,
      fileName: input.file.fileName,
      remotePath,
      md5: descriptor.md5,
      updateTime: input.file.updateTime,
      vaultPath,
      syncedAt: this.now().toISOString(),
      ...(pageCount !== undefined ? { pageCount } : {}),
      ...(existing?.lastExport ? { lastExport: existing.lastExport } : {}),
      ...(existing?.watchHooks ? { watchHooks: existing.watchHooks } : {}),
    };

    await this.vault.writeBinary(vaultPath, bytes);
    manifest.files[input.file.id] = entry;
    if (!callerManifest) {
      await saveManifest(this.vault, this.manifestPath, manifest);
    }
    return {
      status: "mirrored",
      vaultPath,
      ...(pageCount !== undefined ? { pageCount } : {}),
    };
  }

  async removeMirroredFile(
    remoteId: string,
    callerManifest?: SyncManifest,
  ): Promise<MirroredFileRemovalResult | null> {
    const manifest =
      callerManifest ?? (await loadManifest(this.vault, this.manifestPath));
    const existing = manifest.files[remoteId];
    if (!existing) {
      return null;
    }

    const localBytes = await this.vault.readBinary(existing.vaultPath);
    if (localBytes !== null && !sameMd5(md5(localBytes), existing.md5)) {
      return {
        remotePath: existing.remotePath,
        vaultPath: existing.vaultPath,
        status: "protected",
      };
    }
    await this.vault.delete(existing.vaultPath);
    delete manifest.files[remoteId];
    this.plannedVaultPaths.delete(remoteId);
    if (!callerManifest) {
      await saveManifest(this.vault, this.manifestPath, manifest);
    }
    return {
      remotePath: existing.remotePath,
      vaultPath: existing.vaultPath,
      status: "removed",
    };
  }

  private downloadError(file: CloudFile, error: unknown): Error {
    const size = (file.size / (1024 * 1024)).toFixed(1);
    return new Error(
      `Download failed for ${file.fileName} (${size} MB): ${
        error instanceof Error ? error.message : "unknown cloud error"
      }`,
      { cause: error },
    );
  }
}
