import { normalizePath, TFile, type TAbstractFile, type Vault } from "obsidian";

import type { VaultStore } from "./vault-store";

interface TrashFilePort {
  trashFile(file: TAbstractFile): Promise<void>;
}

const childEntries = (
  entry: TAbstractFile,
): readonly TAbstractFile[] | null => {
  const children = (
    entry as TAbstractFile & {
      children?: unknown;
    }
  ).children;
  return Array.isArray(children)
    ? (children as readonly TAbstractFile[])
    : null;
};

export const indexedFilePathsBelow = (root: TAbstractFile | null): string[] => {
  if (!root) {
    return [];
  }
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      continue;
    }
    const children = childEntries(entry);
    if (children) {
      pending.push(...children);
    } else {
      files.push(entry.path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
};

export const indexedDirectoryPathsBelow = (
  root: TAbstractFile | null,
): string[] => {
  if (!root) {
    return [];
  }
  const directories: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      continue;
    }
    const children = childEntries(entry);
    if (!children) {
      continue;
    }
    directories.push(entry.path);
    pending.push(...children);
  }
  return directories.sort((left, right) => left.localeCompare(right));
};

export class ObsidianVaultStore implements VaultStore {
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: TrashFilePort,
  ) {}

  async exists(path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    return (
      this.vault.getAbstractFileByPath(normalizedPath) !== null ||
      (await this.vault.adapter.exists(normalizedPath))
    );
  }

  async getRevision(path: string): Promise<string | null> {
    const normalizedPath = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalizedPath);
    const stat =
      file instanceof TFile
        ? file.stat
        : await this.vault.adapter.stat(normalizedPath);
    return stat ? `${stat.mtime}:${stat.size}` : null;
  }

  async readText(path: string): Promise<string | null> {
    const normalizedPath = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
      return this.vault.read(file);
    }
    return (await this.vault.adapter.exists(normalizedPath))
      ? this.vault.adapter.read(normalizedPath)
      : null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    const normalizedPath = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
      return new Uint8Array(await this.vault.readBinary(file));
    }
    return (await this.vault.adapter.exists(normalizedPath))
      ? new Uint8Array(await this.vault.adapter.readBinary(normalizedPath))
      : null;
  }

  async writeText(path: string, content: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    await this.ensureParentDirectory(normalizedPath);
    const file = this.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
      await this.vault.process(file, () => content);
    } else if (this.isHiddenPath(normalizedPath)) {
      await this.vault.adapter.write(normalizedPath, content);
    } else {
      await this.vault.create(normalizedPath, content);
    }
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    const normalizedPath = normalizePath(path);
    await this.ensureParentDirectory(normalizedPath);
    const data = Uint8Array.from(content).buffer;
    const file = this.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
      await this.vault.modifyBinary(file, data);
    } else if (this.isHiddenPath(normalizedPath)) {
      await this.vault.adapter.writeBinary(normalizedPath, data);
    } else {
      await this.vault.createBinary(normalizedPath, data);
    }
  }

  async listFiles(path: string): Promise<string[]> {
    const normalizedPath = normalizePath(path);
    // Obsidian's adapter has no portable recursive-list operation. The
    // Writable subtree is indexed, so traverse only that subtree.
    return indexedFilePathsBelow(
      this.vault.getAbstractFileByPath(normalizedPath),
    );
  }

  async listDirectories(path: string): Promise<string[]> {
    const normalizedPath = normalizePath(path);
    return indexedDirectoryPathsBelow(
      this.vault.getAbstractFileByPath(normalizedPath),
    );
  }

  async createDirectory(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    let current = "";
    for (const segment of normalizedPath.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }

  async delete(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalizedPath);
    if (file) {
      await this.fileManager.trashFile(file);
    } else if (await this.vault.adapter.exists(normalizedPath)) {
      if (this.isPluginMetadataPath(normalizedPath)) {
        // Plugin metadata is intentionally hidden and cannot enter Obsidian's
        // Trash. User-visible Mirror files must never take this fallback.
        await this.vault.adapter.remove(normalizedPath);
      } else {
        throw new Error(
          `Cannot move unindexed vault file to Trash: ${normalizedPath}`,
        );
      }
    }
  }

  async move(from: string, to: string): Promise<void> {
    const normalizedFrom = normalizePath(from);
    const normalizedTo = normalizePath(to);
    const entry = this.vault.getAbstractFileByPath(normalizedFrom);
    if (!entry) {
      throw new Error(`Vault item is unavailable: ${normalizedFrom}`);
    }
    await this.ensureParentDirectory(normalizedTo);
    await this.vault.rename(entry, normalizedTo);
  }

  private isHiddenPath(path: string): boolean {
    return path.split("/").some((segment) => segment.startsWith("."));
  }

  private isPluginMetadataPath(path: string): boolean {
    const name = path.split("/").at(-1) ?? "";
    return (
      name === ".sync-manifest.json" ||
      name.startsWith(".supernote-write-check-")
    );
  }

  private async ensureParentDirectory(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }
}
