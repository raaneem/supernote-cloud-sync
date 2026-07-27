import {
  createDesktopBatch,
  runDesktopCommand,
  type DesktopBatch,
  type DesktopCommandResult,
  type DesktopProcessOptions,
} from "../shared/desktop-command";
import {
  failedProcessRunStatus,
  transcriptionRunLabel,
} from "../run/run-format";
import { RunRegistry } from "../run/run-registry";
import { prepareImageBatch, type PreparedImageBatch } from "./image-batch";
import { customDocumentPrompt } from "./prompt";
import type { OcrPort, OcrRequest, OcrResult, PreparedOcr } from "./types";

export type CommandOcrBatch = DesktopBatch;

interface CommandOcrOptions {
  command: string;
  timeoutMs: number;
  runs?: RunRegistry;
  createBatch?: () => Promise<CommandOcrBatch>;
  runCommand?: (
    command: string,
    options?: DesktopProcessOptions,
  ) => Promise<DesktopCommandResult>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown command error";

const commandFailure = (result: DesktopCommandResult): string => {
  const detail = result.stderr.trim();
  if (result.cancelled) {
    return `Transcription command was cancelled${detail ? `: ${detail}` : ""}`;
  }
  if (result.timedOut) {
    return `Transcription command timed out${detail ? `: ${detail}` : ""}`;
  }
  return (
    `Transcription command exited with code ${result.exitCode ?? "unknown"}` +
    (detail ? `: ${detail}` : "")
  );
};

export class CommandOcrService implements OcrPort {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly runs: RunRegistry | undefined;
  private readonly createBatch: () => Promise<CommandOcrBatch>;
  private readonly runCommand: NonNullable<CommandOcrOptions["runCommand"]>;

  constructor(options: CommandOcrOptions) {
    this.command = options.command;
    this.timeoutMs = options.timeoutMs;
    this.runs = options.runs;
    this.createBatch =
      options.createBatch ?? (() => createDesktopBatch("supernote-ocr-"));
    this.runCommand = options.runCommand ?? runDesktopCommand;
  }

  async prepare(request: OcrRequest): Promise<PreparedOcr> {
    const batch = await this.createBatch();
    let images: PreparedImageBatch;
    try {
      images = await prepareImageBatch(batch, request.pages);
      if (request.mode === "document" && request.customPrompt?.trim()) {
        await batch.write(
          "prompt.md",
          customDocumentPrompt(request.customPrompt),
        );
      }
    } catch (error) {
      return {
        remainingPageNumbers: [],
        transcribe: async () => ({
          pageText: new Map(),
          documentText: null,
          failedPages: request.pages.pageNumbers,
          errors: [`Transcription command failed: ${errorMessage(error)}`],
          retainedBatchPath: batch.folderPath,
        }),
      };
    }
    return {
      remainingPageNumbers: [],
      transcribe: () => this.transcribePrepared(request, batch, images),
    };
  }

  async transcribe(request: OcrRequest): Promise<OcrResult> {
    return (await this.prepare(request)).transcribe();
  }

  private async transcribePrepared(
    request: OcrRequest,
    batch: CommandOcrBatch,
    images: PreparedImageBatch,
  ): Promise<OcrResult> {
    const pageCount = request.pages.pageNumbers.length;
    const run = this.runs?.start({
      kind: "transcription",
      label: transcriptionRunLabel(request.note, pageCount),
      engine: "command",
      model: "custom command",
    });
    const failedPages = [...request.pages.pageNumbers];
    try {
      const command = this.command
        .replaceAll("{{folder}}", batch.folderPath)
        .replaceAll("{{note}}", request.note)
        .replaceAll("{{mode}}", request.mode);
      const result = run
        ? await this.runCommand(command, {
            timeoutMs: this.timeoutMs,
            observer: run.processObserver(),
          })
        : await this.runCommand(command, {
            timeoutMs: this.timeoutMs,
          });
      if (result.cancelled || result.timedOut || result.exitCode !== 0) {
        run?.finish(failedProcessRunStatus(result), {
          exitCode: result.exitCode,
          batchPath: batch.folderPath,
        });
        return {
          pageText: new Map(),
          documentText: null,
          failedPages,
          errors: [commandFailure(result)],
          retainedBatchPath: batch.folderPath,
        };
      }

      if (request.mode === "document") {
        const documentText = await batch.readText("document.md");
        if (!documentText?.trim()) {
          run?.finish("failed", {
            exitCode: result.exitCode,
            batchPath: batch.folderPath,
          });
          return {
            pageText: new Map(),
            documentText: null,
            failedPages,
            errors: ["Transcription command did not write document.md"],
            retainedBatchPath: batch.folderPath,
          };
        }
        await batch.remove();
        run?.finish("succeeded", { exitCode: result.exitCode });
        return {
          pageText: new Map(),
          documentText: documentText.trimEnd(),
          failedPages: [],
          errors: [],
        };
      }

      const pageText = new Map<number, string>();
      const missing: number[] = [];
      for (const pageNumber of request.pages.pageNumbers) {
        const text = await batch.readText(images.fileName(pageNumber, "md"));
        if (text?.trim()) {
          pageText.set(pageNumber, text.trimEnd());
        } else {
          missing.push(pageNumber);
        }
      }
      if (missing.length > 0) {
        run?.finish("failed", {
          exitCode: result.exitCode,
          batchPath: batch.folderPath,
        });
        return {
          pageText,
          documentText: null,
          failedPages: missing,
          errors: [
            `Transcription command did not write Markdown for page${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
          ],
          retainedBatchPath: batch.folderPath,
        };
      }
      await batch.remove();
      run?.finish("succeeded", { exitCode: result.exitCode });
      return {
        pageText,
        documentText: null,
        failedPages: [],
        errors: [],
      };
    } catch (error) {
      run?.finish("failed", { batchPath: batch.folderPath });
      return {
        pageText: new Map(),
        documentText: null,
        failedPages,
        errors: [`Transcription command failed: ${errorMessage(error)}`],
        retainedBatchPath: batch.folderPath,
      };
    }
  }
}
