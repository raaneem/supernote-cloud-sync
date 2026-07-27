import {
  createDesktopBatch,
  normalizeDesktopCliIdentifier,
  spawnDesktopProcess,
  type DesktopBatch,
  type DesktopCommandResult,
  type DesktopProcessOptions,
} from "../shared/desktop-command";
import { renderClaudeProcess } from "../run/claude-stream";
import {
  failedProcessRunStatus,
  transcriptionRunLabel,
} from "../run/run-format";
import { RunRegistry } from "../run/run-registry";
import { prepareImageBatch, type PreparedImageBatch } from "./image-batch";
import { customDocumentPrompt, TRANSCRIPTION_PROMPT } from "./prompt";
import type { OcrPort, OcrRequest, OcrResult, PreparedOcr } from "./types";

export type AgentEngine = "claude" | "codex";
export type AgentOcrBatch = DesktopBatch;
export type AgentProcessRunner = (
  file: string,
  args: readonly string[],
  options: DesktopProcessOptions,
) => Promise<DesktopCommandResult>;

interface AgentOcrBaseOptions {
  binaryPath: string;
  model: string;
  timeoutMs: number;
  runs?: RunRegistry;
  createBatch?: () => Promise<AgentOcrBatch>;
  runProcess?: AgentProcessRunner;
}

type AgentOcrOptions = AgentOcrBaseOptions &
  (
    | {
        engine: "claude";
        maxBudgetUsd: number;
      }
    | {
        engine: "codex";
      }
  );

const engineLabel = (engine: AgentEngine): string =>
  engine === "claude" ? "Claude Code" : "Codex CLI";

const buildAgentPrompt = (request: OcrRequest): string => {
  if (request.mode === "page") {
    return `Read every page-*.png image in this folder.

${TRANSCRIPTION_PROMPT}

For each image, use the available file tools to create a sibling Markdown file with the identical basename; for example, page-01.png becomes page-01.md.
Process every image. Do not create document.md.
Source notebook for context only: ${request.note}`;
  }

  const instructions = request.customPrompt?.trim()
    ? customDocumentPrompt(request.customPrompt)
    : `${TRANSCRIPTION_PROMPT}
Preserve cross-page continuity across the images in lexicographic page order.`;
  return `Read every page-*.png image in this folder in lexicographic page order.

${instructions}

Use the available file tools to write the final Markdown document to exactly one output file named document.md. Do not create per-page Markdown files.
Source notebook for context only: ${request.note}`;
};

const processFailure = (
  engine: AgentEngine,
  result: DesktopCommandResult,
): string => {
  const detail = result.stderr.trim();
  if (result.cancelled) {
    return `${engineLabel(engine)} was cancelled${detail ? `: ${detail}` : ""}`;
  }
  if (result.timedOut) {
    return `${engineLabel(engine)} timed out${detail ? `: ${detail}` : ""}`;
  }
  return (
    `${engineLabel(engine)} exited with code ${result.exitCode ?? "unknown"}` +
    (detail ? `: ${detail}` : "")
  );
};

export class AgentOcrService implements OcrPort {
  private readonly engine: AgentEngine;
  private readonly binaryPath: string;
  private readonly model: string;
  private readonly claudeMaxBudgetUsd: number;
  private readonly timeoutMs: number;
  private readonly runs: RunRegistry | undefined;
  private readonly createBatch: () => Promise<AgentOcrBatch>;
  private readonly runProcess: AgentProcessRunner;

  constructor(options: AgentOcrOptions) {
    this.engine = options.engine;
    this.binaryPath = options.binaryPath;
    this.model = normalizeDesktopCliIdentifier(
      `${engineLabel(options.engine)} model`,
      options.model,
    );
    this.claudeMaxBudgetUsd =
      options.engine === "claude" ? Math.max(0, options.maxBudgetUsd) : 0;
    this.timeoutMs = options.timeoutMs;
    this.runs = options.runs;
    this.createBatch =
      options.createBatch ?? (() => createDesktopBatch("supernote-agent-"));
    this.runProcess =
      options.runProcess ??
      ((file, args, processOptions) =>
        spawnDesktopProcess(file, args, processOptions));
  }

  async prepare(request: OcrRequest): Promise<PreparedOcr> {
    const batch = await this.createBatch();
    let images: PreparedImageBatch;
    try {
      images = await prepareImageBatch(batch, request.pages);
    } catch (error) {
      return {
        remainingPageNumbers: [],
        transcribe: async () => ({
          pageText: new Map(),
          documentText: null,
          failedPages: request.pages.pageNumbers,
          errors: [
            `${engineLabel(this.engine)} failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          ],
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
    batch: AgentOcrBatch,
    images: PreparedImageBatch,
  ): Promise<OcrResult> {
    const run = this.runs?.start({
      kind: "transcription",
      label: transcriptionRunLabel(
        request.note,
        request.pages.pageNumbers.length,
      ),
      engine: this.engine,
      model: this.model || "default",
    });
    const failedPages = [...request.pages.pageNumbers];
    try {
      const prompt = buildAgentPrompt(request);
      const args =
        this.engine === "claude" ? this.claudeArgs() : this.codexArgs();
      const streamed =
        this.engine === "claude" && run
          ? renderClaudeProcess(run.processObserver())
          : null;
      let result: DesktopCommandResult;
      try {
        const observer = streamed?.observer ?? run?.processObserver();
        result = await this.runProcess(this.binaryPath, args, {
          timeoutMs: this.timeoutMs,
          cwd: batch.folderPath,
          input: prompt,
          ...(observer ? { observer } : {}),
        });
      } finally {
        streamed?.flush();
      }
      if (result.cancelled || result.timedOut || result.exitCode !== 0) {
        run?.finish(failedProcessRunStatus(result), {
          exitCode: result.exitCode,
          batchPath: batch.folderPath,
        });
        return {
          pageText: new Map(),
          documentText: null,
          failedPages,
          errors: [processFailure(this.engine, result)],
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
            errors: [`${engineLabel(this.engine)} did not write document.md`],
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
            `${engineLabel(this.engine)} did not write Markdown for page${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
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
        errors: [
          `${engineLabel(this.engine)} failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        ],
        retainedBatchPath: batch.folderPath,
      };
    }
  }

  private claudeArgs(): string[] {
    return [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--no-session-persistence",
      "--effort",
      "low",
      "--tools",
      "Read,Write,Glob",
      "--allowedTools",
      "Read,Write,Glob",
      "--max-budget-usd",
      this.claudeMaxBudgetUsd.toFixed(2),
      ...(this.model ? ["--model", this.model] : []),
    ];
  }

  private codexArgs(): string[] {
    return [
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      ...(this.model ? ["-m", this.model] : []),
      "-",
    ];
  }
}
