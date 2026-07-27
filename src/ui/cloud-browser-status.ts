import type { CloudItem } from "../cloud/types";
import { sameMd5 } from "../shared/md5";
import { normalizeOptionalRelativePath } from "../shared/path";
import type { SyncManifest } from "../sync/manifest";
import {
  coveringMirroredFolder,
  type MirroredCloudFolder,
} from "./mirrored-folder-policy";

export type { MirroredCloudFolder } from "./mirrored-folder-policy";

export type CloudBrowserSyncStatus =
  | "not-synced"
  | "mirrored"
  | "included"
  | "downloaded"
  | "update-available"
  | "writable-sync";

interface CloudBrowserStatusIndexOptions {
  mirroredFolders: readonly MirroredCloudFolder[];
  pushFolder: string | null;
  manifest: SyncManifest;
}

const normalizeCloudPath = (path: string): string =>
  `/${normalizeOptionalRelativePath(path)}`;

const isAtOrBelow = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export class CloudBrowserStatusIndex {
  private readonly mirroredFolderList: readonly MirroredCloudFolder[];
  private readonly mirroredFolderIds: Set<string>;
  private readonly mirroredFolderPaths: string[];
  private readonly pushFolder: string | null;
  private readonly manifestByRemoteId: SyncManifest["files"];
  private readonly manifestByRemotePath: Map<
    string,
    SyncManifest["files"][string]
  >;

  constructor(options: CloudBrowserStatusIndexOptions) {
    this.mirroredFolderList = options.mirroredFolders;
    this.mirroredFolderIds = new Set(
      options.mirroredFolders.map((folder) => folder.directoryId),
    );
    this.mirroredFolderPaths = options.mirroredFolders.map((folder) =>
      normalizeCloudPath(folder.remotePath),
    );
    this.pushFolder = options.pushFolder
      ? normalizeCloudPath(options.pushFolder)
      : null;
    this.manifestByRemoteId = options.manifest.files;
    this.manifestByRemotePath = new Map(
      Object.values(options.manifest.files).map((entry) => [
        normalizeCloudPath(entry.remotePath),
        entry,
      ]),
    );
  }

  statusFor(
    item: Pick<CloudItem, "id" | "isFolder" | "md5">,
    remotePath: string,
  ): CloudBrowserSyncStatus {
    const normalizedPath = normalizeCloudPath(remotePath);
    const coveringFolder = coveringMirroredFolder(
      this.mirroredFolderList,
      normalizedPath,
    );

    if (this.pushFolder && isAtOrBelow(normalizedPath, this.pushFolder)) {
      return "writable-sync";
    }

    if (item.isFolder) {
      if (
        this.mirroredFolderIds.has(item.id) ||
        this.mirroredFolderPaths.includes(normalizedPath)
      ) {
        return "mirrored";
      }
      return this.mirroredFolderPaths.some((folderPath) =>
        isAtOrBelow(normalizedPath, folderPath),
      )
        ? "included"
        : "not-synced";
    }

    const manifestEntry =
      this.manifestByRemoteId[item.id] ??
      this.manifestByRemotePath.get(normalizedPath);
    if (manifestEntry) {
      return sameMd5(manifestEntry.md5, item.md5)
        ? coveringFolder
          ? "mirrored"
          : "downloaded"
        : "update-available";
    }

    return coveringFolder ? "included" : "not-synced";
  }

  includedVia(remotePath: string): string | null {
    const folder = coveringMirroredFolder(this.mirroredFolderList, remotePath);
    return folder?.remotePath.split("/").filter(Boolean).at(-1) ?? null;
  }
}
