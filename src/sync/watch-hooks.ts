import type { NotebookSessionProvider } from "../note/notebook-service";
import type {
  DesktopBatch,
  DesktopCommandResult,
  DesktopProcessObserver,
} from "../shared/desktop-command";
import { renderClaudeProcess } from "../run/claude-stream";
import { failedProcessRunStatus } from "../run/run-format";
import { RunRegistry } from "../run/run-registry";
import { sameMd5 } from "../shared/md5";
import {
  normalizeOptionalRelativePath,
  normalizeRelativePath,
} from "../shared/path";
import type {
  AutomationAgentEngine,
  AutomationAgentRequest,
  CodexSandbox,
} from "./automation-agent";
import { loadManifest, saveManifest } from "./manifest";
import type { VaultStore } from "./vault-store";

export type WatchHookFormat = "images" | "markdown";
export type WatchHookAction = "command" | AutomationAgentEngine;

export interface WatchHookDefinition {
  id: string;
  name: string;
  sourceNote: string;
  format: WatchHookFormat;
  action: WatchHookAction;
  command: string;
  prompt: string;
  model: string;
  claudeAllowedTools: string;
  codexSandbox: CodexSandbox;
  keepFolder: string;
}

export const getWatchHookRetentionWarning = (
  hook: Pick<WatchHookDefinition, "keepFolder">,
  targetFolder: string,
): string | null => {
  let keepFolder: string;
  let mirror: string;
  try {
    keepFolder = normalizeOptionalRelativePath(hook.keepFolder);
    mirror = normalizeOptionalRelativePath(targetFolder);
  } catch {
    return "Choose a keep folder inside the vault.";
  }
  return keepFolder &&
    mirror &&
    (keepFolder === mirror || keepFolder.startsWith(`${mirror}/`))
    ? "The Automation keep folder must be outside the Mirror."
    : null;
};

export type WatchBatch = Pick<DesktopBatch, "folderPath" | "write" | "remove">;

export type WatchCommandResult = DesktopCommandResult;

export const getWatchHookConfigurationWarning = (
  hook: Pick<
    WatchHookDefinition,
    "action" | "command" | "prompt" | "keepFolder"
  >,
  targetFolder = "",
): string | null => {
  const retentionWarning = targetFolder
    ? getWatchHookRetentionWarning(hook, targetFolder)
    : null;
  if (retentionWarning) {
    return retentionWarning;
  }
  const action = hook.action ?? "command";
  if (action !== "command" && !hook.prompt.trim()) {
    return `Add a prompt for the ${action === "claude" ? "Claude Code" : "Codex CLI"} Automation action.`;
  }
  return action === "command" && !hook.command.trim() && !hook.keepFolder.trim()
    ? "Add a command or a keep folder so the Automation output has a destination."
    : null;
};

export type WatchHookRunResult =
  | { status: "unchanged"; pages: [] }
  | { status: "mobile-unavailable"; pages: [] }
  | { status: "missing"; pages: [] }
  | {
      status: "delivered" | "persisted" | "failed";
      pages: number[];
      batchPath: string;
    };

interface WatchHookServiceOptions {
  vault: VaultStore;
  notebooks: NotebookSessionProvider;
  targetFolder: string;
  isDesktop: boolean;
  runs?: RunRegistry;
  createTempBatch?: () => Promise<WatchBatch>;
  runCommand?: (
    command: string,
    observer?: DesktopProcessObserver,
  ) => Promise<WatchCommandResult>;
  runAgent?: (
    request: AutomationAgentRequest,
    observer?: DesktopProcessObserver,
  ) => Promise<WatchCommandResult>;
  absoluteVaultPath?: (path: string) => string;
  batchName?: (hook: WatchHookDefinition) => string;
  notify?: (message: string) => void;
}

const STDERR_TAIL_LENGTH = 2_000;

const markdownForPage = (recognition: string | undefined): string =>
  recognition?.trim() ? `${recognition.trimEnd()}\n` : "";

const pageKey = (index: number): string => String(index + 1);

const defaultBatchName = (hook: WatchHookDefinition): string => {
  const name =
    hook.name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "automation";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${name}-${timestamp}-${hook.id.slice(0, 8)}`;
};

export class WatchHookService {
  private readonly vault: VaultStore;
  private readonly notebooks: NotebookSessionProvider;
  private readonly targetFolder: string;
  private readonly isDesktop: boolean;
  private readonly runs: RunRegistry | undefined;
  private readonly createTempBatch: (() => Promise<WatchBatch>) | undefined;
  private readonly runCommand:
    | ((
        command: string,
        observer?: DesktopProcessObserver,
      ) => Promise<WatchCommandResult>)
    | undefined;
  private readonly runAgent:
    | ((
        request: AutomationAgentRequest,
        observer?: DesktopProcessObserver,
      ) => Promise<WatchCommandResult>)
    | undefined;
  private readonly absoluteVaultPath: ((path: string) => string) | undefined;
  private readonly batchName: (hook: WatchHookDefinition) => string;
  private readonly notify: (message: string) => void;

  constructor(options: WatchHookServiceOptions) {
    this.vault = options.vault;
    this.notebooks = options.notebooks;
    this.targetFolder = normalizeRelativePath(options.targetFolder);
    this.isDesktop = options.isDesktop;
    this.runs = options.runs;
    this.createTempBatch = options.createTempBatch;
    this.runCommand = options.runCommand;
    this.runAgent = options.runAgent;
    this.absoluteVaultPath = options.absoluteVaultPath;
    this.batchName = options.batchName ?? defaultBatchName;
    this.notify = options.notify ?? (() => undefined);
  }

  get manifestPath(): string {
    return `${this.targetFolder}/.sync-manifest.json`;
  }

  async run(hook: WatchHookDefinition): Promise<WatchHookRunResult> {
    if (!hook.sourceNote.trim()) {
      this.notify(`Automation "${hook.name}" does not have a source notebook.`);
      return { status: "missing", pages: [] };
    }
    const manifest = await loadManifest(this.vault, this.manifestPath);
    const sourceNote = normalizeRelativePath(hook.sourceNote);
    const entry = Object.values(manifest.files).find(
      (candidate) => candidate.vaultPath === sourceNote,
    );
    if (!entry) {
      this.notify(
        `Automation "${hook.name}" cannot find ${sourceNote} in the mirror.`,
      );
      return { status: "missing", pages: [] };
    }
    const previous = entry.watchHooks?.[hook.id];
    if (previous && sameMd5(previous.noteMd5, entry.md5)) {
      return { status: "unchanged", pages: [] };
    }

    const keepFolder = normalizeOptionalRelativePath(hook.keepFolder);
    if (!this.isDesktop && !keepFolder) {
      return { status: "mobile-unavailable", pages: [] };
    }
    if (
      keepFolder &&
      (keepFolder === this.targetFolder ||
        keepFolder.startsWith(`${this.targetFolder}/`))
    ) {
      throw new Error(
        `Automation keep folder cannot be inside the mirror: ${keepFolder}`,
      );
    }

    const revisionBefore = await this.vault.getRevision(sourceNote);
    const bytes = await this.vault.readBinary(sourceNote);
    const revisionAfter = await this.vault.getRevision(sourceNote);
    if (bytes === null || !revisionBefore || !revisionAfter) {
      this.notify(`Automation "${hook.name}" cannot read ${sourceNote}.`);
      return { status: "missing", pages: [] };
    }
    if (revisionBefore !== revisionAfter) {
      throw new Error(
        `Supernote notebook changed while Automation "${hook.name}" was preparing; retry the run`,
      );
    }
    const session = await this.notebooks.open({
      path: sourceNote,
      revision: revisionAfter,
      bytes,
    });
    try {
      const descriptor = session.descriptor;
      const pageMd5s = descriptor.pages.map((page) => page.fingerprint);
      const changedPages = pageMd5s.flatMap((pageMd5, index) =>
        !previous || !sameMd5(previous.pageMd5s[pageKey(index)] ?? "", pageMd5)
          ? [index + 1]
          : [],
      );
      const commit = (): Promise<void> =>
        this.commitState(entry.remoteId, hook.id, entry.md5, pageMd5s);
      if (changedPages.length === 0) {
        await commit();
        return { status: "unchanged", pages: [] };
      }

      const batch = keepFolder
        ? this.createVaultBatch(
            `${keepFolder}/${normalizeRelativePath(this.batchName(hook))}`,
          )
        : await this.requireTempBatch();
      const batchPath = batch.folderPath;
      const fail = (message: string): WatchHookRunResult => {
        this.notify(message);
        return {
          status: "failed",
          pages: changedPages,
          batchPath,
        };
      };
      const batchFiles: string[] = [];
      const imageFiles: string[] = [];
      const action = hook.action ?? "command";
      try {
        const width = Math.max(2, String(pageMd5s.length).length);
        if (action !== "command" || hook.format === "images") {
          for (const pageNumber of changedPages) {
            const page = await session.renderPng(pageNumber, 1);
            const filename = `page-${String(pageNumber).padStart(width, "0")}.png`;
            await batch.write(filename, page.png);
            batchFiles.push(filename);
            imageFiles.push(filename);
          }
        } else {
          for (const pageNumber of changedPages) {
            const filename = `page-${String(pageNumber).padStart(width, "0")}.md`;
            await batch.write(
              filename,
              markdownForPage(
                descriptor.pages[pageNumber - 1]?.recognitionText ?? undefined,
              ),
            );
            batchFiles.push(filename);
          }
        }
      } catch (error) {
        return fail(
          `Automation "${hook.name}" could not render its batch: ${this.errorMessage(error)}`,
        );
      }
      session.close();

      const actionConfigured =
        action === "command" ? hook.command.trim() : hook.prompt.trim();
      if (!actionConfigured || !this.isDesktop) {
        await commit();
        return {
          status: "persisted",
          pages: changedPages,
          batchPath,
        };
      }

      let result: WatchCommandResult;
      const run = this.runs?.start({
        kind: "automation",
        label: hook.name,
        engine: action,
        model:
          action === "command"
            ? "custom command"
            : hook.model.trim() || "default",
      });
      const streamed =
        action === "claude" && run
          ? renderClaudeProcess(run.processObserver())
          : null;
      const observer = streamed?.observer ?? run?.processObserver();
      try {
        if (action === "command") {
          const command = hook.command
            .replaceAll("{{folder}}", batch.folderPath)
            .replaceAll("{{note}}", sourceNote);
          if (!this.runCommand) {
            run?.finish("failed", { batchPath });
            return fail(
              `Automation "${hook.name}" has no runnable desktop command. Batch kept at ${batchPath}.`,
            );
          }
          result = observer
            ? await this.runCommand(command, observer)
            : await this.runCommand(command);
        } else {
          if (!this.runAgent) {
            run?.finish("failed", { batchPath });
            return fail(
              `Automation "${hook.name}" has no runnable ${action === "claude" ? "Claude Code" : "Codex CLI"} action. Batch kept at ${batchPath}.`,
            );
          }
          const request = {
            engine: action,
            batchPath,
            prompt: this.agentPrompt(
              hook.prompt,
              sourceNote,
              changedPages,
              batchFiles,
            ),
            model: hook.model,
            claudeAllowedTools: hook.claudeAllowedTools,
            codexSandbox: hook.codexSandbox,
            imageFiles,
          } satisfies AutomationAgentRequest;
          result = observer
            ? await this.runAgent(request, observer)
            : await this.runAgent(request);
        }
      } catch (error) {
        run?.finish("failed", { batchPath });
        return fail(
          `Automation "${hook.name}" failed to start. Batch kept at ${batchPath}. ${this.errorMessage(error)}`,
        );
      } finally {
        streamed?.flush();
      }
      if (result.cancelled || result.exitCode !== 0 || result.timedOut) {
        run?.finish(failedProcessRunStatus(result), {
          exitCode: result.exitCode,
          batchPath,
        });
        const tail = result.stderr.slice(-STDERR_TAIL_LENGTH).trim();
        const reason = result.cancelled
          ? "was cancelled"
          : result.timedOut
            ? "timed out"
            : `exited with code ${String(result.exitCode)}`;
        return fail(
          `Automation "${hook.name}" ${reason}. Batch kept at ${batchPath}.` +
            (tail ? `\n${tail}` : ""),
        );
      }

      let batchRetained = true;
      try {
        if (!keepFolder) {
          await batch.remove();
          batchRetained = false;
        }
        await commit();
      } catch (error) {
        run?.finish("failed", {
          ...(batchRetained ? { batchPath } : {}),
        });
        return fail(
          `Automation "${hook.name}" could not finalize.` +
            (batchRetained
              ? ` Batch kept at ${batchPath}.`
              : " The temporary batch was already cleaned up.") +
            ` ${this.errorMessage(error)}`,
        );
      }
      run?.finish("succeeded", {
        exitCode: result.exitCode,
        ...(keepFolder ? { batchPath } : {}),
      });
      return {
        status: "delivered",
        pages: changedPages,
        batchPath,
      };
    } finally {
      session.close();
    }
  }

  private agentPrompt(
    prompt: string,
    sourceNote: string,
    changedPages: readonly number[],
    batchFiles: readonly string[],
  ): string {
    return `${prompt}\n\nSupernote Automation context:
- Source note: ${sourceNote}
- Changed pages: ${changedPages.join(", ")}
- Batch files: ${batchFiles.join(", ")}
- Page link format: [[${sourceNote}#page=NN]]
The batch files are in the current working directory.`;
  }

  private createVaultBatch(vaultPath: string): WatchBatch {
    return {
      folderPath:
        this.isDesktop && this.absoluteVaultPath
          ? this.absoluteVaultPath(vaultPath)
          : vaultPath,
      write: async (filename, content) => {
        const path = `${vaultPath}/${filename}`;
        if (typeof content === "string") {
          await this.vault.writeText(path, content);
        } else {
          await this.vault.writeBinary(path, content);
        }
      },
      remove: async () => undefined,
    };
  }

  private async requireTempBatch(): Promise<WatchBatch> {
    if (!this.createTempBatch) {
      throw new Error("Temporary automation batches require desktop");
    }
    return this.createTempBatch();
  }

  private async commitState(
    remoteId: string,
    hookId: string,
    noteMd5: string,
    pageMd5s: readonly string[],
  ): Promise<void> {
    const manifest = await loadManifest(this.vault, this.manifestPath);
    const entry = manifest.files[remoteId];
    if (!entry) {
      throw new Error("Automation source disappeared from the manifest");
    }
    entry.watchHooks ??= {};
    entry.watchHooks[hookId] = {
      noteMd5,
      pageMd5s: Object.fromEntries(
        pageMd5s.map((pageMd5, index) => [pageKey(index), pageMd5]),
      ),
    };
    await saveManifest(this.vault, this.manifestPath, manifest);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unexpected error";
  }
}
