import { describe, expect, it, vi } from "vitest";

import {
  CommandOcrService,
  type CommandOcrBatch,
} from "../src/ocr/command-ocr";
import { fixedOcrPageSource } from "./ocr-page-source";

const setup = () => {
  const files = new Map<string, Uint8Array | string>();
  const batch: CommandOcrBatch = {
    folderPath: "/tmp/supernote-ocr-123",
    write: vi.fn(async (name, content) => {
      files.set(name, content);
    }),
    readText: vi.fn(async (name) => {
      const content = files.get(name);
      return typeof content === "string" ? content : null;
    }),
    remove: vi.fn(async () => undefined),
  };
  const runCommand = vi.fn(async () => ({
    exitCode: 0,
    stderr: "",
    timedOut: false,
  }));
  return { files, batch, runCommand };
};

describe("CommandOcrService", () => {
  it("invokes one process for a page batch and preserves missing results", async () => {
    const context = setup();
    context.runCommand.mockImplementation(async () => {
      context.files.set("page-01.md", "first");
      context.files.set("page-03.md", "third");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    const service = new CommandOcrService({
      command: 'transcribe "{{folder}}" --note "{{note}}" --mode "{{mode}}"',
      timeoutMs: 600_000,
      createBatch: async () => context.batch,
      runCommand: context.runCommand,
    });

    const pages = fixedOcrPageSource(
      [1, 2, 3].map((pageNumber) => ({
        pageNumber,
        image: new Uint8Array([pageNumber]),
      })),
    );
    const render = vi.spyOn(pages, "render");
    const prepared = await service.prepare({
      mode: "page",
      note: "supernote/Note/Scratch.note",
      customPrompt: "Summarize these pages.",
      pages,
    });
    expect(context.runCommand).not.toHaveBeenCalled();
    const result = await prepared.transcribe();

    expect(context.runCommand).toHaveBeenCalledTimes(1);
    expect(context.runCommand).toHaveBeenCalledWith(
      'transcribe "/tmp/supernote-ocr-123" --note "supernote/Note/Scratch.note" --mode "page"',
      { timeoutMs: 600_000 },
    );
    expect([...context.files.keys()].slice(0, 3)).toEqual([
      "page-01.png",
      "page-02.png",
      "page-03.png",
    ]);
    expect(render.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([
      1, 2, 3,
    ]);
    expect(context.files.has("prompt.md")).toBe(false);
    expect(result.pageText).toEqual(
      new Map([
        [1, "first"],
        [3, "third"],
      ]),
    );
    expect(result.failedPages).toEqual([2]);
    expect(result.retainedBatchPath).toBe("/tmp/supernote-ocr-123");
    expect(context.batch.remove).not.toHaveBeenCalled();
  });

  it("reads document.md and deletes a successful batch", async () => {
    const context = setup();
    context.runCommand.mockImplementation(async () => {
      context.files.set("document.md", "# One document");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    const service = new CommandOcrService({
      command: "transcribe {{folder}} {{mode}}",
      timeoutMs: 1_000,
      createBatch: async () => context.batch,
      runCommand: context.runCommand,
    });

    const result = await service.transcribe({
      mode: "document",
      note: "Journal.note",
      pages: fixedOcrPageSource([
        { pageNumber: 7, image: new Uint8Array([7]) },
        { pageNumber: 8, image: new Uint8Array([8]) },
      ]),
    });

    expect(result.documentText).toBe("# One document");
    expect(context.files.has("prompt.md")).toBe(false);
    expect(context.batch.remove).toHaveBeenCalledTimes(1);
  });

  it("delivers one-off document instructions as a framed prompt file", async () => {
    const context = setup();
    context.runCommand.mockImplementation(async () => {
      context.files.set("document.md", "# Organized");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    const service = new CommandOcrService({
      command: "transcribe {{folder}} {{mode}}",
      timeoutMs: 1_000,
      createBatch: async () => context.batch,
      runCommand: context.runCommand,
    });

    await service.transcribe({
      mode: "document",
      note: "Journal.note",
      customPrompt: "Group related thoughts under clear headings.",
      pages: fixedOcrPageSource([
        { pageNumber: 1, image: new Uint8Array([1]) },
      ]),
    });

    const prompt = context.files.get("prompt.md");
    expect(prompt).toEqual(expect.any(String));
    expect(prompt as string).toContain(
      "Group related thoughts under clear headings.",
    );
    expect(prompt as string).toContain(
      "Produce only the final Markdown document.",
    );
  });

  it("keeps the batch and reports a timed-out process", async () => {
    const context = setup();
    context.runCommand.mockResolvedValue({
      exitCode: 1,
      stderr: "too slow",
      timedOut: true,
    });
    const service = new CommandOcrService({
      command: "transcribe {{folder}}",
      timeoutMs: 12,
      createBatch: async () => context.batch,
      runCommand: context.runCommand,
    });

    const result = await service.transcribe({
      mode: "page",
      note: "Scratch.note",
      pages: fixedOcrPageSource([
        { pageNumber: 1, image: new Uint8Array([1]) },
      ]),
    });

    expect(result.failedPages).toEqual([1]);
    expect(result.errors[0]).toContain("timed out");
    expect(result.retainedBatchPath).toBe("/tmp/supernote-ocr-123");
  });

  it("retains a partially prepared batch when rendering fails", async () => {
    const context = setup();
    const service = new CommandOcrService({
      command: "transcribe {{folder}}",
      timeoutMs: 12,
      createBatch: async () => context.batch,
      runCommand: context.runCommand,
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

    expect(context.runCommand).not.toHaveBeenCalled();
    expect(result.failedPages).toEqual([1, 2]);
    expect(result.errors[0]).toContain("render failed");
    expect(result.retainedBatchPath).toBe("/tmp/supernote-ocr-123");
  });
});
