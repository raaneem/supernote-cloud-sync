import SparkMD5 from "spark-md5";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudFile,
  CloudItem,
  DownloadDescriptor,
  UploadResult,
} from "../src/cloud/types";
import {
  SendCancelledError,
  SendToSupernoteService,
  type SendCollisionDecision,
} from "../src/sync/send-to-supernote";
import type { VaultStore } from "../src/sync/vault-store";

const checksum = (bytes: Uint8Array): string =>
  SparkMD5.ArrayBuffer.hash(Uint8Array.from(bytes).buffer);

class MemoryVault implements VaultStore {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();
  readonly writeBinary = vi.fn(async (): Promise<void> => undefined);

  async exists(path: string): Promise<boolean> {
    return this.text.has(path) || this.binary.has(path);
  }
  async getRevision(): Promise<string | null> {
    return null;
  }
  async readText(path: string): Promise<string | null> {
    return this.text.get(path) ?? null;
  }
  async readBinary(path: string): Promise<Uint8Array | null> {
    return this.binary.get(path) ?? null;
  }
  async writeText(): Promise<void> {}
  async listFiles(): Promise<string[]> {
    return [];
  }
  async delete(): Promise<void> {}
}

const destination = {
  directoryId: "destination",
  remotePath: "Document/Shared",
};

class MemoryCloud {
  readonly items: CloudItem[] = [];
  readonly bytes = new Map<string, Uint8Array>();
  readonly uploadFile = vi.fn(
    async (
      directoryId: string,
      fileName: string,
      content: Uint8Array,
    ): Promise<UploadResult> => {
      const file: CloudFile = {
        id: `uploaded-${fileName}`,
        directoryId,
        fileName,
        isFolder: false,
        md5: checksum(content),
        size: content.byteLength,
        createTime: 1,
        updateTime: 2,
      };
      this.items.push(file);
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
  readonly createDirectory = vi.fn(async (): Promise<void> => undefined);

  async listDirectory(directoryId: string): Promise<CloudItem[]> {
    return this.items.filter((item) => item.directoryId === directoryId);
  }
  async getDownloadDescriptor(): Promise<DownloadDescriptor> {
    throw new Error("not used");
  }
  async download(): Promise<Uint8Array> {
    throw new Error("not used");
  }

  add(fileName: string, content: Uint8Array): CloudFile {
    const file: CloudFile = {
      id: `existing-${fileName}`,
      directoryId: destination.directoryId,
      fileName,
      isFolder: false,
      md5: checksum(content),
      size: content.byteLength,
      createTime: 1,
      updateTime: 1,
    };
    this.items.push(file);
    this.bytes.set(file.id, content);
    return file;
  }
}

const createService = ({
  vault,
  cloud,
  collision = "cancel",
  render,
}: {
  vault: MemoryVault;
  cloud: MemoryCloud;
  collision?: SendCollisionDecision;
  render?: (markdown: string) => Promise<Uint8Array>;
}): SendToSupernoteService =>
  new SendToSupernoteService({
    vault,
    cloud,
    ...(render ? { markdownPdf: { render } } : {}),
    resolveCollision: vi.fn(async () => collision),
  });

describe("SendToSupernoteService", () => {
  it("uploads directly to the selected Remote folder without copying into the Mirror", async () => {
    const vault = new MemoryVault();
    const cloud = new MemoryCloud();
    const content = new Uint8Array([1, 2, 3]);
    vault.binary.set("Projects/report.pdf", content);

    const result = await createService({ vault, cloud }).send(
      "Projects/report.pdf",
      { destination, markdownFormat: "pdf" },
    );

    expect(result).toMatchObject({
      cloudPath: "Document/Shared/report.pdf",
      fileName: "report.pdf",
      checksum: checksum(content),
    });
    expect(cloud.uploadFile).toHaveBeenCalledWith(
      destination.directoryId,
      "report.pdf",
      content,
    );
    expect(vault.writeBinary).not.toHaveBeenCalled();
  });

  it("renders Markdown to PDF by default", async () => {
    const vault = new MemoryVault();
    const cloud = new MemoryCloud();
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const render = vi.fn(async () => pdf);
    vault.text.set("Notes/entry.md", "# Entry");

    const result = await createService({ vault, cloud, render }).send(
      "Notes/entry.md",
      { destination, markdownFormat: "pdf" },
    );

    expect(render).toHaveBeenCalledWith("# Entry");
    expect(result.fileName).toBe("entry.pdf");
    expect(cloud.uploadFile).toHaveBeenCalledWith(
      destination.directoryId,
      "entry.pdf",
      pdf,
    );
  });

  it("can send Markdown as plain text", async () => {
    const vault = new MemoryVault();
    const cloud = new MemoryCloud();
    vault.text.set("Notes/entry.md", "# Entry");

    const result = await createService({ vault, cloud }).send(
      "Notes/entry.md",
      { destination, markdownFormat: "text" },
    );

    expect(result.fileName).toBe("entry.txt");
    expect(cloud.uploadFile).toHaveBeenCalledWith(
      destination.directoryId,
      "entry.txt",
      new TextEncoder().encode("# Entry"),
    );
  });

  it("replaces a colliding Remote file only after an explicit choice", async () => {
    const vault = new MemoryVault();
    const cloud = new MemoryCloud();
    const replacement = new Uint8Array([2]);
    const existing = cloud.add("report.pdf", new Uint8Array([1]));
    vault.binary.set("Projects/report.pdf", replacement);

    const result = await createService({
      vault,
      cloud,
      collision: "replace",
    }).send("Projects/report.pdf", {
      destination,
      markdownFormat: "pdf",
    });

    expect(cloud.replaceFile).toHaveBeenCalledWith(existing, replacement);
    expect(result.checksum).toBe(checksum(replacement));
  });

  it("keeps both by choosing a verified non-colliding name", async () => {
    const vault = new MemoryVault();
    const cloud = new MemoryCloud();
    vault.binary.set("Projects/report.pdf", new Uint8Array([2]));
    cloud.add("report.pdf", new Uint8Array([1]));

    const result = await createService({
      vault,
      cloud,
      collision: "keep-both",
    }).send("Projects/report.pdf", {
      destination,
      markdownFormat: "pdf",
    });

    expect(result.fileName).toBe("report (1).pdf");
    expect(cloud.uploadFile).toHaveBeenCalledWith(
      destination.directoryId,
      "report (1).pdf",
      new Uint8Array([2]),
    );
  });

  it("cancels without writing either system", async () => {
    const vault = new MemoryVault();
    const cloud = new MemoryCloud();
    vault.binary.set("Projects/report.pdf", new Uint8Array([2]));
    cloud.add("report.pdf", new Uint8Array([1]));

    await expect(
      createService({ vault, cloud }).send("Projects/report.pdf", {
        destination,
        markdownFormat: "pdf",
      }),
    ).rejects.toBeInstanceOf(SendCancelledError);

    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.replaceFile).not.toHaveBeenCalled();
  });
});
