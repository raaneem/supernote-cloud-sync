import type {
  NotebookDescriptor,
  NotebookSessionLease,
  NotebookSessionProvider,
  RenderedNotebookPage,
} from "../note/notebook-service";
import type {
  OcrPort,
  OcrResult,
  PreparedOcr,
  TranscriptionMode,
} from "../ocr/types";
import { emptyOcrResult } from "../ocr/types";
import { buildExportMarkdown, type ExportedPage } from "../sync/markdown";
import {
  loadManifest,
  saveManifest,
  type ExportFormat,
  type SyncManifestFile,
} from "../sync/manifest";
import {
  normalizeOptionalRelativePath,
  normalizeRelativePath,
} from "../shared/path";
import type { VaultStore } from "../sync/vault-store";
import type { PdfExporter } from "./pdf-export";

export interface ExportServiceOptions {
  vault: VaultStore;
  notebooks: NotebookSessionProvider;
  pdfExporter: PdfExporter;
  attachmentPath: (filename: string, sourcePath: string) => Promise<string>;
  targetFolder: string;
  ocr?: OcrPort;
  now?: () => Date;
}

export interface PageExportInput {
  rawNotePath: string;
  displayedSession?: NotebookSessionLease;
  selectedPages: readonly number[];
  useOcr: boolean;
  format: ExportFormat;
  filename: string;
  destination: string;
  overwrite: boolean;
  customPrompt?: string;
}

export interface PageExportResult {
  paths: readonly string[];
  transcriptionFailures: readonly number[];
  transcriptionErrors: readonly string[];
  retainedBatchPath?: string;
}

export interface ExportDefaults {
  destination: string;
  format: ExportFormat;
  noteFileName: string;
}

interface ExportPlan {
  markdownPath: string | null;
  pdfPath: string | null;
  imagePaths: readonly string[];
  paths: readonly string[];
}

const withoutNoteExtension = (fileName: string): string =>
  fileName.toLocaleLowerCase().endsWith(".note")
    ? fileName.slice(0, -5)
    : fileName;

const cleanSelectedPages = (selectedPages: readonly number[]): number[] =>
  [
    ...new Set(
      selectedPages.filter(
        (pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0,
      ),
    ),
  ].sort((left, right) => left - right);

const normalizeDestination = normalizeOptionalRelativePath;

const joinVaultPath = (folder: string, name: string): string =>
  folder ? `${folder}/${name}` : name;

const parentPath = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};

const formatExportTime = (date: Date): string =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const isDocumentFormat = (format: ExportFormat): boolean =>
  format === "formatted-markdown" || format === "formatted-markdown-pdf";

const writesMarkdown = (format: ExportFormat): boolean =>
  format === "markdown" ||
  format === "markdown-pdf" ||
  format === "markdown-images" ||
  isDocumentFormat(format);

const writesPdf = (format: ExportFormat): boolean =>
  format === "pdf" ||
  format === "markdown-pdf" ||
  format === "formatted-markdown-pdf";

const writesImages = (format: ExportFormat): boolean =>
  format === "images" || format === "markdown-images";

const failedOcrResult = (
  pages: readonly number[],
  message: string,
): OcrResult => ({
  ...emptyOcrResult(),
  failedPages: pages,
  errors: [message],
});

const mergeOcrResults = (current: OcrResult, next: OcrResult): OcrResult => ({
  pageText: new Map([...current.pageText, ...next.pageText]),
  documentText: next.documentText ?? current.documentText,
  failedPages: [...new Set([...current.failedPages, ...next.failedPages])].sort(
    (left, right) => left - right,
  ),
  errors: [...current.errors, ...next.errors],
  ...((next.retainedBatchPath ?? current.retainedBatchPath)
    ? {
        retainedBatchPath: next.retainedBatchPath ?? current.retainedBatchPath!,
      }
    : {}),
});

const selectPdfPageText = (
  deviceText: string | null,
  hasPositionedDeviceText: boolean,
  transcriptionText: string | null,
): string | null => {
  if (!deviceText) {
    return transcriptionText;
  }
  return hasPositionedDeviceText ? null : deviceText;
};

export class ExportCollisionError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `Export would overwrite ${paths.length === 1 ? paths[0] : `${paths.length} files`}.`,
    );
  }
}

export class ExportService {
  private readonly vault: VaultStore;
  private readonly notebooks: NotebookSessionProvider;
  private readonly pdfExporter: PdfExporter;
  private readonly attachmentPath: ExportServiceOptions["attachmentPath"];
  private readonly targetFolder: string;
  private readonly ocr: OcrPort | undefined;
  private readonly now: () => Date;

  constructor(options: ExportServiceOptions) {
    this.vault = options.vault;
    this.notebooks = options.notebooks;
    this.pdfExporter = options.pdfExporter;
    this.attachmentPath = options.attachmentPath;
    this.targetFolder = normalizeRelativePath(options.targetFolder);
    this.ocr = options.ocr;
    this.now = options.now ?? (() => new Date());
  }

  async getDefaults(rawNotePath: string): Promise<ExportDefaults> {
    const { entry } = await this.findEntry(rawNotePath);
    return {
      destination: entry.lastExport?.destination ?? "",
      format: entry.lastExport?.format ?? "markdown-images",
      noteFileName: entry.fileName,
    };
  }

  async exportPages(input: PageExportInput): Promise<PageExportResult> {
    const selectedPages = cleanSelectedPages(input.selectedPages);
    if (selectedPages.length === 0) {
      throw new Error("Select at least one notebook page");
    }
    const filename = this.cleanFilename(input.filename);
    const destination = normalizeDestination(input.destination);
    this.assertOutsideMirror(destination);
    const { manifestPath, manifest, entry, rawNotePath } = await this.findEntry(
      input.rawNotePath,
    );
    const plan = await this.planExport(
      input.format,
      filename,
      destination,
      selectedPages,
    );
    if (!input.overwrite) {
      const collisions = await this.findCollisions(plan.paths);
      if (collisions.length > 0) {
        throw new ExportCollisionError(collisions);
      }
    }
    const opened = await this.acquireSession(
      rawNotePath,
      input.displayedSession,
    );
    const session = opened.session;
    const documentMode = isDocumentFormat(input.format);
    const customPrompt =
      documentMode && input.customPrompt?.trim()
        ? input.customPrompt.trim()
        : undefined;
    const needsText = writesMarkdown(input.format) || writesPdf(input.format);
    const transcriptionRequested = needsText && (input.useOcr || documentMode);
    const transcriptionMode: TranscriptionMode = documentMode
      ? "document"
      : "page";
    let note!: NotebookDescriptor;
    let pages: ExportedPage[] = [];
    let ocrResult = emptyOcrResult();
    let preparedOcr: PreparedOcr | null = null;
    let formattedTranscription: string | undefined;
    let pdfBytes: Uint8Array | null = null;
    try {
      note = session.descriptor;
      for (const pageNumber of selectedPages) {
        if (pageNumber > note.pageCount) {
          throw new Error(
            `Page ${pageNumber} is not available in ${entry.fileName}`,
          );
        }
      }

      pages = selectedPages.map((pageNumber) => {
        const pageDescriptor = note.pages[pageNumber - 1]!;
        const deviceText = pageDescriptor.recognitionText;
        return {
          pageNumber,
          imageVaultPath: null,
          recognitionText: transcriptionRequested ? null : deviceText,
          ...(transcriptionRequested && deviceText
            ? { deviceRecognitionText: deviceText }
            : {}),
          ...(!transcriptionRequested && deviceText
            ? { recognitionSource: "device" as const }
            : {}),
          textBoxes: note.textBoxes.filter(
            (box) => box.pageNumber === pageNumber,
          ),
        };
      });

      if (transcriptionRequested) {
        try {
          preparedOcr = await this.prepareOcr(
            transcriptionMode,
            rawNotePath,
            selectedPages,
            async (pageNumber) => session.renderPng(pageNumber, 0.5),
            customPrompt,
          );
        } catch (error) {
          ocrResult = failedOcrResult(
            selectedPages,
            error instanceof Error
              ? error.message
              : "Transcription backend failed",
          );
        }
      }

      if (!transcriptionRequested) {
        pdfBytes = await this.renderNativeOutputs(
          session,
          note,
          pages,
          plan,
          input.format,
        );
      }
    } finally {
      opened.release();
    }

    while (preparedOcr) {
      const remainingPageNumbers = preparedOcr.remainingPageNumbers;
      try {
        ocrResult = mergeOcrResults(ocrResult, await preparedOcr.transcribe());
      } catch (error) {
        ocrResult = mergeOcrResults(
          ocrResult,
          failedOcrResult(
            remainingPageNumbers.length > 0
              ? remainingPageNumbers
              : selectedPages,
            error instanceof Error
              ? error.message
              : "Transcription backend failed",
          ),
        );
      }
      if (remainingPageNumbers.length === 0) {
        break;
      }
      let preparation;
      try {
        preparation = await this.acquireSession(
          rawNotePath,
          input.displayedSession,
        );
      } catch (error) {
        ocrResult = mergeOcrResults(
          ocrResult,
          failedOcrResult(
            remainingPageNumbers,
            error instanceof Error
              ? error.message
              : `Mirrored notebook is missing at ${rawNotePath}`,
          ),
        );
        break;
      }
      const preparationSession = preparation.session;
      try {
        preparedOcr = await this.prepareOcr(
          transcriptionMode,
          rawNotePath,
          remainingPageNumbers,
          async (pageNumber) => preparationSession.renderPng(pageNumber, 0.5),
          customPrompt,
        );
      } catch (error) {
        ocrResult = mergeOcrResults(
          ocrResult,
          failedOcrResult(
            remainingPageNumbers,
            error instanceof Error
              ? error.message
              : "Transcription backend failed",
          ),
        );
        break;
      } finally {
        preparation.release();
      }
    }
    if (transcriptionRequested) {
      formattedTranscription = ocrResult.documentText ?? undefined;
      if (!documentMode) {
        this.applyPageTranscriptions(pages, ocrResult);
      }
      if (writesImages(input.format) || writesPdf(input.format)) {
        const output = await this.acquireSession(
          rawNotePath,
          input.displayedSession,
        );
        const outputSession = output.session;
        try {
          pdfBytes = await this.renderNativeOutputs(
            outputSession,
            note,
            pages,
            plan,
            input.format,
          );
        } finally {
          output.release();
        }
      }
    }

    const binaryWrites: Array<{ path: string; content: Uint8Array }> = [];
    if (writesPdf(input.format)) {
      binaryWrites.push({
        path: plan.pdfPath!,
        content: pdfBytes!,
      });
    }

    const textWrites: Array<{ path: string; content: string }> = [];
    if (writesMarkdown(input.format)) {
      textWrites.push({
        path: plan.markdownPath!,
        content: buildExportMarkdown({
          title: filename,
          sourceNotePath: rawNotePath,
          remotePath: entry.remotePath,
          exportedAt: formatExportTime(this.now()),
          ...(writesPdf(input.format) ? { pdfVaultPath: plan.pdfPath! } : {}),
          ...(documentMode
            ? {
                formattedTranscription:
                  formattedTranscription ?? "*Transcription failed.*",
                ...(customPrompt
                  ? { usesCustomDocumentInstructions: true }
                  : {}),
              }
            : {}),
          pages,
        }),
      });
    }

    for (const write of binaryWrites) {
      await this.vault.writeBinary(write.path, write.content);
    }
    for (const write of textWrites) {
      await this.vault.writeText(write.path, write.content);
    }
    entry.lastExport = { destination, format: input.format };
    await saveManifest(this.vault, manifestPath, manifest);
    return {
      paths: plan.paths,
      transcriptionFailures: ocrResult.failedPages,
      transcriptionErrors: ocrResult.errors,
      ...(ocrResult.retainedBatchPath
        ? { retainedBatchPath: ocrResult.retainedBatchPath }
        : {}),
    };
  }

  private async acquireSession(
    rawNotePath: string,
    displayedSession?: NotebookSessionLease,
  ): Promise<{ session: NotebookSessionLease; release: () => void }> {
    if (displayedSession) {
      if (displayedSession.descriptor.path !== rawNotePath) {
        throw new Error(
          `Displayed notebook does not match export source ${rawNotePath}`,
        );
      }
      return { session: displayedSession, release: () => undefined };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revisionBefore = await this.vault.getRevision(rawNotePath);
      const bytes = await this.vault.readBinary(rawNotePath);
      const revisionAfter = await this.vault.getRevision(rawNotePath);
      if (!bytes || !revisionBefore || !revisionAfter) {
        throw new Error(`Mirrored notebook is missing at ${rawNotePath}`);
      }
      if (revisionBefore !== revisionAfter) {
        continue;
      }
      const session = await this.notebooks.open({
        path: rawNotePath,
        revision: revisionAfter,
        bytes,
      });
      return {
        session,
        release: () => session.close(),
      };
    }
    throw new Error(`Mirrored notebook changed while opening ${rawNotePath}`);
  }

  private async prepareOcr(
    mode: TranscriptionMode,
    rawNotePath: string,
    pageNumbers: readonly number[],
    renderTranscription: (pageNumber: number) => Promise<RenderedNotebookPage>,
    customPrompt?: string,
  ): Promise<PreparedOcr> {
    if (!this.ocr) {
      throw new Error(
        "Transcription backend is not available with the current settings.",
      );
    }
    return this.ocr.prepare({
      mode,
      note: rawNotePath,
      ...(mode === "document" && customPrompt ? { customPrompt } : {}),
      pages: {
        pageNumbers,
        render: async (pageNumber) => {
          if (!pageNumbers.includes(pageNumber)) {
            throw new Error(
              `Page ${pageNumber} is outside this transcription selection`,
            );
          }
          return (await renderTranscription(pageNumber)).png;
        },
      },
    });
  }

  private async renderNativeOutputs(
    session: Awaited<ReturnType<NotebookSessionProvider["open"]>>,
    note: NotebookDescriptor,
    pages: ExportedPage[],
    plan: ExportPlan,
    format: ExportFormat,
  ): Promise<Uint8Array | null> {
    if (writesImages(format)) {
      for (const [index, page] of pages.entries()) {
        const rendered = await session.renderPng(page.pageNumber, 1);
        const path = plan.imagePaths[index]!;
        page.imageVaultPath = format === "markdown-images" ? path : null;
        await this.vault.writeBinary(path, rendered.png);
      }
    }
    if (!writesPdf(format)) {
      return null;
    }
    const pdfPages = async function* () {
      for (const page of pages) {
        const rendered = await session.renderPng(
          page.pageNumber,
          1,
          "opaque-rgb",
        );
        const pageDescriptor = note.pages[page.pageNumber - 1]!;
        const recognitionSpans = pageDescriptor.recognitionSpans;
        const deviceText = pageDescriptor.recognitionText;
        const textBoxSpans = page.textBoxes.map((box) => ({
          text: box.text,
          rect: box.rect,
        }));
        yield {
          pageNumber: page.pageNumber,
          png: rendered.png,
          width: rendered.width,
          height: rendered.height,
          pageText: selectPdfPageText(
            deviceText,
            recognitionSpans.length > 0,
            page.recognitionText,
          ),
          positionedText: [...recognitionSpans, ...textBoxSpans],
        };
      }
    };
    return this.pdfExporter.export(pdfPages());
  }

  private applyPageTranscriptions(
    pages: ExportedPage[],
    result: OcrResult,
  ): void {
    for (const page of pages) {
      const text = result.pageText.get(page.pageNumber);
      if (text?.trim()) {
        page.recognitionText = text;
        page.recognitionSource = "ocr";
        continue;
      }
      if (page.deviceRecognitionText?.trim()) {
        page.recognitionText = page.deviceRecognitionText;
        page.recognitionSource = "device";
        page.deviceRecognitionText = null;
      } else {
        page.recognitionText = null;
        delete page.recognitionSource;
      }
      page.transcriptionUnavailable = true;
    }
  }

  private async planExport(
    format: ExportFormat,
    filename: string,
    destination: string,
    selectedPages: readonly number[],
  ): Promise<ExportPlan> {
    const markdownPath = writesMarkdown(format)
      ? joinVaultPath(destination, `${filename}.md`)
      : null;
    let pdfPath: string | null = null;
    if (format === "pdf") {
      pdfPath = joinVaultPath(destination, `${filename}.pdf`);
    } else if (
      format === "markdown-pdf" ||
      format === "formatted-markdown-pdf"
    ) {
      pdfPath = await this.resolveAttachmentTarget(
        `${filename}.pdf`,
        markdownPath!,
      );
    }
    const imagePaths: string[] = [];
    if (writesImages(format)) {
      for (const pageNumber of selectedPages) {
        const imageName = `${filename} p${String(pageNumber).padStart(2, "0")}.png`;
        imagePaths.push(
          format === "images"
            ? joinVaultPath(destination, imageName)
            : await this.resolveAttachmentTarget(imageName, markdownPath!),
        );
      }
    }
    return {
      markdownPath,
      pdfPath,
      imagePaths,
      paths: [
        ...(markdownPath ? [markdownPath] : []),
        ...(pdfPath ? [pdfPath] : []),
        ...imagePaths,
      ],
    };
  }

  private async resolveAttachmentTarget(
    filename: string,
    sourcePath: string,
  ): Promise<string> {
    const available = normalizeRelativePath(
      await this.attachmentPath(filename, sourcePath),
    );
    return joinVaultPath(parentPath(available) || "attachments", filename);
  }

  private async findEntry(rawPath: string): Promise<{
    manifestPath: string;
    manifest: Awaited<ReturnType<typeof loadManifest>>;
    entry: SyncManifestFile & { pageCount: number };
    rawNotePath: string;
  }> {
    const rawNotePath = normalizeRelativePath(rawPath);
    const manifestPath = `${this.targetFolder}/.sync-manifest.json`;
    const manifest = await loadManifest(this.vault, manifestPath);
    const entry = Object.values(manifest.files).find(
      (candidate) =>
        candidate.vaultPath === rawNotePath &&
        candidate.pageCount !== undefined,
    ) as (SyncManifestFile & { pageCount: number }) | undefined;
    if (!entry) {
      throw new Error(
        "This .note file is not linked to a mirrored Supernote Cloud notebook.",
      );
    }
    return { manifestPath, manifest, entry, rawNotePath };
  }

  private cleanFilename(filename: string): string {
    const cleaned = filename.trim();
    if (
      !cleaned ||
      cleaned === "." ||
      cleaned === ".." ||
      /[/\\\0]/.test(cleaned)
    ) {
      throw new Error(`Invalid export filename: ${filename}`);
    }
    return cleaned;
  }

  private assertOutsideMirror(destination: string): void {
    if (
      destination === this.targetFolder ||
      destination.startsWith(`${this.targetFolder}/`)
    ) {
      throw new Error("Choose a destination outside the Supernote mirror.");
    }
  }

  private async findCollisions(paths: readonly string[]): Promise<string[]> {
    const collisions: string[] = [];
    for (const path of paths) {
      if (await this.vault.exists(path)) {
        collisions.push(path);
      }
    }
    return collisions;
  }
}

export const defaultExportFilename = (
  noteFileName: string,
  selectedPages: readonly number[],
): string => {
  const pages = cleanSelectedPages(selectedPages);
  const first = pages[0];
  const last = pages.at(-1);
  if (first === undefined || last === undefined) {
    return withoutNoteExtension(noteFileName);
  }
  return `${withoutNoteExtension(noteFileName)} p${first}-${last}`;
};
