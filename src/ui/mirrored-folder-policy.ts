import {
  normalizeOptionalRelativePath,
  normalizeRelativePath,
  vaultSafeName,
} from "../shared/path";
import type { SyncManifest, SyncManifestFile } from "../sync/manifest";

export interface MirroredCloudFolder {
  directoryId: string;
  remotePath: string;
}

const normalizeCloudPath = (path: string): string =>
  `/${normalizeOptionalRelativePath(path)}`;

export const remotePathIsAtOrBelow = (path: string, root: string): boolean => {
  const normalizedPath = normalizeCloudPath(path);
  const normalizedRoot = normalizeCloudPath(root);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
};

export const coveringMirroredFolder = (
  folders: readonly MirroredCloudFolder[],
  remotePath: string,
): MirroredCloudFolder | null =>
  folders
    .filter((folder) => remotePathIsAtOrBelow(remotePath, folder.remotePath))
    .sort(
      (left, right) =>
        normalizeCloudPath(right.remotePath).length -
        normalizeCloudPath(left.remotePath).length,
    )[0] ?? null;

export const selectMirroredFolder = (
  folders: readonly MirroredCloudFolder[],
  selected: MirroredCloudFolder,
): MirroredCloudFolder[] => {
  if (coveringMirroredFolder(folders, selected.remotePath)) {
    return [...folders];
  }
  const normalizedSelected: MirroredCloudFolder = {
    directoryId: selected.directoryId,
    remotePath: normalizeCloudPath(selected.remotePath),
  };
  return [
    ...folders.filter(
      (folder) =>
        !remotePathIsAtOrBelow(
          folder.remotePath,
          normalizedSelected.remotePath,
        ),
    ),
    normalizedSelected,
  ];
};

export const removeMirroredFolder = (
  folders: readonly MirroredCloudFolder[],
  removed: MirroredCloudFolder,
): MirroredCloudFolder[] => {
  const normalizedRemoved = normalizeCloudPath(removed.remotePath);
  return folders.filter(
    (folder) =>
      !(
        folder.directoryId === removed.directoryId ||
        normalizeCloudPath(folder.remotePath) === normalizedRemoved
      ),
  );
};

interface UncoveredEntriesOptions {
  manifest: SyncManifest;
  removed: MirroredCloudFolder;
  remaining: readonly MirroredCloudFolder[];
  protectedRemoteFolders?: readonly string[];
}

export const uncoveredEntriesAfterRemovingFolder = ({
  manifest,
  removed,
  remaining,
  protectedRemoteFolders = [],
}: UncoveredEntriesOptions): SyncManifestFile[] =>
  Object.values(manifest.files).filter(
    (entry) =>
      remotePathIsAtOrBelow(entry.remotePath, removed.remotePath) &&
      !coveringMirroredFolder(remaining, entry.remotePath) &&
      !protectedRemoteFolders.some((folder) =>
        remotePathIsAtOrBelow(entry.remotePath, folder),
      ),
  );

export const matchesUncoveredEntrySnapshot = (
  entries: readonly SyncManifestFile[],
  remoteIds: readonly string[],
): boolean => {
  const expected = new Set(remoteIds);
  return (
    entries.length === expected.size &&
    entries.every((entry) => expected.has(entry.remoteId))
  );
};

const mirroredVaultFolderPath = (
  targetFolder: string,
  remotePath: string,
): string => {
  const remoteSegments = normalizeOptionalRelativePath(remotePath)
    .split("/")
    .filter(Boolean)
    .map(vaultSafeName);
  return [normalizeRelativePath(targetFolder), ...remoteSegments].join("/");
};

export const mirroredVaultFolderPaths = (
  targetFolder: string,
  folders: readonly MirroredCloudFolder[],
): string[] =>
  folders.map((folder) =>
    mirroredVaultFolderPath(targetFolder, folder.remotePath),
  );

export const syncedVaultFolderPaths = (
  targetFolder: string,
  mirroredFolders: readonly MirroredCloudFolder[],
  pairedFolder: string | null,
): string[] => {
  const paths = mirroredVaultFolderPaths(targetFolder, mirroredFolders);
  if (pairedFolder && normalizeOptionalRelativePath(pairedFolder)) {
    paths.push(mirroredVaultFolderPath(targetFolder, pairedFolder));
  }
  return [...new Set(paths)];
};

export const describeMirroredFolders = (
  folders: readonly MirroredCloudFolder[],
): string => {
  if (folders.length === 0) {
    return "No folders mirrored yet. Browse Supernote Cloud to choose one.";
  }
  const names = folders.map(
    (folder) =>
      normalizeOptionalRelativePath(folder.remotePath)
        .split("/")
        .filter(Boolean)
        .at(-1) ?? "Supernote Cloud",
  );
  const shown = names.slice(0, 3).join(", ");
  const remaining = names.length - 3;
  return `${folders.length} folder${folders.length === 1 ? "" : "s"} mirrored: ${shown}${
    remaining > 0 ? `, and ${remaining} more` : ""
  }.`;
};
