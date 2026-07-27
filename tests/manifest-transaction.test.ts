import { describe, expect, it, vi } from "vitest";

import { SupernoteAuthExpiredError } from "../src/cloud/client";
import {
  loadManifest,
  saveManifest,
  SyncManifestTransaction,
  type SyncManifestFile,
} from "../src/sync/manifest";
import type { VaultStore } from "../src/sync/vault-store";

class MemoryVault implements VaultStore {
  readonly text = new Map<string, string>();
  readonly readText = vi.fn(
    async (path: string) => this.text.get(path) ?? null,
  );
  readonly writeText = vi.fn(async (path: string, content: string) => {
    this.text.set(path, content);
  });

  async exists(path: string): Promise<boolean> {
    return this.text.has(path);
  }

  async getRevision(path: string): Promise<string | null> {
    return this.text.get(path) ?? null;
  }

  async readBinary(): Promise<Uint8Array | null> {
    return null;
  }

  async writeBinary(): Promise<void> {}

  async listFiles(): Promise<string[]> {
    return [];
  }

  async delete(): Promise<void> {}
}

const entry = (id: string): SyncManifestFile => ({
  remoteId: id,
  directoryId: "directory",
  fileName: `${id}.note`,
  remotePath: `/Note/${id}.note`,
  md5: `${id}-md5`,
  updateTime: 1,
  vaultPath: `supernote/Note/${id}.note`,
  syncedAt: "2026-07-26T00:00:00.000Z",
});

describe("SyncManifestTransaction", () => {
  it("loads once and saves one caller-owned manifest on success", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );

    const transaction = await SyncManifestTransaction.open(vault, path);
    const recoverableFailure = vi.fn(async () => {
      throw new Error("recoverable file error");
    });
    await transaction.run(async (manifest) => {
      manifest.files.first = entry("first");
      try {
        await recoverableFailure();
      } catch {
        // A caller may continue after one mirrored file fails.
      }
      manifest.files.second = entry("second");
    });
    await expect(transaction.run(async () => undefined)).rejects.toThrow(
      "already completed",
    );

    expect(recoverableFailure).toHaveBeenCalledOnce();
    expect(vault.readText).toHaveBeenCalledOnce();
    expect(vault.writeText).toHaveBeenCalledOnce();
    expect(JSON.parse(vault.text.get(path) ?? "{}")).toMatchObject({
      files: {
        existing: { remoteId: "existing" },
        first: { remoteId: "first" },
        second: { remoteId: "second" },
      },
    });
  });

  it("saves completed and unrelated entries before propagating a fatal error", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );
    const transaction = await SyncManifestTransaction.open(vault, path);

    await expect(
      transaction.run(async (manifest) => {
        manifest.files.completed = entry("completed");
        throw new SupernoteAuthExpiredError("session expired");
      }),
    ).rejects.toBeInstanceOf(SupernoteAuthExpiredError);

    expect(vault.readText).toHaveBeenCalledOnce();
    expect(vault.writeText).toHaveBeenCalledOnce();
    expect(JSON.parse(vault.text.get(path) ?? "{}")).toMatchObject({
      files: {
        existing: { remoteId: "existing" },
        completed: { remoteId: "completed" },
      },
    });
  });

  it("preserves a concurrent entry when metadata revision is unchanged", async () => {
    const vault = new MemoryVault();
    vi.spyOn(vault, "getRevision").mockResolvedValue("same-revision");
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );
    const transaction = await SyncManifestTransaction.open(vault, path);

    await transaction.run(async (manifest) => {
      manifest.files.completed = entry("completed");
      const concurrentManifest = await loadManifest(vault, path);
      concurrentManifest.files.concurrent = entry("concurrent");
      await saveManifest(vault, path, concurrentManifest);
    });

    expect(vault.readText).toHaveBeenCalledTimes(3);
    expect(vault.writeText).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vault.text.get(path) ?? "{}")).toMatchObject({
      files: {
        existing: { remoteId: "existing" },
        completed: { remoteId: "completed" },
        concurrent: { remoteId: "concurrent" },
      },
    });
  });

  it("preserves a concurrent remote-id replacement left untouched by the transaction", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );
    const transaction = await SyncManifestTransaction.open(vault, path);

    await transaction.run(async (manifest) => {
      manifest.files.completed = entry("completed");
      const concurrentManifest = await loadManifest(vault, path);
      const replacement = {
        ...concurrentManifest.files.existing!,
        remoteId: "replacement",
        md5: "replacement-md5",
      };
      delete concurrentManifest.files.existing;
      concurrentManifest.files.replacement = replacement;
      await saveManifest(vault, path, concurrentManifest);
    });

    const persisted = JSON.parse(vault.text.get(path) ?? "{}") as {
      files: Record<string, SyncManifestFile>;
    };
    expect(persisted.files.existing).toBeUndefined();
    expect(persisted.files.replacement).toMatchObject({
      remoteId: "replacement",
      md5: "replacement-md5",
    });
    expect(persisted.files.completed).toMatchObject({
      remoteId: "completed",
    });
  });

  it("preserves a concurrent deletion left untouched by the transaction", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );
    const transaction = await SyncManifestTransaction.open(vault, path);

    await transaction.run(async (manifest) => {
      manifest.files.completed = entry("completed");
      const concurrentManifest = await loadManifest(vault, path);
      delete concurrentManifest.files.existing;
      await saveManifest(vault, path, concurrentManifest);
    });

    const persisted = JSON.parse(vault.text.get(path) ?? "{}") as {
      files: Record<string, SyncManifestFile>;
    };
    expect(persisted.files.existing).toBeUndefined();
    expect(persisted.files.completed).toMatchObject({
      remoteId: "completed",
    });
  });

  it("preserves concurrent Automation state while updating sync fields", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );
    const transaction = await SyncManifestTransaction.open(vault, path);

    await transaction.run(async (manifest) => {
      manifest.files.existing!.md5 = "synced-md5";
      const concurrentManifest = await loadManifest(vault, path);
      concurrentManifest.files.existing!.watchHooks = {
        script: {
          noteMd5: "hook-note-md5",
          pageMd5s: { "1": "hook-page-md5" },
        },
      };
      await saveManifest(vault, path, concurrentManifest);
    });

    expect(JSON.parse(vault.text.get(path) ?? "{}")).toMatchObject({
      files: {
        existing: {
          md5: "synced-md5",
          watchHooks: {
            script: {
              noteMd5: "hook-note-md5",
              pageMd5s: { "1": "hook-page-md5" },
            },
          },
        },
      },
    });
  });

  it("carries concurrent state across a replaced remote id", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    vault.text.set(
      path,
      JSON.stringify({ version: 1, files: { existing: entry("existing") } }),
    );
    const transaction = await SyncManifestTransaction.open(vault, path);

    await transaction.run(async (manifest) => {
      const replacement = {
        ...manifest.files.existing!,
        remoteId: "replacement",
        md5: "replacement-md5",
      };
      delete manifest.files.existing;
      manifest.files.replacement = replacement;

      const concurrentManifest = await loadManifest(vault, path);
      concurrentManifest.files.existing!.lastExport = {
        destination: "Exports/existing",
        format: "pdf",
      };
      await saveManifest(vault, path, concurrentManifest);
    });

    const persisted = JSON.parse(vault.text.get(path) ?? "{}") as {
      files: Record<string, SyncManifestFile>;
    };
    expect(persisted.files.existing).toBeUndefined();
    expect(persisted.files.replacement).toMatchObject({
      remoteId: "replacement",
      md5: "replacement-md5",
      lastExport: {
        destination: "Exports/existing",
        format: "pdf",
      },
    });
  });

  it("keeps a conflicting export state atomic", async () => {
    const vault = new MemoryVault();
    const path = "supernote/.sync-manifest.json";
    const existing = entry("existing");
    existing.lastExport = {
      destination: "Exports/baseline",
      format: "pdf",
    };
    vault.text.set(path, JSON.stringify({ version: 1, files: { existing } }));
    const transaction = await SyncManifestTransaction.open(vault, path);

    await transaction.run(async (manifest) => {
      manifest.files.existing!.lastExport = {
        destination: "Exports/transaction",
        format: "markdown",
      };
      const concurrentManifest = await loadManifest(vault, path);
      concurrentManifest.files.existing!.lastExport = {
        destination: "Exports/concurrent",
        format: "images",
      };
      await saveManifest(vault, path, concurrentManifest);
    });

    expect(JSON.parse(vault.text.get(path) ?? "{}")).toMatchObject({
      files: {
        existing: {
          lastExport: {
            destination: "Exports/transaction",
            format: "markdown",
          },
        },
      },
    });
  });
});
