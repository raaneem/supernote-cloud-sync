import { describe, expect, it, vi } from "vitest";

import {
  AutomationAgentService,
  type AutomationAgentProcessRunner,
} from "../src/sync/automation-agent";

describe("AutomationAgentService", () => {
  it("runs Claude Code with the hook's tools and model", async () => {
    const runProcess = vi.fn<AutomationAgentProcessRunner>(async () => ({
      exitCode: 0,
      stderr: "",
      timedOut: false,
    }));
    const service = new AutomationAgentService({
      resolveBinary: (engine) =>
        engine === "claude" ? "/opt/homebrew/bin/claude" : null,
      timeoutMs: 600_000,
      runProcess,
    });

    await expect(
      service.run({
        engine: "claude",
        batchPath: "/tmp/supernote-automation-123",
        prompt: '/supernote-dispatch\n\n%PATH% & ^ "Automation context."',
        model: "sonnet",
        claudeAllowedTools: "Read,Write,Glob,Bash",
        codexSandbox: "workspace-write",
        imageFiles: ["page-02.png", "page-04.png"],
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });

    expect(runProcess).toHaveBeenCalledWith(
      "/opt/homebrew/bin/claude",
      [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--tools",
        "Read,Write,Glob,Bash",
        "--allowedTools",
        "Read,Write,Glob,Bash",
        "--model",
        "sonnet",
      ],
      {
        timeoutMs: 600_000,
        cwd: "/tmp/supernote-automation-123",
        input: '/supernote-dispatch\n\n%PATH% & ^ "Automation context."',
      },
    );
    const claudeArgv = runProcess.mock.calls[0]![1];
    expect(
      claudeArgv.every((argument) =>
        [...argument].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 33 && code <= 126;
        }),
      ),
    ).toBe(true);
  });

  it("attaches every rendered page to Codex and uses its sandbox", async () => {
    const runProcess = vi.fn<AutomationAgentProcessRunner>(async () => ({
      exitCode: 0,
      stderr: "",
      timedOut: false,
    }));
    const service = new AutomationAgentService({
      resolveBinary: (engine) =>
        engine === "codex" ? "/usr/local/bin/codex" : null,
      timeoutMs: 600_000,
      runProcess,
    });

    await service.run({
      engine: "codex",
      batchPath: "/tmp/supernote-automation-456",
      prompt: "Process the changed pages.",
      model: "",
      claudeAllowedTools: "Read,Write,Glob,Bash",
      codexSandbox: "read-only",
      imageFiles: ["page-01.png", "page-03.png"],
    });

    expect(runProcess).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "-i",
        "page-01.png",
        "-i",
        "page-03.png",
        "-",
      ],
      {
        timeoutMs: 600_000,
        cwd: "/tmp/supernote-automation-456",
        input: "Process the changed pages.",
      },
    );
    const codexArgv = runProcess.mock.calls[0]![1];
    expect(codexArgv).not.toContain("/tmp/supernote-automation-456");
    expect(
      codexArgv.every((argument) =>
        [...argument].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 33 && code <= 126;
        }),
      ),
    ).toBe(true);
  });

  it("rejects paths and free-form text before they can reach argv", async () => {
    const service = new AutomationAgentService({
      resolveBinary: () => "/usr/local/bin/codex",
      timeoutMs: 600_000,
      runProcess: vi.fn(),
    });

    await expect(
      service.run({
        engine: "codex",
        batchPath: "/tmp/batch",
        prompt: "Prompt",
        model: "",
        claudeAllowedTools: "Read,Write",
        codexSandbox: "workspace-write",
        imageFiles: ["../outside.png"],
      }),
    ).rejects.toThrow("batch-relative filename");

    await expect(
      service.run({
        engine: "claude",
        batchPath: "/tmp/batch",
        prompt: "Prompt",
        model: "",
        claudeAllowedTools: "Read, Bash(anything)",
        codexSandbox: "workspace-write",
        imageFiles: [],
      }),
    ).rejects.toThrow("comma-separated list");

    await expect(
      service.run({
        engine: "claude",
        batchPath: "/tmp/batch",
        prompt: "Prompt",
        model: "",
        claudeAllowedTools: "Read,C:/tmp",
        codexSandbox: "workspace-write",
        imageFiles: [],
      }),
    ).rejects.toThrow("comma-separated list");
  });
});
