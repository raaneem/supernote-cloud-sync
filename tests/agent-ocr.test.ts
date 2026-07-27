import { describe, expect, it, vi } from "vitest";

import {
  AgentOcrService,
  type AgentOcrBatch,
  type AgentProcessRunner,
} from "../src/ocr/agent-ocr";
import { RunRegistry } from "../src/run/run-registry";
import { fixedOcrPageSource } from "./ocr-page-source";

const setup = () => {
  const files = new Map<string, Uint8Array | string>();
  const batch: AgentOcrBatch = {
    folderPath: "/tmp/supernote-agent-123",
    write: vi.fn(async (name, content) => {
      files.set(name, content);
    }),
    readText: vi.fn(async (name) => {
      const content = files.get(name);
      return typeof content === "string" ? content : null;
    }),
    remove: vi.fn(async () => undefined),
  };
  const runProcess = vi.fn<AgentProcessRunner>(async () => ({
    exitCode: 0,
    stderr: "",
    timedOut: false,
  }));
  return { files, batch, runProcess };
};

describe("AgentOcrService", () => {
  it("runs Claude Code with pinned shell-free argv and its default model", async () => {
    const context = setup();
    const runs = new RunRegistry({ id: () => "claude-run" });
    context.runProcess.mockImplementation(async (_file, _args, options) => {
      options.observer?.onStdout?.(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          model: "sonnet",
        })}\n`,
      );
      context.files.set("page-01.md", "first");
      context.files.set("page-02.md", "second");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    const service = new AgentOcrService({
      engine: "claude",
      binaryPath: "/opt/homebrew/bin/claude",
      model: "",
      maxBudgetUsd: 2,
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runProcess: context.runProcess,
      runs,
    });

    const pages = fixedOcrPageSource(
      [1, 2].map((pageNumber) => ({
        pageNumber,
        image: new Uint8Array([pageNumber]),
      })),
    );
    const render = vi.spyOn(pages, "render");
    const prepared = await service.prepare({
      mode: "page",
      note: "supernote/Note/Scratch.note",
      pages,
    });
    expect(context.runProcess).not.toHaveBeenCalled();
    const result = await prepared.transcribe();

    const [file, args, options] = context.runProcess.mock.calls[0]!;
    expect(file).toBe("/opt/homebrew/bin/claude");
    expect(args).toEqual([
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
      "2.00",
    ]);
    expect(options.input).toContain("page-01.png becomes page-01.md");
    expect(args).not.toContain("--model");
    expect(options.timeoutMs).toBe(600_000);
    expect(options.cwd).toBe("/tmp/supernote-agent-123");
    expect(context.files.has("prompt.md")).toBe(false);
    expect(render.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
    expect(result.pageText).toEqual(
      new Map([
        [1, "first"],
        [2, "second"],
      ]),
    );
    expect(context.batch.remove).toHaveBeenCalledTimes(1);
    expect(runs.records()[0]).toMatchObject({
      status: "succeeded",
    });
    expect(runs.logText("claude-run")).toContain("session started (sonnet)");
  });

  it("runs Codex with pinned argv, a selected model, and inline document instructions", async () => {
    const context = setup();
    context.runProcess.mockImplementation(async () => {
      context.files.set("document.md", "# Project brief");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    const service = new AgentOcrService({
      engine: "codex",
      binaryPath: "/usr/local/bin/codex",
      model: "gpt-5.3-codex",
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runProcess: context.runProcess,
    });

    const pages = fixedOcrPageSource([
      { pageNumber: 3, image: new Uint8Array([3]) },
    ]);
    const render = vi.spyOn(pages, "render");
    const result = await service.transcribe({
      mode: "document",
      note: "supernote/Note/Journal.note",
      customPrompt: "Create a concise project brief.",
      pages,
    });

    const [file, args, options] = context.runProcess.mock.calls[0]!;
    expect(file).toBe("/usr/local/bin/codex");
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "-m",
      "gpt-5.3-codex",
      "-",
    ]);
    expect(options.input).toContain("Create a concise project brief.");
    expect(options.input).toContain("document.md");
    expect(options.cwd).toBe("/tmp/supernote-agent-123");
    expect(context.files.has("prompt.md")).toBe(false);
    expect(render).toHaveBeenCalledOnce();
    expect(result.documentText).toBe("# Project brief");
    expect(context.batch.remove).toHaveBeenCalledTimes(1);
  });

  it("passes a selected Claude alias as a model flag", async () => {
    const context = setup();
    context.runProcess.mockImplementation(async () => {
      context.files.set("page-01.md", "text");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    const service = new AgentOcrService({
      engine: "claude",
      binaryPath: "/opt/homebrew/bin/claude",
      model: "sonnet",
      maxBudgetUsd: 2,
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runProcess: context.runProcess,
    });

    await service.transcribe({
      mode: "page",
      note: "supernote/Note/Scratch.note",
      pages: fixedOcrPageSource([
        { pageNumber: 1, image: new Uint8Array([1]) },
      ]),
    });

    const args = context.runProcess.mock.calls[0]![1];
    expect(args.slice(args.indexOf("--model"))).toEqual(["--model", "sonnet"]);
  });

  it("keeps a failed agent batch and surfaces CLI stderr", async () => {
    const context = setup();
    context.runProcess.mockResolvedValue({
      exitCode: 1,
      stderr: "Not logged in",
      timedOut: false,
    });
    const service = new AgentOcrService({
      engine: "codex",
      binaryPath: "/usr/local/bin/codex",
      model: "",
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runProcess: context.runProcess,
    });

    const result = await service.transcribe({
      mode: "document",
      note: "supernote/Note/Journal.note",
      pages: fixedOcrPageSource([
        { pageNumber: 1, image: new Uint8Array([1]) },
      ]),
    });

    expect(result.errors).toEqual([
      "Codex CLI exited with code 1: Not logged in",
    ]);
    expect(result.retainedBatchPath).toBe("/tmp/supernote-agent-123");
    expect(context.runProcess.mock.calls[0]![1]).not.toContain("-m");
    expect(context.batch.remove).not.toHaveBeenCalled();
  });

  it("retains a partially prepared batch when rendering fails", async () => {
    const context = setup();
    const service = new AgentOcrService({
      engine: "codex",
      binaryPath: "/usr/local/bin/codex",
      model: "",
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runProcess: context.runProcess,
    });
    const prepared = await service.prepare({
      mode: "page",
      note: "Scratch.note",
      pages: {
        pageNumbers: [1, 2],
        render: async (pageNumber) => {
          if (pageNumber === 2) {
            throw new Error("render failed");
          }
          return new Uint8Array([pageNumber]);
        },
      },
    });

    const result = await prepared.transcribe();

    expect(context.runProcess).not.toHaveBeenCalled();
    expect(result.failedPages).toEqual([1, 2]);
    expect(result.errors[0]).toContain("render failed");
    expect(result.retainedBatchPath).toBe("/tmp/supernote-agent-123");
  });

  it("cancels a Codex transcription and keeps its batch", async () => {
    const context = setup();
    const runs = new RunRegistry({ id: () => "codex-run" });
    context.runProcess.mockImplementation(
      async (_file, _args, options) =>
        new Promise((resolve) => {
          options.observer?.setCancel?.(() =>
            resolve({
              exitCode: null,
              stderr: "",
              timedOut: false,
              cancelled: true,
            }),
          );
        }),
    );
    const service = new AgentOcrService({
      engine: "codex",
      binaryPath: "/usr/local/bin/codex",
      model: "",
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runProcess: context.runProcess,
      runs,
    });

    const transcription = service.transcribe({
      mode: "page",
      note: "supernote/Note/Scratch.note",
      pages: fixedOcrPageSource([
        { pageNumber: 1, image: new Uint8Array([1]) },
      ]),
    });
    await vi.waitFor(() => {
      expect(runs.records()[0]?.cancellable).toBe(true);
    });
    expect(runs.cancel("codex-run")).toBe(true);

    const result = await transcription;

    expect(result.errors[0]).toContain("cancelled");
    expect(result.retainedBatchPath).toBe("/tmp/supernote-agent-123");
    expect(runs.records()[0]).toMatchObject({
      status: "cancelled",
      batchPath: "/tmp/supernote-agent-123",
    });
    expect(context.batch.remove).not.toHaveBeenCalled();
  });
});
