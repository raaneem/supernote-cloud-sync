import {
  assertDesktopBatchFilenames,
  normalizeDesktopCliIdentifier,
  normalizeDesktopCliToolList,
  spawnDesktopProcess,
  type DesktopCommandResult,
  type DesktopProcessOptions,
  type DesktopProcessObserver,
} from "../shared/desktop-command";

export type AutomationAgentEngine = "claude" | "codex";
export type CodexSandbox =
  | "workspace-write"
  | "read-only"
  | "danger-full-access";

export interface AutomationAgentRequest {
  engine: AutomationAgentEngine;
  batchPath: string;
  prompt: string;
  model: string;
  claudeAllowedTools: string;
  codexSandbox: CodexSandbox;
  imageFiles: readonly string[];
}

export type AutomationAgentProcessRunner = (
  file: string,
  args: readonly string[],
  options: DesktopProcessOptions,
) => Promise<DesktopCommandResult>;

interface AutomationAgentServiceOptions {
  resolveBinary: (engine: AutomationAgentEngine) => string | null;
  timeoutMs: number;
  runProcess?: AutomationAgentProcessRunner;
}

const claudeArgs = (request: AutomationAgentRequest): string[] => {
  const allowedTools = normalizeDesktopCliToolList(
    "Claude allowed tools",
    request.claudeAllowedTools,
  );
  const model = normalizeDesktopCliIdentifier("Claude model", request.model);
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--tools",
    allowedTools,
    "--allowedTools",
    allowedTools,
    ...(model ? ["--model", model] : []),
  ];
};

const codexArgs = (request: AutomationAgentRequest): string[] => {
  const model = normalizeDesktopCliIdentifier("Codex model", request.model);
  return [
    "exec",
    "--sandbox",
    request.codexSandbox,
    "--skip-git-repo-check",
    "--ephemeral",
    ...assertDesktopBatchFilenames(request.imageFiles).flatMap((file) => [
      "-i",
      file,
    ]),
    ...(model ? ["-m", model] : []),
    "-",
  ];
};

export class AutomationAgentService {
  private readonly resolveBinary: AutomationAgentServiceOptions["resolveBinary"];
  private readonly timeoutMs: number;
  private readonly runProcess: AutomationAgentProcessRunner;

  constructor(options: AutomationAgentServiceOptions) {
    this.resolveBinary = options.resolveBinary;
    this.timeoutMs = options.timeoutMs;
    this.runProcess =
      options.runProcess ??
      ((file, args, processOptions) =>
        spawnDesktopProcess(file, args, processOptions));
  }

  async run(
    request: AutomationAgentRequest,
    observer?: DesktopProcessObserver,
  ): Promise<DesktopCommandResult> {
    const binaryPath = this.resolveBinary(request.engine);
    if (!binaryPath) {
      const label = request.engine === "claude" ? "Claude Code" : "Codex CLI";
      throw new Error(`${label} is not available`);
    }
    const args =
      request.engine === "claude" ? claudeArgs(request) : codexArgs(request);
    return this.runProcess(binaryPath, args, {
      timeoutMs: this.timeoutMs,
      cwd: request.batchPath,
      input: request.prompt,
      ...(observer ? { observer } : {}),
    });
  }
}
