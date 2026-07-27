import type { CloudFile, CloudItem, CloudUploadPort } from "../cloud/types";
import { md5, sameMd5 } from "../shared/md5";
import { normalizeRelativePath } from "../shared/path";
import type { VaultStore } from "./vault-store";

interface SendCloudPort extends CloudUploadPort {
  listDirectory(directoryId: string): Promise<CloudItem[]>;
}

export interface RemoteDestination {
  directoryId: string;
  remotePath: string;
}

export type MarkdownSendFormat = "pdf" | "text";
export type SendCollisionDecision = "replace" | "keep-both" | "cancel";

export interface SendCollision {
  destination: RemoteDestination;
  fileName: string;
  existing: CloudFile;
}

interface SendToSupernoteOptions {
  vault: VaultStore;
  cloud: SendCloudPort;
  markdownPdf?: MarkdownPdfPort;
  resolveCollision(collision: SendCollision): Promise<SendCollisionDecision>;
}

export interface MarkdownPdfPort {
  render(markdown: string): Promise<Uint8Array>;
}

export interface SendToSupernoteRequest {
  destination: RemoteDestination;
  markdownFormat: MarkdownSendFormat;
}

export interface SendToSupernoteResult {
  cloudPath: string;
  fileName: string;
  checksum: string;
  remoteId: string;
}

export class SendCancelledError extends Error {
  constructor() {
    super("Send to Supernote was cancelled");
    this.name = "SendCancelledError";
  }
}

export class SendToSupernoteService {
  private readonly vault: VaultStore;
  private readonly cloud: SendCloudPort;
  private readonly markdownPdf: MarkdownPdfPort | undefined;
  private readonly resolveCollision: SendToSupernoteOptions["resolveCollision"];

  constructor(options: SendToSupernoteOptions) {
    this.vault = options.vault;
    this.cloud = options.cloud;
    this.markdownPdf = options.markdownPdf;
    this.resolveCollision = options.resolveCollision;
  }

  async send(
    sourcePath: string,
    request: SendToSupernoteRequest,
  ): Promise<SendToSupernoteResult> {
    const normalizedSource = normalizeRelativePath(sourcePath);
    const sourceName = normalizedSource.slice(
      normalizedSource.lastIndexOf("/") + 1,
    );
    const isMarkdown = /\.md$/i.test(sourceName);
    const { bytes, fileName } = isMarkdown
      ? await this.markdownPayload(
          normalizedSource,
          sourceName,
          request.markdownFormat,
        )
      : await this.binaryPayload(normalizedSource, sourceName);
    const expectedChecksum = md5(bytes);
    const items = await this.cloud.listDirectory(
      request.destination.directoryId,
    );
    const existing = items.find(
      (item): item is CloudFile =>
        !item.isFolder &&
        item.fileName.toLocaleLowerCase() === fileName.toLocaleLowerCase(),
    );

    if (existing && sameMd5(existing.md5, expectedChecksum)) {
      return this.result(request.destination, existing, expectedChecksum);
    }

    let uploadedName = fileName;
    if (existing) {
      const decision = await this.resolveCollision({
        destination: request.destination,
        fileName,
        existing,
      });
      if (decision === "cancel") {
        throw new SendCancelledError();
      }
      if (decision === "replace") {
        await this.cloud.replaceFile(existing, bytes);
        const replacement = await this.verifiedFile(
          request.destination.directoryId,
          fileName,
          expectedChecksum,
        );
        return this.result(request.destination, replacement, expectedChecksum);
      }
      uploadedName = this.availableName(
        fileName,
        items.map((item) => item.fileName),
      );
    }

    await this.cloud.uploadFile(
      request.destination.directoryId,
      uploadedName,
      bytes,
    );
    const uploaded = await this.verifiedFile(
      request.destination.directoryId,
      uploadedName,
      expectedChecksum,
    );
    return this.result(request.destination, uploaded, expectedChecksum);
  }

  private async binaryPayload(
    path: string,
    fileName: string,
  ): Promise<{ bytes: Uint8Array; fileName: string }> {
    const bytes = await this.vault.readBinary(path);
    if (bytes === null) {
      throw new Error(`Vault file is unavailable: ${path}`);
    }
    return { bytes, fileName };
  }

  private async markdownPayload(
    path: string,
    fileName: string,
    format: MarkdownSendFormat,
  ): Promise<{ bytes: Uint8Array; fileName: string }> {
    const markdown = await this.vault.readText(path);
    if (markdown === null) {
      throw new Error(`Vault file is unavailable: ${path}`);
    }
    if (format === "text") {
      return {
        bytes: new TextEncoder().encode(markdown),
        fileName: fileName.replace(/\.md$/i, ".txt"),
      };
    }
    if (!this.markdownPdf) {
      throw new Error("Markdown PDF rendering is unavailable");
    }
    return {
      bytes: await this.markdownPdf.render(markdown),
      fileName: fileName.replace(/\.md$/i, ".pdf"),
    };
  }

  private async verifiedFile(
    directoryId: string,
    fileName: string,
    expectedChecksum: string,
  ): Promise<CloudFile> {
    const file = (await this.cloud.listDirectory(directoryId))
      .filter(
        (item): item is CloudFile =>
          !item.isFolder &&
          item.fileName === fileName &&
          sameMd5(item.md5, expectedChecksum),
      )
      .sort((left, right) => right.updateTime - left.updateTime)[0];
    if (!file) {
      throw new Error(
        `Supernote accepted ${fileName} but did not list its verified upload`,
      );
    }
    return file;
  }

  private availableName(fileName: string, existingNames: string[]): string {
    const used = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
    const extensionAt = fileName.lastIndexOf(".");
    const extension = extensionAt > 0 ? fileName.slice(extensionAt) : "";
    const stem = extensionAt > 0 ? fileName.slice(0, extensionAt) : fileName;
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${stem} (${suffix})${extension}`;
      if (!used.has(candidate.toLocaleLowerCase())) {
        return candidate;
      }
    }
  }

  private result(
    destination: RemoteDestination,
    file: CloudFile,
    checksum: string,
  ): SendToSupernoteResult {
    const folder = normalizeRelativePath(destination.remotePath);
    return {
      cloudPath: `${folder}/${file.fileName}`,
      fileName: file.fileName,
      checksum,
      remoteId: file.id,
    };
  }
}
