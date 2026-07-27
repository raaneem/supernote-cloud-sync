import { Platform } from "obsidian";

import { BoundedTextBuffer } from "./bounded-text-buffer";

export interface DesktopBatch {
  folderPath: string;
  write(filename: string, content: Uint8Array | string): Promise<void>;
  readText(filename: string): Promise<string | null>;
  remove(): Promise<void>;
}

export interface DesktopCommandResult {
  exitCode: number | null;
  stdout?: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
}

export interface DesktopProcessObserver {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  setCancel?: (cancel: () => void) => void;
}

export interface DesktopHostDescriptor {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  arch?: string;
}

type DesktopProcessLauncher = typeof import("node:child_process").spawn;

export interface DesktopProcessOptions {
  timeoutMs?: number;
  cwd?: string;
  killGraceMs?: number;
  observer?: DesktopProcessObserver;
  input?: string;
  host?: DesktopHostDescriptor;
  launch?: DesktopProcessLauncher;
}

const realDesktopHost = (): DesktopHostDescriptor => ({
  platform: Platform.isWin ? "win32" : Platform.isMacOS ? "darwin" : "linux",
  env: process.env,
  arch: process.arch,
});

const isWindowsHost = (host: DesktopHostDescriptor): boolean =>
  host.platform === "win32";

export interface DesktopEnvironmentDetails {
  platform: NodeJS.Platform;
  architecture: string;
  homeDirectory: string | null;
}

export const desktopEnvironmentDetails = (
  host: DesktopHostDescriptor = realDesktopHost(),
): DesktopEnvironmentDetails => ({
  platform: host.platform,
  architecture: host.arch ?? "unknown",
  homeDirectory:
    (isWindowsHost(host) ? host.env.USERPROFILE : host.env.HOME) ?? null,
});

const CLI_IDENTIFIER = /^[A-Za-z0-9._:/@,+-]+$/;
const CLI_TOOL_LIST = /^[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*$/;
const BATCH_FILENAME = /^[A-Za-z0-9._-]+$/;

export const normalizeDesktopCliIdentifier = (
  label: string,
  value: string,
): string => {
  const trimmed = value.trim();
  if (trimmed && !CLI_IDENTIFIER.test(trimmed)) {
    throw new Error(
      `${label} may contain only ASCII letters, numbers, and CLI identifier punctuation`,
    );
  }
  return trimmed;
};

export const normalizeDesktopCliToolList = (
  label: string,
  value: string,
): string => {
  const trimmed = value.trim();
  if (trimmed && !CLI_TOOL_LIST.test(trimmed)) {
    throw new Error(
      `${label} must be a comma-separated list of CLI tool names`,
    );
  }
  return trimmed;
};

export const assertDesktopBatchFilenames = (
  files: readonly string[],
): readonly string[] => {
  for (const file of files) {
    if (!BATCH_FILENAME.test(file) || file === "." || file === "..") {
      throw new Error(
        `Automation image file must be a batch-relative filename: ${file}`,
      );
    }
  }
  return files;
};

export const desktopProcessExperimentalNote = (
  host: DesktopHostDescriptor = realDesktopHost(),
): string | null =>
  isWindowsHost(host)
    ? "Experimental — unverified on Windows; please report results."
    : null;

export const createDesktopBatch = async (
  prefix: string,
): Promise<DesktopBatch> => {
  const { mkdtemp, readFile, rm, writeFile } =
    require("node:fs/promises") as typeof import("node:fs/promises");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const folderPath = await mkdtemp(join(tmpdir(), prefix));
  return {
    folderPath,
    write: async (filename, content) => {
      await writeFile(join(folderPath, filename), content);
    },
    readText: async (filename) => {
      try {
        return await readFile(join(folderPath, filename), "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    remove: async () => {
      await rm(folderPath, { recursive: true, force: true });
    },
  };
};

const processInvocation = (
  file: string,
  args: readonly string[],
  host: DesktopHostDescriptor,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } => {
  if (isWindowsHost(host) && /\.(?:cmd|bat)$/i.test(file)) {
    const command = [file, ...args]
      .map((argument) => `"${argument.replaceAll("%", "%%")}"`)
      .join(" ");
    return {
      file: host.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file, args: [...args] };
};

export const spawnDesktopProcess = async (
  file: string,
  args: readonly string[],
  options: DesktopProcessOptions = {},
): Promise<DesktopCommandResult> => {
  const host = options.host ?? realDesktopHost();
  const windows = isWindowsHost(host);
  const launch =
    options.launch ??
    (require("node:child_process")
      .spawn as typeof import("node:child_process").spawn);
  const invocation = processInvocation(file, args, host);
  const child = launch(invocation.file, invocation.args, {
    detached: !windows,
    env: host.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: true }
      : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const stdout = new BoundedTextBuffer(64_000);
  const stderr = new BoundedTextBuffer(64_000);
  let timedOut = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout.append(chunk);
    options.observer?.onStdout?.(chunk);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr.append(chunk);
    options.observer?.onStderr?.(chunk);
  });
  child.stdin?.on("error", () => {
    // The child process result remains authoritative when it closes stdin early.
  });

  const completion = new Promise<DesktopCommandResult>((resolve, reject) => {
    let forceStop: ReturnType<typeof globalThis.setTimeout> | null = null;
    let cancelled = false;
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (windows && child.pid) {
        const killer = launch(
          "taskkill",
          [
            "/pid",
            String(child.pid),
            "/T",
            ...(signal === "SIGKILL" ? ["/F"] : []),
          ],
          { stdio: "ignore", windowsHide: true },
        );
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            // The child may already have failed to spawn or exited.
          }
        });
        return;
      }
      if (!windows && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The child may already have failed to spawn or exited.
      }
    };
    const stop = (fromTimeout: boolean): void => {
      timedOut = fromTimeout;
      killProcessGroup("SIGTERM");
      forceStop = globalThis.setTimeout(
        () => killProcessGroup("SIGKILL"),
        Math.max(1, options.killGraceMs ?? 2_000),
      );
    };
    const timeout = globalThis.setTimeout(
      () => {
        stop(true);
      },
      Math.max(1, options.timeoutMs ?? 10 * 60_000),
    );
    options.observer?.setCancel?.(() => {
      if (timedOut || cancelled) {
        return;
      }
      cancelled = true;
      globalThis.clearTimeout(timeout);
      stop(false);
    });
    child.once("error", (error) => {
      globalThis.clearTimeout(timeout);
      if (forceStop !== null) {
        globalThis.clearTimeout(forceStop);
      }
      reject(error);
    });
    child.once("close", (exitCode) => {
      globalThis.clearTimeout(timeout);
      if (forceStop !== null) {
        globalThis.clearTimeout(forceStop);
      }
      const output = stdout.text().trimEnd();
      resolve({
        exitCode,
        ...(output ? { stdout: output } : {}),
        stderr: stderr.text().trimEnd(),
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
      });
    });
  });

  child.stdin?.end(options.input ?? "");
  return completion;
};

export const runDesktopCommand = async (
  command: string,
  options: DesktopProcessOptions = {},
): Promise<DesktopCommandResult> => {
  const host = options.host ?? realDesktopHost();
  const windows = isWindowsHost(host);
  const shell = windows
    ? (host.env.ComSpec ?? "cmd.exe")
    : (host.env.SHELL ?? "/bin/sh");
  const args = windows ? ["/d", "/s", "/c", command] : ["-lc", command];
  return spawnDesktopProcess(shell, args, { ...options, host });
};

export type DesktopAgentBinary = "claude" | "codex";
export type DesktopBinaryUnavailableReason = "not-found" | "not-executable";
export type DesktopBinaryStatus =
  | { state: "unknown" }
  | { state: "checking" }
  | { state: "available"; path: string }
  | {
      state: "unavailable";
      reason: DesktopBinaryUnavailableReason;
    };

interface BinaryProbeAvailable {
  path: string;
}

interface BinaryProbeUnavailable {
  reason: DesktopBinaryUnavailableReason;
}

type BinaryProbeResult = BinaryProbeAvailable | BinaryProbeUnavailable;

type DesktopCommandRunner = (
  command: string,
  options?: DesktopProcessOptions,
) => Promise<DesktopCommandResult>;

type DesktopProcessRunner = (
  file: string,
  args: readonly string[],
  options?: DesktopProcessOptions,
) => Promise<DesktopCommandResult>;

export interface DesktopBinaryResolverOptions {
  host?: DesktopHostDescriptor;
  runCommand?: DesktopCommandRunner;
  runProcess?: DesktopProcessRunner;
  fileExists?: (path: string) => Promise<boolean>;
  pathOverride?: (binary: DesktopAgentBinary) => string;
}

const defaultFileExists = async (path: string): Promise<boolean> => {
  const { access } =
    require("node:fs/promises") as typeof import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export class DesktopBinaryResolver {
  private readonly cache = new Map<
    DesktopAgentBinary,
    Promise<string | null>
  >();
  private readonly statuses = new Map<
    DesktopAgentBinary,
    DesktopBinaryStatus
  >();
  private readonly configuredHost: DesktopHostDescriptor | undefined;
  private readonly runCommand: DesktopCommandRunner;
  private readonly runProcess: DesktopProcessRunner;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private readonly pathOverride: (binary: DesktopAgentBinary) => string;

  constructor(options: DesktopBinaryResolverOptions = {}) {
    this.configuredHost = options.host;
    this.runCommand =
      options.runCommand ??
      ((command, processOptions) =>
        runDesktopCommand(command, {
          ...processOptions,
          host: this.host,
        }));
    this.runProcess =
      options.runProcess ??
      ((file, args, processOptions) =>
        spawnDesktopProcess(file, args, {
          ...processOptions,
          host: this.host,
        }));
    this.fileExists = options.fileExists ?? defaultFileExists;
    this.pathOverride = options.pathOverride ?? (() => "");
  }

  private get host(): DesktopHostDescriptor {
    return this.configuredHost ?? realDesktopHost();
  }

  resolve(binary: DesktopAgentBinary): Promise<string | null> {
    let resolved = this.cache.get(binary);
    if (!resolved) {
      this.statuses.set(binary, { state: "checking" });
      resolved = this.probe(binary)
        .then((result) => {
          if ("path" in result) {
            this.statuses.set(binary, {
              state: "available",
              path: result.path,
            });
            return result.path;
          }
          this.statuses.set(binary, {
            state: "unavailable",
            reason: result.reason,
          });
          return null;
        })
        .catch(() => {
          this.statuses.delete(binary);
          this.cache.delete(binary);
          return null;
        });
      this.cache.set(binary, resolved);
    }
    return resolved;
  }

  status(binary: DesktopAgentBinary): DesktopBinaryStatus {
    return this.statuses.get(binary) ?? { state: "unknown" };
  }

  invalidate(binary: DesktopAgentBinary): void {
    this.cache.delete(binary);
    this.statuses.delete(binary);
  }

  redetect(binary: DesktopAgentBinary): Promise<string | null> {
    this.invalidate(binary);
    return this.resolve(binary);
  }

  async testCandidate(
    binary: DesktopAgentBinary,
    pathOverride: string,
  ): Promise<DesktopBinaryStatus> {
    try {
      const result = await this.probe(binary, pathOverride.trim());
      return "path" in result
        ? { state: "available", path: result.path }
        : { state: "unavailable", reason: result.reason };
    } catch {
      return {
        state: "unavailable",
        reason: pathOverride.trim() ? "not-executable" : "not-found",
      };
    }
  }

  async verify(binary: DesktopAgentBinary): Promise<boolean> {
    const current = this.status(binary);
    if (current.state !== "available") {
      return Boolean(await this.redetect(binary));
    }
    const result = await this.verifyPath(current.path);
    if ("path" in result) {
      return true;
    }
    this.cache.set(binary, Promise.resolve(null));
    this.statuses.set(binary, {
      state: "unavailable",
      reason: result.reason,
    });
    return false;
  }

  private async probe(
    binary: DesktopAgentBinary,
    override = this.pathOverride(binary).trim(),
  ): Promise<BinaryProbeResult> {
    if (override) {
      return this.verifyPath(override);
    }

    const windows = isWindowsHost(this.host);
    const command = windows ? `where.exe ${binary}` : `command -v ${binary}`;
    const result = await this.runCommand(command, { host: this.host });
    if (result.timedOut) {
      throw new Error(`Timed out while locating ${binary}`);
    }
    if (result.exitCode !== 0) {
      return { reason: "not-found" };
    }
    const resolved = this.selectCandidate(result.stdout ?? "");
    if (!resolved) {
      return { reason: "not-found" };
    }
    return this.verifyPath(resolved);
  }

  private selectCandidate(output: string): string | null {
    const windows = isWindowsHost(this.host);
    const { posix, win32 } = require("node:path") as typeof import("node:path");
    const pathApi = windows ? win32 : posix;
    const executableExtensions = new Set(
      (this.host.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim().toLocaleLowerCase())
        .filter(Boolean),
    );
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || !this.isAbsolutePath(candidate)) {
        continue;
      }
      if (
        windows &&
        !executableExtensions.has(
          pathApi.extname(candidate).toLocaleLowerCase(),
        )
      ) {
        continue;
      }
      return candidate;
    }
    return null;
  }

  private async verifyPath(path: string): Promise<BinaryProbeResult> {
    if (!this.isAbsolutePath(path) || !(await this.fileExists(path))) {
      return { reason: "not-found" };
    }
    try {
      const result = await this.runProcess(path, ["--version"], {
        timeoutMs: 15_000,
        host: this.host,
      });
      return !result.timedOut && result.exitCode === 0
        ? { path }
        : { reason: "not-executable" };
    } catch {
      return { reason: "not-executable" };
    }
  }

  private isAbsolutePath(path: string): boolean {
    const { posix, win32 } = require("node:path") as typeof import("node:path");
    return (isWindowsHost(this.host) ? win32 : posix).isAbsolute(path);
  }
}
