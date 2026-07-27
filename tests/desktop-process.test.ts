import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  desktopEnvironmentDetails,
  desktopProcessExperimentalNote,
  DesktopBinaryResolver,
  runDesktopCommand,
  spawnDesktopProcess,
  type DesktopProcessObserver,
} from "../src/shared/desktop-command";

const completedChild = () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 1234,
    kill: vi.fn(),
  });
  queueMicrotask(() => child.emit("close", 0));
  return child;
};

describe("desktop process runner", () => {
  it("reports injected platform diagnostics without exposing environment values", () => {
    expect(
      desktopEnvironmentDetails({
        platform: "win32",
        arch: "x64",
        env: { USERPROFILE: "C:\\Users\\Alice" },
      }),
    ).toEqual({
      platform: "win32",
      architecture: "x64",
      homeDirectory: "C:\\Users\\Alice",
    });
  });

  it("labels the Windows process surface without labelling POSIX", () => {
    expect(
      desktopProcessExperimentalNote({
        platform: "win32",
        env: {},
      }),
    ).toBe("Experimental — unverified on Windows; please report results.");
    expect(
      desktopProcessExperimentalNote({
        platform: "linux",
        env: {},
      }),
    ).toBeNull();
  });

  it("passes argv literally without a shell and uses the requested cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "supernote-process-test-"));
    const script = join(root, "capture.mjs");
    await writeFile(
      script,
      `console.log(\`cwd=\${process.cwd()}\`);
for (const argument of process.argv.slice(2)) {
  console.log(\`arg=\${argument}\`);
}
`,
    );

    try {
      const result = await spawnDesktopProcess(
        process.execPath,
        [script, "hello world", "$(not-a-shell-command)"],
        { timeoutMs: 5_000, cwd: root },
      );

      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      });
      expect(result.stdout).toContain("supernote-process-test-");
      expect(result.stdout).toContain("arg=hello world");
      expect(result.stdout).toContain("arg=$(not-a-shell-command)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drives POSIX and Windows command shells through an injected host", async () => {
    const posixLaunch = vi.fn(() => completedChild() as never);
    const windowsLaunch = vi.fn(() => completedChild() as never);

    await runDesktopCommand("echo ready", {
      host: {
        platform: "darwin",
        env: { SHELL: "/bin/zsh" },
      },
      launch: posixLaunch,
    });
    await runDesktopCommand("echo ready", {
      host: {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      },
      launch: windowsLaunch,
    });

    expect(posixLaunch).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lc", "echo ready"],
      expect.objectContaining({ detached: true }),
    );
    expect(windowsLaunch).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "echo ready"],
      expect.objectContaining({ detached: false }),
    );
  });

  it("delivers stdin byte-for-byte and closes the pipe", async () => {
    const input = 'first line\n%PATH% & ^ "quoted"\nlast line';

    await expect(
      spawnDesktopProcess(
        process.execPath,
        ["-e", "process.stdin.pipe(process.stdout)"],
        {
          timeoutMs: 5_000,
          input,
        },
      ),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: input,
      timedOut: false,
    });
  });

  it("invokes Windows command shims through cmd.exe", async () => {
    const child = completedChild();
    let receivedInput = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      receivedInput += chunk;
    });
    const launch = vi.fn(() => child as never);
    const input = 'line one\r\n%PATH% & ^ "quoted"\r\nline three';

    await spawnDesktopProcess(
      "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd",
      ["exec", "--sandbox", "workspace-write", "-"],
      {
        host: {
          platform: "win32",
          env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        },
        launch,
        input,
      },
    );

    expect(launch).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd" "exec" "--sandbox" "workspace-write" "-""',
      ],
      expect.objectContaining({
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: true,
      }),
    );
    expect(receivedInput).toBe(input);
  });

  it("resolves each CLI through the login shell once per session", async () => {
    const commands: string[] = [];
    const resolver = new DesktopBinaryResolver({
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: "/opt/homebrew/bin/claude\n",
          stderr: "",
          timedOut: false,
        };
      },
      fileExists: async () => true,
      runProcess: async () => ({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      }),
    });

    expect(resolver.status("claude")).toEqual({
      state: "unknown",
    });
    await expect(resolver.resolve("claude")).resolves.toBe(
      "/opt/homebrew/bin/claude",
    );
    expect(resolver.status("claude")).toEqual({
      state: "available",
      path: "/opt/homebrew/bin/claude",
    });
    await expect(resolver.resolve("claude")).resolves.toBe(
      "/opt/homebrew/bin/claude",
    );
    expect(commands).toEqual(["command -v claude"]);
  });

  it("invalidates a cached result when its path override changes", async () => {
    const resolver = new DesktopBinaryResolver({
      runCommand: async () => ({
        exitCode: 1,
        stderr: "",
        timedOut: false,
      }),
    });

    await resolver.resolve("claude");
    expect(resolver.status("claude")).toEqual({
      state: "unavailable",
      reason: "not-found",
    });

    resolver.invalidate("claude");

    expect(resolver.status("claude")).toEqual({ state: "unknown" });
  });

  it("tests a draft override without changing active resolution state", async () => {
    const tested: string[] = [];
    const resolver = new DesktopBinaryResolver({
      pathOverride: () => "/active/claude",
      fileExists: async () => true,
      runProcess: async (file) => {
        tested.push(file);
        return {
          exitCode: file === "/draft/claude" ? 0 : 1,
          stderr: "",
          timedOut: false,
        };
      },
    });

    await resolver.resolve("claude");
    expect(resolver.status("claude")).toEqual({
      state: "unavailable",
      reason: "not-executable",
    });

    await expect(
      resolver.testCandidate("claude", "/draft/claude"),
    ).resolves.toEqual({
      state: "available",
      path: "/draft/claude",
    });
    expect(resolver.status("claude")).toEqual({
      state: "unavailable",
      reason: "not-executable",
    });
    expect(tested).toEqual(["/active/claude", "/draft/claude"]);
  });

  it("uses where.exe and PATHEXT when Windows is injected", async () => {
    const commands: string[] = [];
    const verified: string[] = [];
    const resolver = new DesktopBinaryResolver({
      host: {
        platform: "win32",
        env: { PATHEXT: ".EXE;.CMD;.BAT" },
      },
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout:
            "C:\\tools\\codex.ps1\r\nC:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd\r\nC:\\tools\\codex.exe\r\n",
          stderr: "",
          timedOut: false,
        };
      },
      fileExists: async () => true,
      runProcess: async (file) => {
        verified.push(file);
        return { exitCode: 0, stderr: "", timedOut: false };
      },
    });

    await expect(resolver.resolve("codex")).resolves.toBe(
      "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd",
    );
    expect(commands).toEqual(["where.exe codex"]);
    expect(verified).toEqual([
      "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd",
    ]);
  });

  it("lets an override bypass discovery and distinguishes an unspawnable target", async () => {
    const runCommand = vi.fn();
    const resolver = new DesktopBinaryResolver({
      pathOverride: () => "/custom/claude",
      runCommand,
      fileExists: async () => true,
      runProcess: async () => {
        throw new Error("EACCES");
      },
    });

    await expect(resolver.resolve("claude")).resolves.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(resolver.status("claude")).toEqual({
      state: "unavailable",
      reason: "not-executable",
    });
  });

  it("rejects a relative CLI path override without probing or executing it", async () => {
    const runCommand = vi.fn();
    const runProcess = vi.fn();
    const resolver = new DesktopBinaryResolver({
      pathOverride: () => "tools/claude",
      runCommand,
      runProcess,
      fileExists: async () => true,
    });

    await expect(resolver.resolve("claude")).resolves.toBeNull();
    expect(resolver.status("claude")).toEqual({
      state: "unavailable",
      reason: "not-found",
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("clears a cached result before re-detecting", async () => {
    let detected = "/usr/local/bin/claude";
    const resolver = new DesktopBinaryResolver({
      runCommand: async () => ({
        exitCode: 0,
        stdout: detected,
        stderr: "",
        timedOut: false,
      }),
      fileExists: async () => true,
      runProcess: async () => ({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      }),
    });

    await expect(resolver.resolve("claude")).resolves.toBe(detected);
    detected = "/opt/homebrew/bin/claude";
    await expect(resolver.resolve("claude")).resolves.toBe(
      "/usr/local/bin/claude",
    );
    await expect(resolver.redetect("claude")).resolves.toBe(detected);
  });

  it("re-verifies the current resolved target without probing PATH", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "/usr/local/bin/codex",
      stderr: "",
      timedOut: false,
    }));
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      timedOut: false,
    }));
    const resolver = new DesktopBinaryResolver({
      runCommand,
      runProcess,
      fileExists: async () => true,
    });

    await expect(resolver.resolve("codex")).resolves.toBe(
      "/usr/local/bin/codex",
    );
    await expect(resolver.verify("codex")).resolves.toBe(true);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runProcess).toHaveBeenCalledTimes(2);
  });

  it("reports checking while a first-use resolution is pending", async () => {
    let complete:
      | ((result: {
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        }) => void)
      | undefined;
    const resolver = new DesktopBinaryResolver({
      runCommand: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      fileExists: async () => true,
      runProcess: async () => ({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      }),
    });

    const resolving = resolver.resolve("codex");

    expect(resolver.status("codex")).toEqual({
      state: "checking",
    });
    complete?.({
      exitCode: 0,
      stdout: "/opt/homebrew/bin/codex",
      stderr: "",
      timedOut: false,
    });
    await expect(resolving).resolves.toBe("/opt/homebrew/bin/codex");
  });

  it("streams stdout and stderr while retaining result tails", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const observer: DesktopProcessObserver = {
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    };

    const result = await spawnDesktopProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write('out-one\\nout-two\\n'); process.stderr.write('err-one\\n')",
      ],
      {
        timeoutMs: 5_000,
        observer,
      },
    );

    expect(stdout.join("")).toBe("out-one\nout-two\n");
    expect(stderr.join("")).toBe("err-one\n");
    expect(result).toMatchObject({
      stdout: "out-one\nout-two",
      stderr: "err-one",
      timedOut: false,
    });
  });

  it("exposes cancellation through the existing process-group stop path", async () => {
    let cancel: (() => void) | undefined;
    const running = spawnDesktopProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        timeoutMs: 5_000,
        killGraceMs: 20,
        observer: {
          setCancel: (stop) => {
            cancel = stop;
          },
        },
      },
    );

    expect(cancel).toBeTypeOf("function");
    cancel?.();

    await expect(running).resolves.toMatchObject({
      timedOut: false,
      cancelled: true,
    });
  });

  it("rejects non-absolute shell resolutions", async () => {
    const resolver = new DesktopBinaryResolver({
      runCommand: async () => ({
        exitCode: 0,
        stdout: "claude",
        stderr: "",
        timedOut: false,
      }),
    });

    await expect(resolver.resolve("claude")).resolves.toBeNull();
    expect(resolver.status("claude")).toEqual({
      state: "unavailable",
      reason: "not-found",
    });
  });

  it("keeps transient probe failures retryable", async () => {
    let attempts = 0;
    const resolver = new DesktopBinaryResolver({
      runCommand: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            exitCode: null,
            stdout: "",
            stderr: "",
            timedOut: true,
          };
        }
        return {
          exitCode: 0,
          stdout: "/opt/homebrew/bin/codex",
          stderr: "",
          timedOut: false,
        };
      },
      fileExists: async () => true,
      runProcess: async () => ({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      }),
    });

    await expect(resolver.resolve("codex")).resolves.toBeNull();
    expect(resolver.status("codex")).toEqual({ state: "unknown" });

    await expect(resolver.resolve("codex")).resolves.toBe(
      "/opt/homebrew/bin/codex",
    );
    expect(attempts).toBe(2);
    expect(resolver.status("codex")).toEqual({
      state: "available",
      path: "/opt/homebrew/bin/codex",
    });
  });
});
