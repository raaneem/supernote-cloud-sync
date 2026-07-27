import { describe, expect, it, vi } from "vitest";

import type {
  NotebookDescriptor,
  NotebookSessionProvider,
} from "../src/note/notebook-service";
import {
  createDesktopBatch,
  runDesktopCommand,
  type DesktopProcessObserver,
} from "../src/shared/desktop-command";
import { RunRegistry } from "../src/run/run-registry";
import type { VaultStore } from "../src/sync/vault-store";
import {
  getWatchHookConfigurationWarning,
  WatchHookService,
  type WatchBatch,
  type WatchCommandResult,
  type WatchHookDefinition,
} from "../src/sync/watch-hooks";

class MemoryVault implements VaultStore {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();

  async exists(path: string): Promise<boolean> {
    return this.text.has(path) || this.binary.has(path);
  }

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

const sourceNote = "supernote/Note/Scratch.note";

const manifest = (md5 = "note-md5") => ({
  version: 1,
  files: {
    scratch: {
      remoteId: "scratch",
      directoryId: "note",
      fileName: "Scratch.note",
      remotePath: "/Note/Scratch.note",
      md5,
      updateTime: 1,
      vaultPath: sourceNote,
      syncedAt: "2026-07-25T00:00:00.000Z",
      pageCount: 3,
    },
  },
});

const hook = (
  update: Partial<WatchHookDefinition> = {},
): WatchHookDefinition => ({
  id: "scratch-hook",
  name: "Scratch",
  sourceNote,
  format: "images",
  action: "command",
  command: "dispatch {{folder}} --note {{note}}",
  prompt: "",
  model: "",
  claudeAllowedTools: "Read,Write,Glob,Bash",
  codexSandbox: "workspace-write",
  keepFolder: "",
  ...update,
});

const recognitionByPage = new Map([[2, "Recognized handwriting"]]);
const textBoxes = [
  {
    pageNumber: 2,
    text: "Typed text",
    rect: [1, 2, 3, 4] as const,
    fontSize: 48,
    fontPath: "/font.ttf",
    id: "1",
  },
];

const setup = (
  pageMd5s: string[] = ["page-a", "page-b", "page-c"],
  runs?: RunRegistry,
) => {
  const vault = new MemoryVault();
  vault.binary.set(sourceNote, new Uint8Array([1, 2, 3]));
  vault.text.set("supernote/.sync-manifest.json", JSON.stringify(manifest()));
  const renderer = {
    pageMd5s: vi.fn(() => pageMd5s),
    renderPng: vi.fn(async (pageNumber: number) => ({
      png: new Uint8Array([pageNumber]),
      width: 1920,
      height: 2560,
    })),
  };
  const notebooks: NotebookSessionProvider = {
    open: vi.fn(async ({ path, revision }) => {
      const fingerprints = renderer.pageMd5s();
      const descriptor: NotebookDescriptor = {
        path,
        revision,
        pageCount: fingerprints.length,
        devicePage: null,
        pages: fingerprints.map((fingerprint, index) => ({
          pageNumber: index + 1,
          fingerprint,
          recognitionText: recognitionByPage.get(index + 1) ?? null,
          recognitionSpans: [],
        })),
        textBoxes,
      };
      return {
        descriptor,
        retain: vi.fn(() => {
          throw new Error("Unexpected lease retention");
        }),
        bitmap: vi.fn(),
        thumbnailBitmap: vi.fn(),
        renderPng: renderer.renderPng,
        updateView: vi.fn(),
        close: vi.fn(),
      };
    }),
  };
  const files = new Map<string, Uint8Array | string>();
  const removeBatch = vi.fn(async () => undefined);
  const batch: WatchBatch = {
    folderPath: "/tmp/supernote-watch/batch-1",
    write: vi.fn(async (name, content) => {
      files.set(name, content);
    }),
    remove: removeBatch,
  };
  const createTempBatch = vi.fn(async () => batch);
  const runCommand = vi.fn<
    (
      command: string,
      observer?: DesktopProcessObserver,
    ) => Promise<WatchCommandResult>
  >(async () => ({
    exitCode: 0,
    stderr: "",
    timedOut: false,
  }));
  const runAgent = vi.fn(async () => ({
    exitCode: 0,
    stderr: "",
    timedOut: false,
  }));
  const notify = vi.fn();
  const service = new WatchHookService({
    vault,
    notebooks,
    targetFolder: "supernote",
    isDesktop: true,
    createTempBatch,
    runCommand,
    runAgent,
    absoluteVaultPath: (path) => `/vault/${path}`,
    batchName: () => "batch-1",
    notify,
    ...(runs ? { runs } : {}),
  });
  return {
    vault,
    renderer,
    notebooks,
    files,
    batch,
    removeBatch,
    createTempBatch,
    runCommand,
    runAgent,
    notify,
    service,
  };
};

describe("WatchHookService", () => {
  it("delivers an ephemeral image batch once and commits page state on success", async () => {
    const context = setup();

    await expect(context.service.run(hook())).resolves.toMatchObject({
      status: "delivered",
      pages: [1, 2, 3],
    });

    expect([...context.files.keys()]).toEqual([
      "page-01.png",
      "page-02.png",
      "page-03.png",
    ]);
    expect(context.runCommand).toHaveBeenCalledWith(
      "dispatch /tmp/supernote-watch/batch-1 --note supernote/Note/Scratch.note",
    );
    expect(context.batch.remove).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(
      context.vault.text.get("supernote/.sync-manifest.json") ?? "{}",
    );
    expect(saved.files.scratch.watchHooks["scratch-hook"]).toEqual({
      noteMd5: "note-md5",
      pageMd5s: {
        "1": "page-a",
        "2": "page-b",
        "3": "page-c",
      },
    });

    await expect(context.service.run(hook())).resolves.toEqual({
      status: "unchanged",
      pages: [],
    });
    expect(context.renderer.renderPng).toHaveBeenCalledTimes(3);
    expect(context.runCommand).toHaveBeenCalledTimes(1);
  });

  it("records streamed automation output through final cleanup", async () => {
    const runs = new RunRegistry({ id: () => "run-1" });
    const context = setup(undefined, runs);
    context.runCommand.mockImplementation(async (_command, observer) => {
      observer?.onStdout?.("working\n");
      return { exitCode: 0, stderr: "", timedOut: false };
    });
    context.removeBatch.mockImplementation(async () => {
      expect(runs.records()[0]?.status).toBe("running");
    });

    await context.service.run(hook());

    expect(runs.records()).toMatchObject([
      {
        id: "run-1",
        kind: "automation",
        engine: "command",
        status: "succeeded",
      },
    ]);
    expect(runs.logText("run-1")).toContain("working");
  });

  it("records cancellation and retains retry state and its batch", async () => {
    const runs = new RunRegistry({ id: () => "run-1" });
    const context = setup(undefined, runs);
    context.runCommand.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      timedOut: false,
      cancelled: true,
    });

    await expect(context.service.run(hook())).resolves.toMatchObject({
      status: "failed",
      batchPath: "/tmp/supernote-watch/batch-1",
    });

    expect(runs.records()[0]).toMatchObject({
      status: "cancelled",
      batchPath: "/tmp/supernote-watch/batch-1",
    });
    expect(context.batch.remove).not.toHaveBeenCalled();
    const saved = JSON.parse(
      context.vault.text.get("supernote/.sync-manifest.json")!,
    ) as {
      files: { scratch: { watchHooks?: unknown } };
    };
    expect(saved.files.scratch.watchHooks).toBeUndefined();
  });

  it("records the path of a successful retained automation batch", async () => {
    const runs = new RunRegistry({ id: () => "run-1" });
    const context = setup(undefined, runs);

    await context.service.run(hook({ keepFolder: "automation-output" }));

    expect(runs.records()[0]).toMatchObject({
      status: "succeeded",
      batchPath: "/vault/automation-output/batch-1",
    });
    expect(context.createTempBatch).not.toHaveBeenCalled();
  });

  it("delivers only a changed page when explicitly run again", async () => {
    const context = setup();
    await context.service.run(hook());
    context.renderer.renderPng.mockClear();

    const nextManifest = JSON.parse(
      context.vault.text.get("supernote/.sync-manifest.json") ?? "{}",
    );
    nextManifest.files.scratch.md5 = "next-note-md5";
    context.vault.text.set(
      "supernote/.sync-manifest.json",
      JSON.stringify(nextManifest),
    );
    context.renderer.pageMd5s.mockReturnValue([
      "page-a",
      "page-b-edited",
      "page-c",
    ]);

    await expect(context.service.run(hook())).resolves.toMatchObject({
      status: "delivered",
      pages: [2],
    });
    expect(
      context.renderer.renderPng.mock.calls.map((call) => call[0]),
    ).toEqual([2]);
    expect(context.runCommand).toHaveBeenCalledTimes(2);
  });

  it("delivers an image batch to Claude with appended source context", async () => {
    const context = setup();

    await expect(
      context.service.run(
        hook({
          action: "claude",
          format: "markdown",
          command: "",
          prompt: "/supernote-dispatch",
          model: "sonnet",
          claudeAllowedTools: "Read,Write,Glob,Bash,mcp__calendar",
        }),
      ),
    ).resolves.toMatchObject({
      status: "delivered",
      pages: [1, 2, 3],
    });

    expect(context.runCommand).not.toHaveBeenCalled();
    expect([...context.files.keys()]).toEqual([
      "page-01.png",
      "page-02.png",
      "page-03.png",
    ]);
    expect(context.runAgent).toHaveBeenCalledWith({
      engine: "claude",
      batchPath: "/tmp/supernote-watch/batch-1",
      prompt:
        "/supernote-dispatch\n\n" +
        "Supernote Automation context:\n" +
        "- Source note: supernote/Note/Scratch.note\n" +
        "- Changed pages: 1, 2, 3\n" +
        "- Batch files: page-01.png, page-02.png, page-03.png\n" +
        "- Page link format: [[supernote/Note/Scratch.note#page=NN]]\n" +
        "The batch files are in the current working directory.",
      model: "sonnet",
      claudeAllowedTools: "Read,Write,Glob,Bash,mcp__calendar",
      codexSandbox: "workspace-write",
      imageFiles: ["page-01.png", "page-02.png", "page-03.png"],
    });
    expect(context.batch.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed batch and retries the same pages without committing state", async () => {
    const context = setup();
    context.runCommand.mockResolvedValue({
      exitCode: 1,
      stderr: `prefix-${"x".repeat(2_500)}-useful-tail`,
      timedOut: false,
    });

    await expect(context.service.run(hook())).resolves.toMatchObject({
      status: "failed",
      pages: [1, 2, 3],
      batchPath: "/tmp/supernote-watch/batch-1",
    });
    expect(context.batch.remove).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledTimes(1);
    const notice = String(context.notify.mock.calls[0]?.[0]);
    expect(notice.length).toBeLessThan(2_300);
    expect(notice).toContain("useful-tail");

    const failed = JSON.parse(
      context.vault.text.get("supernote/.sync-manifest.json") ?? "{}",
    );
    expect(failed.files.scratch.watchHooks).toBeUndefined();

    context.runCommand.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      timedOut: false,
    });
    await expect(context.service.run(hook())).resolves.toMatchObject({
      status: "delivered",
      pages: [1, 2, 3],
    });
    expect(context.runCommand).toHaveBeenCalledTimes(2);
  });

  it("renders only new and changed pages after the notebook md5 changes", async () => {
    const context = setup();
    await context.service.run(hook());
    context.renderer.renderPng.mockClear();

    const nextManifest = JSON.parse(
      context.vault.text.get("supernote/.sync-manifest.json") ?? "{}",
    );
    nextManifest.files.scratch.md5 = "next-note-md5";
    context.vault.text.set(
      "supernote/.sync-manifest.json",
      JSON.stringify(nextManifest),
    );
    context.renderer.pageMd5s.mockReturnValue([
      "page-a",
      "page-b-edited",
      "page-c",
      "page-d",
    ]);

    await expect(context.service.run(hook())).resolves.toMatchObject({
      status: "delivered",
      pages: [2, 4],
    });
    expect(
      context.renderer.renderPng.mock.calls.map((call) => call[0]),
    ).toEqual([2, 4]);
  });

  it("persists keep-folder batches on mobile without running a command", async () => {
    const context = setup();
    const mobile = new WatchHookService({
      vault: context.vault,
      notebooks: context.notebooks,
      targetFolder: "supernote",
      isDesktop: false,
      batchName: () => "batch-1",
      notify: context.notify,
    });

    await expect(
      mobile.run(hook({ keepFolder: "Automation batches" })),
    ).resolves.toMatchObject({
      status: "persisted",
      pages: [1, 2, 3],
      batchPath: "Automation batches/batch-1",
    });
    expect(
      context.vault.binary.get("Automation batches/batch-1/page-02.png"),
    ).toEqual(new Uint8Array([2]));
    expect(context.runCommand).not.toHaveBeenCalled();
  });

  it("persists a desktop keep-folder batch without requiring a command", async () => {
    const context = setup();

    await expect(
      context.service.run(
        hook({
          command: "",
          keepFolder: "Automation batches",
        }),
      ),
    ).resolves.toMatchObject({
      status: "persisted",
      pages: [1, 2, 3],
      batchPath: "/vault/Automation batches/batch-1",
    });
    expect(context.runCommand).not.toHaveBeenCalled();
    expect(context.notify).not.toHaveBeenCalled();

    await expect(
      context.service.run(
        hook({
          command: "",
          keepFolder: "Automation batches",
        }),
      ),
    ).resolves.toEqual({
      status: "unchanged",
      pages: [],
    });
    expect(context.renderer.renderPng).toHaveBeenCalledTimes(3);
  });

  it("does not create an unconsumable ephemeral batch on mobile", async () => {
    const context = setup();
    const mobile = new WatchHookService({
      vault: context.vault,
      notebooks: context.notebooks,
      targetFolder: "supernote",
      isDesktop: false,
      batchName: () => "batch-1",
      notify: context.notify,
    });

    await expect(mobile.run(hook())).resolves.toEqual({
      status: "mobile-unavailable",
      pages: [],
    });
    expect(context.renderer.renderPng).not.toHaveBeenCalled();
  });

  it("reports an automation draft with no source as missing", async () => {
    const context = setup();

    await expect(
      context.service.run(hook({ sourceNote: "" })),
    ).resolves.toEqual({
      status: "missing",
      pages: [],
    });
    expect(context.runCommand).not.toHaveBeenCalled();
  });

  it("delivers existing recognition as untransformed page markdown", async () => {
    const context = setup();

    await context.service.run(hook({ format: "markdown" }));

    expect(context.files.get("page-01.md")).toBe("");
    expect(context.files.get("page-02.md")).toBe("Recognized handwriting\n");
    expect(context.renderer.renderPng).not.toHaveBeenCalled();
  });
});

describe("watch hook configuration", () => {
  it("rejects an ephemeral automation without a command", () => {
    expect(
      getWatchHookConfigurationWarning(hook({ command: "", keepFolder: "" })),
    ).toBe(
      "Add a command or a keep folder so the Automation output has a destination.",
    );
    expect(
      getWatchHookConfigurationWarning(
        hook({ command: "", keepFolder: "Automation batches" }),
      ),
    ).toBeNull();
  });

  it("rejects an agent action without a prompt", () => {
    expect(
      getWatchHookConfigurationWarning(
        hook({
          action: "claude",
          command: "",
          prompt: "",
          keepFolder: "Automation batches",
        }),
      ),
    ).toBe("Add a prompt for the Claude Code Automation action.");
  });

  it("rejects a keep folder inside the Mirror", () => {
    expect(
      getWatchHookConfigurationWarning(
        hook({ keepFolder: "supernote/output" }),
        "supernote",
      ),
    ).toBe("The Automation keep folder must be outside the Mirror.");
  });
});

describe("desktop watch hook runtime", () => {
  const windows = process.platform === "win32";
  const host = {
    platform: process.platform,
    env: windows ? process.env : { ...process.env, SHELL: "/bin/sh" },
  };

  it("runs commands through the configured shell and captures stderr", async () => {
    await expect(
      runDesktopCommand(
        windows
          ? ">&2 echo command-error & exit /b 7"
          : "printf 'command-error' >&2; exit 7",
        {
          timeoutMs: 5_000,
          host,
        },
      ),
    ).resolves.toEqual({
      exitCode: 7,
      stderr: "command-error",
      timedOut: false,
    });
  }, 15_000);

  it("times out non-interactive commands that do not exit", async () => {
    await expect(
      runDesktopCommand(windows ? "ping -n 3 127.0.0.1 >NUL" : "sleep 1", {
        timeoutMs: 20,
        host,
      }),
    ).resolves.toMatchObject({
      timedOut: true,
    });
  });

  it("force-stops commands that ignore the timeout signal", async () => {
    await expect(
      runDesktopCommand(
        windows
          ? "ping -t 127.0.0.1 >NUL"
          : "trap '' TERM; while :; do :; done",
        {
          timeoutMs: 20,
          killGraceMs: 20,
          host,
        },
      ),
    ).resolves.toMatchObject({
      timedOut: true,
    });
  });

  it("creates writable temporary batches that can be removed", async () => {
    const batch = await createDesktopBatch("supernote-automation-");
    await batch.write("page-01.md", "hello");

    const { readFile } = await import("node:fs/promises");
    await expect(
      readFile(`${batch.folderPath}/page-01.md`, "utf8"),
    ).resolves.toBe("hello");

    await batch.remove();
    await expect(
      readFile(`${batch.folderPath}/page-01.md`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
