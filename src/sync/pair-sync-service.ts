import type {
  CloudDownloadPort,
  CloudDirectory,
  CloudFile,
  CloudItem,
  CloudUploadPort,
} from "../cloud/types";
import { md5, sameMd5 } from "../shared/md5";
import { normalizeRelativePath, vaultSafeName } from "../shared/path";
import type { VaultStore } from "./vault-store";
import { localPathForRemote, remotePathForLocal } from "./writable-paths";

interface PairCloudPort extends CloudDownloadPort, CloudUploadPort {
  listDirectory(directoryId: string): Promise<CloudItem[]>;
  recycleItem(item: CloudItem): Promise<void>;
}

interface PairVaultPort extends VaultStore {
  createDirectory(path: string): Promise<void>;
  listDirectories(path: string): Promise<string[]>;
  move(from: string, to: string): Promise<void>;
}

interface PairSyncServiceOptions {
  cloud: PairCloudPort;
  vault: PairVaultPort;
  targetFolder: string;
  remoteFolder: string;
  remoteDirectoryId: string;
}

export interface PairBaselineEntry {
  localRelativePath: string;
  remoteRelativePath: string;
  remoteId: string;
  directoryId: string;
  fileName: string;
  checksum: string;
}

export interface PairBaselineDirectory {
  localRelativePath: string;
  remoteRelativePath: string;
  remoteId: string;
  directoryId: string;
  fileName: string;
}

export type PairConflictKind =
  | "both-edited"
  | "vault-edited-remote-deleted"
  | "vault-deleted-remote-edited"
  | "first-baseline-local-only"
  | "first-baseline-local-only-directory"
  | "first-baseline-different"
  | "ambiguous-rename";

export interface PairConflict {
  id: string;
  kind: PairConflictKind;
  localRelativePath: string;
  remoteRelativePath: string;
  localChecksum: string | null;
  remoteChecksum: string | null;
}

export interface PairBaseline {
  version: 1;
  initialized: boolean;
  entries: Record<string, PairBaselineEntry>;
  directories: Record<string, PairBaselineDirectory>;
  conflicts: Record<string, PairConflict>;
}

export interface PairSyncResult {
  baseline: PairBaseline;
  uploaded: string[];
  downloaded: string[];
  unchanged: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  movedLocal: string[];
  movedRemote: string[];
  createdLocalDirectories: string[];
  createdRemoteDirectories: string[];
  deletedLocalDirectories: string[];
  deletedRemoteDirectories: string[];
  conflicts: PairConflict[];
}

export type PairConflictResolution = "use-vault" | "use-remote" | "keep-both";

export interface PairSyncOptions {
  resolutions?: Readonly<Record<string, PairConflictResolution>>;
  onBaselineChange?: (baseline: PairBaseline) => Promise<void> | void;
}

interface RemoteFile {
  file: CloudFile;
  remoteRelativePath: string;
}

interface PairInventory {
  files: Map<string, RemoteFile>;
  directories: Map<string, CloudDirectory>;
}

interface LocalFile {
  checksum: string;
  bytes: Uint8Array;
}

export class PairInventoryIncompleteError extends Error {
  constructor(side: "Vault" | "Remote", cause: unknown) {
    super(
      `${side} inventory for the Paired folder is incomplete; no Pair changes were applied`,
      { cause },
    );
    this.name = "PairInventoryIncompleteError";
  }
}

export const emptyPairBaseline = (): PairBaseline => ({
  version: 1,
  initialized: false,
  entries: {},
  directories: {},
  conflicts: {},
});

const cloneBaseline = (baseline: PairBaseline): PairBaseline =>
  JSON.parse(JSON.stringify(baseline)) as PairBaseline;

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
};

const basename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const conflictId = (
  kind: PairConflictKind,
  localRelativePath: string,
  remoteRelativePath: string,
): string => `${kind}:${localRelativePath}:${remoteRelativePath}`;

export class PairSyncService {
  private readonly cloud: PairCloudPort;
  private readonly vault: PairVaultPort;
  private readonly vaultFolder: string;
  private readonly remoteFolder: string;
  private readonly remoteDirectoryId: string;

  constructor(options: PairSyncServiceOptions) {
    this.cloud = options.cloud;
    this.vault = options.vault;
    this.remoteFolder = normalizeRelativePath(options.remoteFolder);
    this.remoteDirectoryId = options.remoteDirectoryId;
    this.vaultFolder = `${normalizeRelativePath(
      options.targetFolder,
    )}/${this.remoteFolder.split("/").map(vaultSafeName).join("/")}`;
  }

  async reconcile(
    inputBaseline: PairBaseline,
    options: PairSyncOptions = {},
  ): Promise<PairSyncResult> {
    const baseline =
      inputBaseline.version === 1
        ? cloneBaseline(inputBaseline)
        : emptyPairBaseline();
    baseline.directories ??= {};
    const { files: localFiles, directories: localDirectories } =
      await this.inventoryVault();
    const { files: remoteFiles, directories: remoteDirectories } =
      await this.inventoryRemote();
    const remoteDirectoriesByLocalPath = new Map<string, CloudDirectory>();
    for (const [remotePath, directory] of remoteDirectories) {
      const localPath = this.vaultSafeRelativePath(remotePath);
      if (remoteDirectoriesByLocalPath.has(localPath)) {
        throw new PairInventoryIncompleteError(
          "Remote",
          new Error(`Remote directory paths collide at ${localPath}`),
        );
      }
      remoteDirectoriesByLocalPath.set(localPath, directory);
    }
    const remoteById = new Map(
      [...remoteFiles.values()].map((remote) => [remote.file.id, remote]),
    );
    const priorByLocalPath = new Map(Object.entries(baseline.entries));

    const remoteByLocalPath = new Map<string, RemoteFile>();
    for (const remote of remoteFiles.values()) {
      const prior = [...priorByLocalPath.values()].find(
        (entry) =>
          entry.remoteId === remote.file.id ||
          entry.remoteRelativePath === remote.remoteRelativePath,
      );
      const localRelativePath =
        prior?.localRelativePath ??
        this.vaultSafeRelativePath(
          localPathForRemote(remote.remoteRelativePath),
        );
      const collision = remoteByLocalPath.get(localRelativePath);
      if (collision || remoteDirectoriesByLocalPath.has(localRelativePath)) {
        throw new PairInventoryIncompleteError(
          "Remote",
          new Error(`Remote items collide at ${localRelativePath}`),
        );
      }
      remoteByLocalPath.set(localRelativePath, remote);
    }

    const result: PairSyncResult = {
      baseline,
      uploaded: [],
      downloaded: [],
      unchanged: [],
      deletedLocal: [],
      deletedRemote: [],
      movedLocal: [],
      movedRemote: [],
      createdLocalDirectories: [],
      createdRemoteDirectories: [],
      deletedLocalDirectories: [],
      deletedRemoteDirectories: [],
      conflicts: [],
    };
    const checkpoint = async (): Promise<void> => {
      await options.onBaselineChange?.(cloneBaseline(baseline));
    };
    const pendingDirectoryDeletions = await this.reconcileDirectoryCreations({
      baseline,
      localFiles,
      localDirectories,
      remoteDirectories: remoteDirectoriesByLocalPath,
      result,
      checkpoint,
      baselineWasInitialized: inputBaseline.initialized,
      previousConflicts: inputBaseline.conflicts,
      resolutions: options.resolutions ?? {},
    });
    const handledPaths = await this.reconcileVaultRenames({
      baseline,
      localFiles,
      remoteById,
      priorByLocalPath,
      result,
      checkpoint,
      resolutions: options.resolutions ?? {},
      previousConflicts: inputBaseline.conflicts,
    });

    const localPaths = new Set([
      ...localFiles.keys(),
      ...remoteByLocalPath.keys(),
      ...priorByLocalPath.keys(),
    ]);
    for (const localRelativePath of [...localPaths].sort()) {
      if (handledPaths.has(localRelativePath)) {
        continue;
      }
      for (const [id, conflict] of Object.entries(baseline.conflicts)) {
        if (conflict.localRelativePath === localRelativePath) {
          delete baseline.conflicts[id];
        }
      }
      const local = localFiles.get(localRelativePath);
      const prior = priorByLocalPath.get(localRelativePath);
      const remote =
        remoteByLocalPath.get(localRelativePath) ??
        (prior ? remoteById.get(prior.remoteId) : undefined);
      const remoteRelativePath =
        remote?.remoteRelativePath ??
        prior?.remoteRelativePath ??
        remotePathForLocal(localRelativePath);
      const displayPath = `${this.remoteFolder}/${remoteRelativePath}`;

      if (
        prior &&
        local &&
        remote &&
        remote.remoteRelativePath !== prior.remoteRelativePath
      ) {
        const destination = this.vaultSafeRelativePath(
          localPathForRemote(remote.remoteRelativePath),
        );
        if (!sameMd5(local.checksum, prior.checksum)) {
          this.addConflict(result, {
            kind: "ambiguous-rename",
            localRelativePath,
            remoteRelativePath,
            localChecksum: local.checksum,
            remoteChecksum: remote.file.md5,
          });
          continue;
        }
        if (localFiles.has(destination) && destination !== localRelativePath) {
          this.addConflict(result, {
            kind: "ambiguous-rename",
            localRelativePath,
            remoteRelativePath,
            localChecksum: local.checksum,
            remoteChecksum: remote.file.md5,
          });
          continue;
        }
        await this.vault.move(
          `${this.vaultFolder}/${localRelativePath}`,
          `${this.vaultFolder}/${destination}`,
        );
        delete baseline.entries[localRelativePath];
        let destinationChecksum = local.checksum;
        if (!sameMd5(remote.file.md5, prior.checksum)) {
          const bytes = await this.downloadRemote(remote.file);
          await this.vault.writeBinary(
            `${this.vaultFolder}/${destination}`,
            bytes,
          );
          destinationChecksum = md5(bytes);
          result.downloaded.push(
            `${this.remoteFolder}/${remote.remoteRelativePath}`,
          );
        }
        baseline.entries[destination] = this.entry(
          destination,
          remote,
          destinationChecksum,
        );
        result.movedLocal.push(
          `${this.remoteFolder}/${prior.remoteRelativePath} → ` +
            `${this.remoteFolder}/${remote.remoteRelativePath}`,
        );
        await checkpoint();
        continue;
      }
      const existingConflict = Object.values(inputBaseline.conflicts).find(
        (conflict) => conflict.localRelativePath === localRelativePath,
      );
      const resolution = existingConflict
        ? options.resolutions?.[existingConflict.id]
        : undefined;
      if (existingConflict && resolution) {
        await this.resolveConflict({
          conflict: existingConflict,
          resolution,
          local,
          remote,
          displayPath,
          result,
        });
        await checkpoint();
        continue;
      }

      if (!prior) {
        await this.reconcileWithoutBaseline({
          baselineWasInitialized: inputBaseline.initialized,
          previousConflicts: inputBaseline.conflicts,
          localRelativePath,
          remoteRelativePath,
          local,
          remote,
          displayPath,
          result,
        });
        await checkpoint();
        continue;
      }

      if (!local && !remote) {
        delete baseline.entries[localRelativePath];
        continue;
      }

      if (!local && remote) {
        if (sameMd5(remote.file.md5, prior.checksum)) {
          await this.cloud.recycleItem(remote.file);
          delete baseline.entries[localRelativePath];
          result.deletedRemote.push(displayPath);
          await checkpoint();
        } else {
          this.addConflict(result, {
            kind: "vault-deleted-remote-edited",
            localRelativePath,
            remoteRelativePath,
            localChecksum: null,
            remoteChecksum: remote.file.md5,
          });
        }
        continue;
      }

      if (local && !remote) {
        if (sameMd5(local.checksum, prior.checksum)) {
          await this.vault.delete(`${this.vaultFolder}/${localRelativePath}`);
          delete baseline.entries[localRelativePath];
          result.deletedLocal.push(displayPath);
          await checkpoint();
        } else {
          this.addConflict(result, {
            kind: "vault-edited-remote-deleted",
            localRelativePath,
            remoteRelativePath,
            localChecksum: local.checksum,
            remoteChecksum: null,
          });
        }
        continue;
      }

      if (!local || !remote) {
        continue;
      }

      if (sameMd5(local.checksum, remote.file.md5)) {
        baseline.entries[localRelativePath] = this.entry(
          localRelativePath,
          remote,
          local.checksum,
        );
        result.unchanged.push(displayPath);
        await checkpoint();
        continue;
      }

      const localChanged = !sameMd5(local.checksum, prior.checksum);
      const remoteChanged = !sameMd5(remote.file.md5, prior.checksum);
      if (localChanged && remoteChanged) {
        this.addConflict(result, {
          kind: "both-edited",
          localRelativePath,
          remoteRelativePath,
          localChecksum: local.checksum,
          remoteChecksum: remote.file.md5,
        });
      } else if (localChanged) {
        const replacement = await this.replaceRemote(remote, local.bytes);
        baseline.entries[localRelativePath] = this.entry(
          localRelativePath,
          replacement,
          local.checksum,
        );
        result.uploaded.push(displayPath);
        await checkpoint();
      } else if (remoteChanged) {
        const bytes = await this.downloadRemote(remote.file);
        await this.vault.writeBinary(
          `${this.vaultFolder}/${localRelativePath}`,
          bytes,
        );
        baseline.entries[localRelativePath] = this.entry(
          localRelativePath,
          remote,
          md5(bytes),
        );
        result.downloaded.push(displayPath);
        await checkpoint();
      } else {
        result.unchanged.push(displayPath);
      }
    }

    await this.reconcileDirectoryDeletions({
      baseline,
      localDirectories,
      remoteDirectories,
      pending: pendingDirectoryDeletions,
      result,
      checkpoint,
    });
    baseline.initialized = true;
    await checkpoint();
    return result;
  }

  private async reconcileDirectoryCreations({
    baseline,
    localFiles,
    localDirectories,
    remoteDirectories,
    result,
    checkpoint,
    baselineWasInitialized,
    previousConflicts,
    resolutions,
  }: {
    baseline: PairBaseline;
    localFiles: ReadonlyMap<string, LocalFile>;
    localDirectories: ReadonlySet<string>;
    remoteDirectories: ReadonlyMap<string, CloudDirectory>;
    result: PairSyncResult;
    checkpoint: () => Promise<void>;
    baselineWasInitialized: boolean;
    previousConflicts: Readonly<Record<string, PairConflict>>;
    resolutions: Readonly<Record<string, PairConflictResolution>>;
  }): Promise<Set<string>> {
    const pendingDeletions = new Set<string>();
    const paths = new Set([
      ...localDirectories,
      ...remoteDirectories.keys(),
      ...Object.keys(baseline.directories),
    ]);
    for (const path of [...paths].sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right),
    )) {
      const local = localDirectories.has(path);
      const remote = remoteDirectories.get(path);
      const prior = baseline.directories[path];
      if (prior && (!local || !remote)) {
        pendingDeletions.add(path);
        continue;
      }
      if (local && remote) {
        baseline.directories[path] = this.directoryEntry(path, remote);
        continue;
      }
      if (remote) {
        await this.vault.createDirectory(`${this.vaultFolder}/${path}`);
        baseline.directories[path] = this.directoryEntry(path, remote);
        result.createdLocalDirectories.push(`${this.remoteFolder}/${path}`);
        await checkpoint();
        continue;
      }
      if (local) {
        const childPrefix = `${path}/`;
        const nonEmpty =
          [...localFiles.keys()].some((file) => file.startsWith(childPrefix)) ||
          [...localDirectories].some(
            (directory) =>
              directory !== path && directory.startsWith(childPrefix),
          );
        if (nonEmpty) {
          continue;
        }
        const priorConflict = Object.values(previousConflicts).find(
          (conflict) =>
            conflict.kind === "first-baseline-local-only-directory" &&
            conflict.localRelativePath === path,
        );
        const resolution = priorConflict
          ? resolutions[priorConflict.id]
          : undefined;
        if (
          (!baselineWasInitialized || priorConflict) &&
          resolution === undefined
        ) {
          this.addConflict(result, {
            kind: "first-baseline-local-only-directory",
            localRelativePath: path,
            remoteRelativePath: path,
            localChecksum: null,
            remoteChecksum: null,
          });
          await checkpoint();
          continue;
        }
        if (resolution === "use-remote") {
          await this.vault.delete(`${this.vaultFolder}/${path}`);
          result.deletedLocalDirectories.push(`${this.remoteFolder}/${path}`);
          delete baseline.conflicts[priorConflict!.id];
          await checkpoint();
          continue;
        }
        const created = await this.createRemoteDirectory(path);
        baseline.directories[path] = this.directoryEntry(path, created);
        if (priorConflict) {
          delete baseline.conflicts[priorConflict.id];
        }
        result.createdRemoteDirectories.push(`${this.remoteFolder}/${path}`);
        await checkpoint();
      }
    }
    return pendingDeletions;
  }

  private async reconcileDirectoryDeletions({
    baseline,
    localDirectories,
    remoteDirectories,
    pending,
    result,
    checkpoint,
  }: {
    baseline: PairBaseline;
    localDirectories: ReadonlySet<string>;
    remoteDirectories: ReadonlyMap<string, CloudDirectory>;
    pending: ReadonlySet<string>;
    result: PairSyncResult;
    checkpoint: () => Promise<void>;
  }): Promise<void> {
    for (const path of [...pending].sort(
      (left, right) =>
        right.split("/").length - left.split("/").length ||
        right.localeCompare(left),
    )) {
      const local = localDirectories.has(path);
      const remote = remoteDirectories.get(path);
      const childPrefix = `${path}/`;
      const hasTrackedChild =
        Object.keys(baseline.entries).some(
          (entryPath) =>
            entryPath === path || entryPath.startsWith(childPrefix),
        ) ||
        Object.values(baseline.conflicts).some((conflict) =>
          conflict.localRelativePath.startsWith(childPrefix),
        );
      if (hasTrackedChild) {
        continue;
      }
      if (!local && remote) {
        await this.cloud.recycleItem(remote);
        result.deletedRemoteDirectories.push(`${this.remoteFolder}/${path}`);
      } else if (local && !remote) {
        await this.vault.delete(`${this.vaultFolder}/${path}`);
        result.deletedLocalDirectories.push(`${this.remoteFolder}/${path}`);
      }
      delete baseline.directories[path];
      await checkpoint();
    }
  }

  private async reconcileVaultRenames({
    baseline,
    localFiles,
    remoteById,
    priorByLocalPath,
    result,
    checkpoint,
    resolutions,
    previousConflicts,
  }: {
    baseline: PairBaseline;
    localFiles: ReadonlyMap<string, LocalFile>;
    remoteById: ReadonlyMap<string, RemoteFile>;
    priorByLocalPath: ReadonlyMap<string, PairBaselineEntry>;
    result: PairSyncResult;
    checkpoint: () => Promise<void>;
    resolutions: Readonly<Record<string, PairConflictResolution>>;
    previousConflicts: Readonly<Record<string, PairConflict>>;
  }): Promise<Set<string>> {
    const handled = new Set<string>();
    const untrackedLocalPaths = [...localFiles.keys()].filter(
      (path) => !priorByLocalPath.has(path),
    );
    for (const [oldLocalPath, prior] of priorByLocalPath) {
      if (localFiles.has(oldLocalPath)) {
        continue;
      }
      const remote = remoteById.get(prior.remoteId);
      if (
        !remote ||
        remote.remoteRelativePath !== prior.remoteRelativePath ||
        !sameMd5(remote.file.md5, prior.checksum)
      ) {
        continue;
      }
      const candidates = untrackedLocalPaths.filter((path) => {
        const local = localFiles.get(path);
        return (
          !handled.has(path) &&
          local !== undefined &&
          sameMd5(local.checksum, prior.checksum)
        );
      });
      if (candidates.length === 0) {
        continue;
      }
      if (candidates.length > 1) {
        const previousConflict = Object.values(previousConflicts).find(
          (conflict) =>
            conflict.kind === "ambiguous-rename" &&
            conflict.localRelativePath === oldLocalPath,
        );
        const resolution = previousConflict
          ? resolutions[previousConflict.id]
          : undefined;
        if (resolution === "use-remote") {
          const bytes = await this.downloadRemote(remote.file);
          await this.vault.writeBinary(
            `${this.vaultFolder}/${oldLocalPath}`,
            bytes,
          );
          baseline.entries[oldLocalPath] = this.entry(
            oldLocalPath,
            remote,
            md5(bytes),
          );
          delete baseline.conflicts[previousConflict!.id];
          result.downloaded.push(
            `${this.remoteFolder}/${prior.remoteRelativePath}`,
          );
          await checkpoint();
          for (const path of candidates) {
            await this.vault.delete(`${this.vaultFolder}/${path}`);
            handled.add(path);
          }
          await checkpoint();
          handled.add(oldLocalPath);
          continue;
        }
        if (resolution === "keep-both") {
          const bytes = await this.downloadRemote(remote.file);
          await this.vault.writeBinary(
            `${this.vaultFolder}/${oldLocalPath}`,
            bytes,
          );
          baseline.entries[oldLocalPath] = this.entry(
            oldLocalPath,
            remote,
            md5(bytes),
          );
          delete baseline.conflicts[previousConflict!.id];
          result.downloaded.push(
            `${this.remoteFolder}/${prior.remoteRelativePath}`,
          );
          await checkpoint();
          handled.add(oldLocalPath);
          continue;
        }
        if (resolution === "use-vault") {
          const chosen = [...candidates].sort()[0]!;
          const chosenLocal = localFiles.get(chosen)!;
          const nextRemotePath = remotePathForLocal(chosen);
          const uploaded = await this.uploadLocal(
            nextRemotePath,
            chosenLocal.bytes,
          );
          await this.cloud.recycleItem(remote.file);
          delete baseline.entries[oldLocalPath];
          delete baseline.conflicts[previousConflict!.id];
          baseline.entries[chosen] = this.entry(
            chosen,
            uploaded,
            chosenLocal.checksum,
          );
          result.movedRemote.push(
            `${this.remoteFolder}/${prior.remoteRelativePath} → ` +
              `${this.remoteFolder}/${nextRemotePath}`,
          );
          await checkpoint();
          handled.add(oldLocalPath);
          handled.add(chosen);
          continue;
        }
        this.addConflict(result, {
          kind: "ambiguous-rename",
          localRelativePath: oldLocalPath,
          remoteRelativePath: prior.remoteRelativePath,
          localChecksum: prior.checksum,
          remoteChecksum: remote.file.md5,
        });
        handled.add(oldLocalPath);
        candidates.forEach((path) => handled.add(path));
        continue;
      }

      const nextLocalPath = candidates[0]!;
      const local = localFiles.get(nextLocalPath)!;
      const nextRemotePath = remotePathForLocal(nextLocalPath);
      const uploaded = await this.uploadLocal(nextRemotePath, local.bytes);
      await this.cloud.recycleItem(remote.file);
      delete baseline.entries[oldLocalPath];
      baseline.entries[nextLocalPath] = this.entry(
        nextLocalPath,
        uploaded,
        local.checksum,
      );
      delete baseline.conflicts[
        conflictId("ambiguous-rename", oldLocalPath, prior.remoteRelativePath)
      ];
      result.movedRemote.push(
        `${this.remoteFolder}/${prior.remoteRelativePath} → ` +
          `${this.remoteFolder}/${nextRemotePath}`,
      );
      await checkpoint();
      handled.add(oldLocalPath);
      handled.add(nextLocalPath);
    }
    return handled;
  }

  private async resolveConflict({
    conflict,
    resolution,
    local,
    remote,
    displayPath,
    result,
  }: {
    conflict: PairConflict;
    resolution: PairConflictResolution;
    local: LocalFile | undefined;
    remote: RemoteFile | undefined;
    displayPath: string;
    result: PairSyncResult;
  }): Promise<void> {
    const { localRelativePath, remoteRelativePath } = conflict;
    if (resolution === "use-vault") {
      if (!local) {
        if (remote) {
          await this.cloud.recycleItem(remote.file);
          result.deletedRemote.push(displayPath);
        }
        delete result.baseline.entries[localRelativePath];
        return;
      }
      const uploaded = remote
        ? await this.replaceRemote(remote, local.bytes)
        : await this.uploadLocal(remoteRelativePath, local.bytes);
      result.baseline.entries[localRelativePath] = this.entry(
        localRelativePath,
        uploaded,
        local.checksum,
      );
      result.uploaded.push(displayPath);
      return;
    }

    if (resolution === "use-remote") {
      if (!remote) {
        if (local) {
          await this.vault.delete(`${this.vaultFolder}/${localRelativePath}`);
          result.deletedLocal.push(displayPath);
        }
        delete result.baseline.entries[localRelativePath];
        return;
      }
      const bytes = await this.downloadRemote(remote.file);
      await this.vault.writeBinary(
        `${this.vaultFolder}/${localRelativePath}`,
        bytes,
      );
      result.baseline.entries[localRelativePath] = this.entry(
        localRelativePath,
        remote,
        md5(bytes),
      );
      result.downloaded.push(displayPath);
      return;
    }

    if (local && remote) {
      const copyLocalPath = await this.availableConflictCopyPath(
        localRelativePath,
        local.checksum,
        local.bytes,
      );
      const copyRemotePath = remotePathForLocal(copyLocalPath);
      const uploaded = await this.ensureUploadedLocal(
        copyRemotePath,
        local.bytes,
      );
      const remoteBytes = await this.downloadRemote(remote.file);
      const existingCopy = await this.vault.readBinary(
        `${this.vaultFolder}/${copyLocalPath}`,
      );
      if (existingCopy === null) {
        await this.vault.writeBinary(
          `${this.vaultFolder}/${copyLocalPath}`,
          local.bytes,
        );
      }
      await this.vault.writeBinary(
        `${this.vaultFolder}/${localRelativePath}`,
        remoteBytes,
      );
      result.baseline.entries[localRelativePath] = this.entry(
        localRelativePath,
        remote,
        md5(remoteBytes),
      );
      result.baseline.entries[copyLocalPath] = this.entry(
        copyLocalPath,
        uploaded,
        local.checksum,
      );
      result.uploaded.push(`${this.remoteFolder}/${copyRemotePath}`);
      result.downloaded.push(displayPath);
      return;
    }

    // When only the edited side remains, keeping both means accepting the
    // surviving edit while preserving the other side's deletion.
    if (local) {
      const uploaded = await this.uploadLocal(remoteRelativePath, local.bytes);
      result.baseline.entries[localRelativePath] = this.entry(
        localRelativePath,
        uploaded,
        local.checksum,
      );
      result.uploaded.push(displayPath);
    } else if (remote) {
      const bytes = await this.downloadRemote(remote.file);
      await this.vault.writeBinary(
        `${this.vaultFolder}/${localRelativePath}`,
        bytes,
      );
      result.baseline.entries[localRelativePath] = this.entry(
        localRelativePath,
        remote,
        md5(bytes),
      );
      result.downloaded.push(displayPath);
    }
  }

  private async reconcileWithoutBaseline({
    baselineWasInitialized,
    previousConflicts,
    localRelativePath,
    remoteRelativePath,
    local,
    remote,
    displayPath,
    result,
  }: {
    baselineWasInitialized: boolean;
    previousConflicts: Readonly<Record<string, PairConflict>>;
    localRelativePath: string;
    remoteRelativePath: string;
    local: LocalFile | undefined;
    remote: RemoteFile | undefined;
    displayPath: string;
    result: PairSyncResult;
  }): Promise<void> {
    if (!local && !remote) {
      return;
    }
    if (local && remote) {
      if (sameMd5(local.checksum, remote.file.md5)) {
        result.baseline.entries[localRelativePath] = this.entry(
          localRelativePath,
          remote,
          local.checksum,
        );
        result.unchanged.push(displayPath);
      } else {
        this.addConflict(result, {
          kind: "first-baseline-different",
          localRelativePath,
          remoteRelativePath,
          localChecksum: local.checksum,
          remoteChecksum: remote.file.md5,
        });
      }
      return;
    }
    if (remote) {
      const bytes = await this.downloadRemote(remote.file);
      await this.vault.writeBinary(
        `${this.vaultFolder}/${localRelativePath}`,
        bytes,
      );
      result.baseline.entries[localRelativePath] = this.entry(
        localRelativePath,
        remote,
        md5(bytes),
      );
      result.downloaded.push(displayPath);
      return;
    }
    if (!local) {
      return;
    }

    const previousLocalOnlyConflict = Object.values(previousConflicts).some(
      (conflict) =>
        conflict.kind === "first-baseline-local-only" &&
        conflict.localRelativePath === localRelativePath,
    );
    if (!baselineWasInitialized || previousLocalOnlyConflict) {
      this.addConflict(result, {
        kind: "first-baseline-local-only",
        localRelativePath,
        remoteRelativePath,
        localChecksum: local.checksum,
        remoteChecksum: null,
      });
      return;
    }

    const uploaded = await this.uploadLocal(remoteRelativePath, local.bytes);
    result.baseline.entries[localRelativePath] = this.entry(
      localRelativePath,
      uploaded,
      local.checksum,
    );
    result.uploaded.push(displayPath);
  }

  private addConflict(
    result: PairSyncResult,
    conflict: Omit<PairConflict, "id">,
  ): void {
    const complete: PairConflict = {
      ...conflict,
      id: conflictId(
        conflict.kind,
        conflict.localRelativePath,
        conflict.remoteRelativePath,
      ),
    };
    result.baseline.conflicts[complete.id] = complete;
    result.conflicts.push(complete);
  }

  private async inventoryVault(): Promise<{
    files: Map<string, LocalFile>;
    directories: Set<string>;
  }> {
    try {
      const files = new Map<string, LocalFile>();
      for (const path of await this.vault.listFiles(this.vaultFolder)) {
        const prefix = `${this.vaultFolder}/`;
        if (!path.startsWith(prefix)) {
          continue;
        }
        const relativePath = normalizeRelativePath(path.slice(prefix.length));
        const bytes = await this.vault.readBinary(path);
        if (bytes === null) {
          throw new Error(`${path} disappeared while it was being indexed`);
        }
        files.set(relativePath, { checksum: md5(bytes), bytes });
      }
      const directories = new Set<string>();
      const prefix = `${this.vaultFolder}/`;
      for (const path of await this.vault.listDirectories(this.vaultFolder)) {
        if (path.startsWith(prefix)) {
          directories.add(normalizeRelativePath(path.slice(prefix.length)));
        }
      }
      return { files, directories };
    } catch (error) {
      throw new PairInventoryIncompleteError("Vault", error);
    }
  }

  private async inventoryRemote(): Promise<PairInventory> {
    try {
      const files = new Map<string, RemoteFile>();
      const directories = new Map<string, CloudDirectory>();
      await this.scanRemote(this.remoteDirectoryId, "", files, directories);
      return { files, directories };
    } catch (error) {
      throw new PairInventoryIncompleteError("Remote", error);
    }
  }

  private async scanRemote(
    directoryId: string,
    relativeFolder: string,
    files: Map<string, RemoteFile>,
    directories: Map<string, CloudDirectory>,
  ): Promise<void> {
    for (const item of await this.cloud.listDirectory(directoryId)) {
      const path = relativeFolder
        ? `${relativeFolder}/${item.fileName}`
        : item.fileName;
      if (item.isFolder) {
        if (directories.has(path) || files.has(path)) {
          throw new Error(`Supernote listed more than one item at ${path}`);
        }
        directories.set(path, item as CloudDirectory);
        await this.scanRemote(item.id, path, files, directories);
      } else {
        if (files.has(path) || directories.has(path)) {
          throw new Error(`Supernote listed more than one file at ${path}`);
        }
        files.set(path, {
          file: item as CloudFile,
          remoteRelativePath: path,
        });
      }
    }
  }

  private async downloadRemote(file: CloudFile): Promise<Uint8Array> {
    const descriptor = await this.cloud.getDownloadDescriptor(file.id);
    const bytes = await this.cloud.download(descriptor.url);
    if (!sameMd5(md5(bytes), descriptor.md5)) {
      throw new Error(
        `Supernote download checksum did not match ${file.fileName}`,
      );
    }
    return bytes;
  }

  private async replaceRemote(
    remote: RemoteFile,
    bytes: Uint8Array,
  ): Promise<RemoteFile> {
    await this.cloud.replaceFile(remote.file, bytes);
    const expected = md5(bytes);
    const replacement = (
      await this.cloud.listDirectory(remote.file.directoryId)
    )
      .filter(
        (item): item is CloudFile =>
          !item.isFolder &&
          item.fileName === remote.file.fileName &&
          sameMd5(item.md5, expected),
      )
      .sort((left, right) => right.updateTime - left.updateTime)[0];
    if (!replacement) {
      throw new Error(
        `Supernote replaced ${remote.file.fileName} but did not list its verified version`,
      );
    }
    return {
      file: replacement,
      remoteRelativePath: remote.remoteRelativePath,
    };
  }

  private async uploadLocal(
    remoteRelativePath: string,
    bytes: Uint8Array,
  ): Promise<RemoteFile> {
    const folder = parentPath(remoteRelativePath);
    const directoryId = folder
      ? await this.ensureRemoteDirectory(folder)
      : this.remoteDirectoryId;
    const fileName = basename(remoteRelativePath);
    await this.cloud.uploadFile(directoryId, fileName, bytes);
    const expected = md5(bytes);
    const uploaded = (await this.cloud.listDirectory(directoryId))
      .filter(
        (item): item is CloudFile =>
          !item.isFolder &&
          item.fileName === fileName &&
          sameMd5(item.md5, expected),
      )
      .sort((left, right) => right.updateTime - left.updateTime)[0];
    if (!uploaded) {
      throw new Error(
        `Supernote accepted ${fileName} but did not list its verified upload`,
      );
    }
    return { file: uploaded, remoteRelativePath };
  }

  private async ensureUploadedLocal(
    remoteRelativePath: string,
    bytes: Uint8Array,
  ): Promise<RemoteFile> {
    const folder = parentPath(remoteRelativePath);
    const directoryId = folder
      ? await this.ensureRemoteDirectory(folder)
      : this.remoteDirectoryId;
    const fileName = basename(remoteRelativePath);
    const checksum = md5(bytes);
    const existing = (await this.cloud.listDirectory(directoryId)).find(
      (item): item is CloudFile =>
        !item.isFolder &&
        item.fileName === fileName &&
        sameMd5(item.md5, checksum),
    );
    return existing
      ? { file: existing, remoteRelativePath }
      : this.uploadLocal(remoteRelativePath, bytes);
  }

  private async ensureRemoteDirectory(relativePath: string): Promise<string> {
    let directoryId = this.remoteDirectoryId;
    for (const segment of normalizeRelativePath(relativePath).split("/")) {
      let items = await this.cloud.listDirectory(directoryId);
      let directory = items.find(
        (item) => item.isFolder && item.fileName === segment,
      );
      if (!directory) {
        await this.cloud.createDirectory(directoryId, segment);
        items = await this.cloud.listDirectory(directoryId);
        directory = items.find(
          (item) => item.isFolder && item.fileName === segment,
        );
      }
      if (!directory?.isFolder) {
        throw new Error(`Supernote did not create ${relativePath}`);
      }
      directoryId = directory.id;
    }
    return directoryId;
  }

  private async createRemoteDirectory(
    relativePath: string,
  ): Promise<CloudDirectory> {
    const folder = parentPath(relativePath);
    const parentDirectoryId = folder
      ? await this.ensureRemoteDirectory(folder)
      : this.remoteDirectoryId;
    const fileName = basename(relativePath);
    let directory = (await this.cloud.listDirectory(parentDirectoryId)).find(
      (item): item is CloudDirectory =>
        item.isFolder && item.fileName === fileName,
    );
    if (!directory) {
      await this.cloud.createDirectory(parentDirectoryId, fileName);
      directory = (await this.cloud.listDirectory(parentDirectoryId)).find(
        (item): item is CloudDirectory =>
          item.isFolder && item.fileName === fileName,
      );
    }
    if (!directory) {
      throw new Error(
        `Supernote accepted ${fileName} but did not list its directory`,
      );
    }
    return directory;
  }

  private directoryEntry(
    localRelativePath: string,
    remote: CloudDirectory,
  ): PairBaselineDirectory {
    return {
      localRelativePath,
      remoteRelativePath: localRelativePath,
      remoteId: remote.id,
      directoryId: remote.directoryId,
      fileName: remote.fileName,
    };
  }

  private entry(
    localRelativePath: string,
    remote: RemoteFile,
    checksum: string,
  ): PairBaselineEntry {
    return {
      localRelativePath,
      remoteRelativePath: remote.remoteRelativePath,
      remoteId: remote.file.id,
      directoryId: remote.file.directoryId,
      fileName: remote.file.fileName,
      checksum,
    };
  }

  private async availableConflictCopyPath(
    path: string,
    checksum: string,
    bytes: Uint8Array,
  ): Promise<string> {
    for (let copy = 1; copy < 10_000; copy += 1) {
      const candidate = this.conflictCopyPath(path, checksum, copy);
      const existing = await this.vault.readBinary(
        `${this.vaultFolder}/${candidate}`,
      );
      const remote = await this.findRemoteFile(remotePathForLocal(candidate));
      const expected = md5(bytes);
      if (
        (existing === null || sameMd5(md5(existing), expected)) &&
        (!remote || sameMd5(remote.file.md5, expected))
      ) {
        return candidate;
      }
    }
    throw new Error(`Could not allocate a conflict copy for ${path}`);
  }

  private async findRemoteFile(
    remoteRelativePath: string,
  ): Promise<RemoteFile | undefined> {
    const folder = parentPath(remoteRelativePath);
    let directoryId = this.remoteDirectoryId;
    if (folder) {
      for (const segment of folder.split("/")) {
        const directory = (await this.cloud.listDirectory(directoryId)).find(
          (item) => item.isFolder && item.fileName === segment,
        );
        if (!directory?.isFolder) {
          return undefined;
        }
        directoryId = directory.id;
      }
    }
    const fileName = basename(remoteRelativePath);
    const matches = (await this.cloud.listDirectory(directoryId)).filter(
      (item): item is CloudFile => !item.isFolder && item.fileName === fileName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Supernote listed more than one file at ${remoteRelativePath}`,
      );
    }
    return matches[0] ? { file: matches[0], remoteRelativePath } : undefined;
  }

  private conflictCopyPath(
    path: string,
    checksum: string,
    copy: number,
  ): string {
    const slash = path.lastIndexOf("/");
    const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const extensionAt = name.lastIndexOf(".");
    const extension = extensionAt > 0 ? name.slice(extensionAt) : "";
    const stem = extensionAt > 0 ? name.slice(0, extensionAt) : name;
    const suffix = copy === 1 ? "" : ` ${copy}`;
    return `${folder}${stem} (Vault ${checksum.slice(0, 8)}${suffix})${extension}`;
  }

  private vaultSafeRelativePath(path: string): string {
    return normalizeRelativePath(path).split("/").map(vaultSafeName).join("/");
  }
}
