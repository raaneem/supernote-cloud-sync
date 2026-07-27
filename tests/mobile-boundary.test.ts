import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

const bundle = async (path: string): Promise<string> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "obsidian"],
  });
  return result.outputFiles[0]?.text ?? "";
};

describe("mobile compatibility boundary", () => {
  it("keeps the command process API behind callable desktop functions", async () => {
    const [main, runner] = await Promise.all([
      source("../src/main.ts"),
      source("../src/shared/desktop-command.ts"),
    ]);

    expect(main).toContain("new ApiOcrService");
    expect(main).toContain("new CommandOcrService");
    expect(runner).toMatch(/require\(\s*["']node:child_process["']\s*,?\s*\)/);
    expect(runner).not.toMatch(
      /import\s+[^;]+\s+from\s+["']node:child_process["']/,
    );
  });

  it("bundles desktop Node APIs as runtime require calls", async () => {
    const [runner, commandOcr] = await Promise.all([
      bundle("../src/shared/desktop-command.ts"),
      bundle("../src/ocr/command-ocr.ts"),
    ]);

    for (const output of [runner, commandOcr]) {
      expect(output).not.toContain('import("node:');
    }
    expect(runner).toContain('require("node:child_process")');
    expect(runner).toContain('require("node:fs/promises")');
    expect(commandOcr).toContain('require("node:child_process")');
  });

  it("bundles notebook sessions as a browser-only worker", async () => {
    const [main, worker] = await Promise.all([
      source("../src/main.ts"),
      bundle("../src/note/notebook.worker.ts"),
    ]);

    expect(main).not.toContain('from "supernote-typescript/lib/parsing"');
    expect(main).not.toContain('from "supernote-typescript/lib/conversion"');
    expect(worker).toContain("NotebookWorkerRuntime");
    expect(worker).not.toContain("image-js");
    expect(worker).not.toContain("toImage");
    expect(worker).not.toContain('require("node:');
    expect(new TextEncoder().encode(worker).byteLength).toBeLessThan(100_000);
  });
});
