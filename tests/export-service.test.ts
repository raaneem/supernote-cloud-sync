import { describe, expect, it, vi } from "vitest";

import type {
  NotebookDescriptor,
  NotebookSessionLease,
  NotebookSessionProvider,
} from "../src/note/notebook-service";
import type { OcrPort, OcrRequest, OcrResult } from "../src/ocr/types";
import {
  ExportCollisionError,
  ExportService,
  type ExportServiceOptions,
} from "../src/export/export-service";
import type { PdfExporter } from "../src/export/pdf-export";
import type { VaultStore } from "../src/sync/vault-store";

class MemoryVault implements VaultStore {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();
  readonly exists = vi.fn(
    async (path: string) => this.text.has(path) || this.binary.has(path),
  );

  async getRevision(path: string): Promise<string | null> {
    const binary = this.binary.get(path);
    return binary
      ? `binary:${binary.byteLength}`
      : (this.text.get(path) ?? null);
  }

  async readText(path: string): Promise<string | null> {
    return this.text.get(path) ?? null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    return this.binary.get(path) ?? null;
  }

  async writeText(path: string, content: string): Promise<void> {
    this.text.set(path, content);
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.binary.set(path, content);
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.binary.keys(), ...this.text.keys()].filter(
      (filePath) => filePath === path || filePath.startsWith(prefix),
    );
  }

  async delete(path: string): Promise<void> {
    this.text.delete(path);
    this.binary.delete(path);
  }
}

const rawNotePath = "supernote/Note/Journal/2026/7 July 2026.note";
const manifestPath = "supernote/.sync-manifest.json";

const createVault = (): MemoryVault => {
  const vault = new MemoryVault();
  vault.binary.set(rawNotePath, new Uint8Array([9]));
  vault.text.set(
    manifestPath,
    JSON.stringify({
      version: 1,
      files: {
        "42": {
          remoteId: "42",
          directoryId: "7",
          fileName: "7 July 2026.note",
          remotePath: "/Note/Journal/2026/7 July 2026.note",
          md5: "note-md5",
          updateTime: 2,
          pageCount: 5,
          vaultPath: rawNotePath,
          syncedAt: "2026-07-24T12:00:00.000Z",
        },
      },
    }),
  );
  return vault;
};

const pdfExporter: PdfExporter = {
  export: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
};

type OcrTranscribe = (request: OcrRequest) => Promise<OcrResult>;

const preparedOcr = (transcribe: OcrTranscribe): OcrPort => ({
  prepare: async (request) => ({
    remainingPageNumbers: [],
    transcribe: () => transcribe(request),
  }),
});

const createService = (
  vault: MemoryVault,
  overrides: {
    ocr?: OcrPort;
    notebooks?: NotebookSessionProvider;
    recognitionByPage?: ReadonlyMap<number, string>;
    attachmentPath?: ExportServiceOptions["attachmentPath"];
    closeSession?: () => void;
    pdfExporter?: PdfExporter;
    renderPng?: (
      pageNumber: number,
      scale?: number,
      encoding?: "opaque-rgb",
    ) => Promise<{
      png: Uint8Array;
      width: number;
      height: number;
    }>;
  } = {},
): ExportService =>
  new ExportService({
    vault,
    notebooks:
      overrides.notebooks ??
      ({
        open: vi.fn(async () => {
          const descriptor: NotebookDescriptor = {
            path: rawNotePath,
            revision: "note-md5",
            devicePage: null,
            pages: Array.from({ length: 5 }, (_, index) => ({
              pageNumber: index + 1,
              fingerprint: `page-${index + 1}`,
              recognitionText:
                overrides.recognitionByPage !== undefined
                  ? (overrides.recognitionByPage.get(index + 1) ?? null)
                  : index + 1 === 3
                    ? "Device page three"
                    : null,
              recognitionSpans: [],
            })),
            pageCount: 5,
            textBoxes: [],
          };
          return {
            descriptor,
            retain: vi.fn(() => {
              throw new Error("Unexpected lease retention");
            }),
            bitmap: vi.fn(),
            thumbnailBitmap: vi.fn(),
            renderPng: vi.fn(
              overrides.renderPng ??
                (async (pageNumber: number) => ({
                  png: new Uint8Array([pageNumber]),
                  width: 1920,
                  height: 2560,
                })),
            ),
            updateView: vi.fn(),
            close: overrides.closeSession ?? vi.fn(),
          };
        }),
      } satisfies NotebookSessionProvider),
    pdfExporter: overrides.pdfExporter ?? pdfExporter,
    attachmentPath:
      overrides.attachmentPath ??
      (async (filename) => `Attachments/${filename}`),
    targetFolder: "supernote",
    ...(overrides.ocr ? { ocr: overrides.ocr } : {}),
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

describe("ExportService", () => {
  it("exports from the displayed lease without reopening or closing it", async () => {
    const vault = createVault();
    const close = vi.fn();
    const renderPng = vi.fn(async (pageNumber: number) => ({
      png: new Uint8Array([pageNumber]),
      width: 1920,
      height: 2560,
    }));
    const displayedSession: NotebookSessionLease = {
      descriptor: {
        path: rawNotePath,
        revision: "displayed-revision",
        devicePage: null,
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            fingerprint: "displayed-page",
            recognitionText: null,
            recognitionSpans: [],
          },
        ],
        textBoxes: [],
      },
      retain: vi.fn(() => {
        throw new Error("Unexpected lease retention");
      }),
      bitmap: vi.fn(),
      thumbnailBitmap: vi.fn(),
      renderPng,
      updateView: vi.fn(),
      close,
    };
    const open = vi.fn<NotebookSessionProvider["open"]>();
    const service = createService(vault, {
      notebooks: { open },
    });

    await service.exportPages({
      rawNotePath,
      displayedSession,
      selectedPages: [1],
      useOcr: false,
      format: "images",
      filename: "displayed",
      destination: "Journal",
      overwrite: false,
    });

    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(renderPng).toHaveBeenCalledWith(1, 1);
  });

  it("opens background exports with the vault revision rather than manifest MD5", async () => {
    const vault = createVault();
    const open = vi.fn<NotebookSessionProvider["open"]>(async (source) => {
      expect(source.revision).toBe("binary:1");
      return {
        descriptor: {
          path: rawNotePath,
          revision: source.revision,
          devicePage: null,
          pageCount: 1,
          pages: [
            {
              pageNumber: 1,
              fingerprint: "page-one",
              recognitionText: null,
              recognitionSpans: [],
            },
          ],
          textBoxes: [],
        },
        retain: vi.fn(() => {
          throw new Error("Unexpected lease retention");
        }),
        bitmap: vi.fn(),
        thumbnailBitmap: vi.fn(),
        renderPng: vi.fn(async () => ({
          png: new Uint8Array([1]),
          width: 1920,
          height: 2560,
        })),
        updateView: vi.fn(),
        close: vi.fn(),
      } satisfies NotebookSessionLease;
    });
    const service = createService(vault, {
      notebooks: { open },
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [1],
      useOcr: false,
      format: "images",
      filename: "background",
      destination: "Journal",
      overwrite: false,
    });

    expect(open).toHaveBeenCalledOnce();
  });

  it("renders transcription pages lazily at the approved profile", async () => {
    const vault = createVault();
    const closeSession = vi.fn();
    const renderPng = vi.fn(async (pageNumber: number, scale = 1) => ({
      png: new Uint8Array([pageNumber]),
      width: 1920 * scale,
      height: 2560 * scale,
    }));
    const transcribe = vi.fn(async () => {
      expect(closeSession).toHaveBeenCalledOnce();
      return {
        pageText: new Map([[4, "OCR page four"]]),
        documentText: null,
        failedPages: [],
        errors: [],
      };
    });
    const prepare = vi.fn<OcrPort["prepare"]>(async (request) => {
      expect(closeSession).not.toHaveBeenCalled();
      expect(request.pages.pageNumbers).toEqual([4]);
      await expect(request.pages.render(4)).resolves.toEqual(
        new Uint8Array([4]),
      );
      return { remainingPageNumbers: [], transcribe };
    });
    const service = createService(vault, {
      ocr: { prepare },
      recognitionByPage: new Map(),
      closeSession,
      renderPng,
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [4],
      useOcr: true,
      format: "markdown",
      filename: "short-lived-session",
      destination: "Journal",
      overwrite: false,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(renderPng).toHaveBeenCalledWith(4, 0.5);
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it("releases each notebook lease before a bounded OCR batch runs", async () => {
    const vault = createVault();
    const closeSession = vi.fn();
    const preparedBatches: number[][] = [];
    const executedBatches: number[][] = [];
    const ocr: OcrPort = {
      prepare: async (request) => {
        const batch = request.pages.pageNumbers.slice(0, 2);
        preparedBatches.push([...request.pages.pageNumbers]);
        for (const pageNumber of batch) {
          await request.pages.render(pageNumber);
        }
        return {
          remainingPageNumbers: request.pages.pageNumbers.slice(batch.length),
          transcribe: async () => {
            expect(closeSession).toHaveBeenCalledTimes(
              executedBatches.length + 1,
            );
            executedBatches.push([...batch]);
            return {
              pageText: new Map(
                batch.map((pageNumber) => [
                  pageNumber,
                  `OCR page ${pageNumber}`,
                ]),
              ),
              documentText: null,
              failedPages: [],
              errors: [],
            };
          },
        };
      },
    };
    const service = createService(vault, {
      ocr,
      recognitionByPage: new Map(),
      closeSession,
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [1, 2, 3, 4, 5],
      useOcr: true,
      format: "markdown",
      filename: "bounded-page-batches",
      destination: "Journal",
      overwrite: false,
    });

    expect(preparedBatches).toEqual([[1, 2, 3, 4, 5], [3, 4, 5], [5]]);
    expect(executedBatches).toEqual([[1, 2], [3, 4], [5]]);
    expect(closeSession).toHaveBeenCalledTimes(3);
  });

  it("writes a one-shot Markdown and image snapshot outside the mirror", async () => {
    const vault = createVault();
    const service = createService(vault);

    await service.exportPages({
      rawNotePath,
      selectedPages: [3, 4],
      useOcr: false,
      format: "markdown-images",
      filename: "7 July 2026 p3-4",
      destination: "Journal",
      overwrite: false,
    });

    expect(vault.text.get("Journal/7 July 2026 p3-4.md")).toContain(
      'supernote-note: "supernote/Note/Journal/2026/7 July 2026.note"',
    );
    expect(vault.text.get("Journal/7 July 2026 p3-4.md")).toContain(
      "![[Attachments/7 July 2026 p3-4 p03.png]]",
    );
    expect(vault.binary.get("Attachments/7 July 2026 p3-4 p03.png")).toEqual(
      new Uint8Array([3]),
    );
    expect(vault.binary.get("Attachments/7 July 2026 p3-4 p04.png")).toEqual(
      new Uint8Array([4]),
    );
    expect(vault.binary.get(rawNotePath)).toEqual(new Uint8Array([9]));
    const manifest = JSON.parse(vault.text.get(manifestPath) ?? "{}") as {
      files: Record<string, { lastExport?: unknown }>;
    };
    expect(manifest.files["42"]?.lastExport).toEqual({
      destination: "Journal",
      format: "markdown-images",
    });
  });

  it("reloads transferred note bytes before native output after OCR", async () => {
    const vault = createVault();
    const readBinary = vi.spyOn(vault, "readBinary");
    const service = createService(vault, {
      ocr: preparedOcr(async () => ({
        pageText: new Map([[4, "OCR page four"]]),
        documentText: null,
        failedPages: [],
        errors: [],
      })),
      recognitionByPage: new Map(),
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [4],
      useOcr: true,
      format: "markdown-pdf",
      filename: "fresh-source",
      destination: "Journal",
      overwrite: false,
    });

    expect(
      readBinary.mock.calls.filter(([path]) => path === rawNotePath),
    ).toHaveLength(2);
  });

  it("writes each image before rendering the next selected page", async () => {
    const vault = createVault();
    const events: string[] = [];
    vi.spyOn(vault, "writeBinary").mockImplementation(async (path, content) => {
      events.push(`write:${content[0]}`);
      vault.binary.set(path, content);
    });
    const service = createService(vault, {
      renderPng: async (pageNumber, _scale, encoding) => {
        events.push(`render:${pageNumber}:${encoding ?? "rgba"}`);
        return {
          png: new Uint8Array([pageNumber]),
          width: 1920,
          height: 2560,
        };
      },
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [2, 3, 4],
      useOcr: false,
      format: "images",
      filename: "bounded-images",
      destination: "Journal",
      overwrite: false,
    });

    expect(events).toEqual([
      "render:2:rgba",
      "write:2",
      "render:3:rgba",
      "write:3",
      "render:4:rgba",
      "write:4",
    ]);
  });

  it("feeds each native page to the PDF exporter before rendering the next", async () => {
    const vault = createVault();
    const events: string[] = [];
    const service = createService(vault, {
      renderPng: async (pageNumber, _scale, encoding) => {
        events.push(`render:${pageNumber}:${encoding ?? "rgba"}`);
        return {
          png: new Uint8Array([pageNumber]),
          width: 1920,
          height: 2560,
        };
      },
      pdfExporter: {
        export: async (pages) => {
          for await (const page of pages) {
            events.push(`embed:${page.pageNumber}`);
          }
          return new Uint8Array([37, 80, 68, 70]);
        },
      },
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [2, 3, 4],
      useOcr: false,
      format: "pdf",
      filename: "bounded-pdf",
      destination: "Journal",
      overwrite: false,
    });

    expect(events).toEqual([
      "render:2:opaque-rgb",
      "embed:2",
      "render:3:opaque-rgb",
      "embed:3",
      "render:4:opaque-rgb",
      "embed:4",
    ]);
  });

  it("transcribes every requested export without retaining transcript text", async () => {
    const vault = createVault();
    const legacyManifest = JSON.parse(vault.text.get(manifestPath) ?? "{}") as {
      files: Record<string, Record<string, unknown>>;
    };
    legacyManifest.files["42"]!.transcriptionCache = {
      pages: {
        "4": {
          md5: "note-md5",
          fingerprint: "fingerprint-one",
          text: "Legacy cached transcript",
        },
      },
      documents: {},
    };
    vault.text.set(manifestPath, JSON.stringify(legacyManifest));
    let transcriptionRun = 0;
    const transcribe = vi.fn(async () => {
      transcriptionRun += 1;
      return {
        pageText: new Map([[4, `OCR page four, run ${transcriptionRun}`]]),
        documentText: null,
        failedPages: [],
        errors: [],
      };
    });
    const ocr = preparedOcr(transcribe);
    const service = createService(vault, {
      ocr,
      recognitionByPage: new Map(),
    });

    for (const filename of ["first", "second"]) {
      await service.exportPages({
        rawNotePath,
        selectedPages: [4],
        useOcr: true,
        format: "markdown",
        filename,
        destination: "Journal",
        overwrite: false,
      });
    }

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(vault.text.get("Journal/first.md")).toContain(
      "OCR page four, run 1",
    );
    expect(vault.text.get("Journal/second.md")).toContain(
      "OCR page four, run 2",
    );
    const manifest = JSON.parse(vault.text.get(manifestPath) ?? "{}") as {
      files: Record<string, { transcriptionCache?: unknown }>;
    };
    expect(manifest.files["42"]).not.toHaveProperty("transcriptionCache");
  });

  it("transcribes every selected page and preserves device text for comparison", async () => {
    const vault = createVault();
    const transcribe = vi.fn(async (_request: OcrRequest) => ({
      pageText: new Map([
        [3, "AI page three"],
        [4, "AI page four"],
      ]),
      documentText: null,
      failedPages: [],
      errors: [],
    }));
    const service = createService(vault, {
      ocr: preparedOcr(transcribe),
      recognitionByPage: new Map([[3, "Device page three"]]),
    });

    await service.exportPages({
      rawNotePath,
      selectedPages: [3, 4],
      useOcr: true,
      format: "markdown",
      customPrompt: "Summarize this page.",
      filename: "dual",
      destination: "Journal",
      overwrite: false,
    });

    const request = transcribe.mock.calls[0]![0];
    expect(request.pages.pageNumbers).toEqual([3, 4]);
    expect(request.customPrompt).toBeUndefined();
    const markdown = vault.text.get("Journal/dual.md")!;
    expect(markdown.indexOf("AI page three")).toBeLessThan(
      markdown.indexOf("On-device recognition"),
    );
    expect(markdown).toContain("> Device page three");
  });

  it("degrades failed pages without failing the export", async () => {
    const vault = createVault();
    const service = createService(vault, {
      ocr: preparedOcr(async () => ({
        pageText: new Map([[4, "AI page four"]]),
        documentText: null,
        failedPages: [3],
        errors: ["Page 3 failed"],
      })),
      recognitionByPage: new Map([[3, "Device page three"]]),
    });

    const result = await service.exportPages({
      rawNotePath,
      selectedPages: [3, 4],
      useOcr: true,
      format: "markdown",
      filename: "degraded",
      destination: "Journal",
      overwrite: false,
    });

    expect(result.transcriptionFailures).toEqual([3]);
    const markdown = vault.text.get("Journal/degraded.md")!;
    expect(markdown).toContain("Device page three");
    expect(markdown).toContain("AI page four");
    expect(markdown).toContain(
      "Device page three\n\n*Transcription unavailable.*",
    );
  });

  it("exports a newly transcribed formatted document and embeds its PDF below", async () => {
    const vault = createVault();
    const transcribe = vi.fn(async (_request: OcrRequest) => ({
      pageText: new Map(),
      documentText: "# Heading\n\n- one\n- two",
      failedPages: [],
      errors: [],
    }));
    const service = createService(vault, {
      ocr: preparedOcr(transcribe),
      recognitionByPage: new Map([[3, "Device page three"]]),
    });

    for (const filename of ["formatted", "formatted-again"]) {
      await service.exportPages({
        rawNotePath,
        selectedPages: [3, 4, 5],
        useOcr: true,
        format: "formatted-markdown-pdf",
        filename,
        destination: "Journal",
        overwrite: false,
      });
    }

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[0]![0].mode).toBe("document");
    expect(transcribe.mock.calls[0]![0].customPrompt).toBeUndefined();
    expect(transcribe.mock.calls[0]![0].pages.pageNumbers).toHaveLength(3);
    const markdown = vault.text.get("Journal/formatted.md")!;
    expect(markdown).toContain("# Heading\n\n- one\n- two");
    expect(markdown).not.toContain("supernote-transcription:");
    expect(markdown.indexOf("# Heading")).toBeLessThan(
      markdown.indexOf("![[Attachments/formatted.pdf]]"),
    );
  });

  it("isolates custom document instructions in requests and output provenance", async () => {
    const vault = createVault();
    const transcribe = vi.fn(async (request: OcrRequest) => ({
      pageText: new Map(),
      documentText: `# Result\n\n${request.customPrompt}`,
      failedPages: [],
      errors: [],
    }));
    const service = createService(vault, {
      ocr: preparedOcr(transcribe),
      recognitionByPage: new Map(),
    });

    for (const [filename, customPrompt] of [
      ["organized", "Organize by theme."],
      ["organized-again", "Organize by theme."],
      ["summary", "Add a short summary."],
    ] as const) {
      await service.exportPages({
        rawNotePath,
        selectedPages: [3, 4, 5],
        useOcr: true,
        format: "formatted-markdown",
        customPrompt,
        filename,
        destination: "Journal",
        overwrite: false,
      });
    }

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(transcribe.mock.calls[0]![0].customPrompt).toBe(
      "Organize by theme.",
    );
    expect(transcribe.mock.calls[1]![0].customPrompt).toBe(
      "Organize by theme.",
    );
    expect(transcribe.mock.calls[2]![0].customPrompt).toBe(
      "Add a short summary.",
    );
    expect(vault.text.get("Journal/organized.md")).toContain(
      "supernote-transcription: custom",
    );
    expect(vault.text.get("Journal/summary.md")).toContain(
      "# Result\n\nAdd a short summary.",
    );
  });

  it("keeps a custom document PDF out of the vault root when the attachment resolver returns root", async () => {
    const vault = createVault();
    const service = createService(vault, {
      ocr: preparedOcr(async () => ({
        pageText: new Map(),
        documentText: "# Organized",
        failedPages: [],
        errors: [],
      })),
      attachmentPath: async (filename) => filename,
    });

    const result = await service.exportPages({
      rawNotePath,
      selectedPages: [2, 3],
      useOcr: true,
      format: "formatted-markdown-pdf",
      customPrompt: "Organize these notes.",
      filename: "organized",
      destination: "",
      overwrite: false,
    });

    expect(result.paths).toEqual(["organized.md", "attachments/organized.pdf"]);
    expect(vault.binary.has("organized.pdf")).toBe(false);
    expect(vault.binary.has("attachments/organized.pdf")).toBe(true);
    expect(vault.text.get("organized.md")).toContain(
      "![[attachments/organized.pdf]]",
    );
  });

  it.each([
    ["markdown", ["Journal/export.md"]],
    ["pdf", ["Journal/export.pdf"]],
    ["images", ["Journal/export p03.png"]],
    ["markdown-pdf", ["Journal/export.md", "Attachments/export.pdf"]],
    ["markdown-images", ["Journal/export.md", "Attachments/export p03.png"]],
    ["formatted-markdown", ["Journal/export.md"]],
    ["formatted-markdown-pdf", ["Journal/export.md", "Attachments/export.pdf"]],
  ] as const)("plans the %s format", async (format, expectedPaths) => {
    const vault = createVault();
    const result = await createService(vault).exportPages({
      rawNotePath,
      selectedPages: [3],
      useOcr: false,
      format,
      filename: "export",
      destination: "Journal",
      overwrite: false,
    });

    expect(result.paths).toEqual(expectedPaths);
  });

  it("refuses mirror destinations and requires confirmation for collisions", async () => {
    const vault = createVault();
    const service = createService(vault);
    await expect(
      service.exportPages({
        rawNotePath,
        selectedPages: [3],
        useOcr: false,
        format: "markdown",
        filename: "blocked",
        destination: "supernote/Note/Journal",
        overwrite: false,
      }),
    ).rejects.toThrow("outside the Supernote mirror");

    vault.text.set("Journal/existing.md", "Keep me");
    const readText = vi.spyOn(vault, "readText");
    const readBinary = vi.spyOn(vault, "readBinary");
    await expect(
      service.exportPages({
        rawNotePath,
        selectedPages: [3],
        useOcr: false,
        format: "markdown",
        filename: "existing",
        destination: "Journal",
        overwrite: false,
      }),
    ).rejects.toBeInstanceOf(ExportCollisionError);
    expect(vault.text.get("Journal/existing.md")).toBe("Keep me");
    expect(vault.exists).toHaveBeenCalledWith("Journal/existing.md");
    expect(readText).not.toHaveBeenCalledWith("Journal/existing.md");
    expect(readBinary).not.toHaveBeenCalledWith("Journal/existing.md");
  });
});
