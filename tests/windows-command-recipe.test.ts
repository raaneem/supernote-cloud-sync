import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { spawnDesktopProcess } from "../src/shared/desktop-command";

const recipe = fileURLToPath(
  new URL("../examples/transcribe.cmd", import.meta.url),
);

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("documented Windows command recipe", () => {
  windowsIt("satisfies page and document batch output contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "supernote cmd recipe "));
    const bin = join(root, "bin");
    const pageBatch = join(root, "page batch");
    const documentBatch = join(root, "document batch");
    const pageInput = join(root, "page-input.txt");
    const documentInput = join(root, "document-input.txt");
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([mkdir(bin), mkdir(pageBatch), mkdir(documentBatch)]);
    await writeFile(
      join(bin, "claude.cmd"),
      `@echo off
"%SUPERNOTE_NODE_EXE%" "%~dp0fake-claude.mjs"
`,
    );
    await writeFile(
      join(bin, "fake-claude.mjs"),
      `import { readdir, writeFile } from "node:fs/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile(process.env.SUPERNOTE_CAPTURE_STDIN, input);
if (process.env.SUPERNOTE_TEST_MODE === "document") {
  await writeFile("document.md", "document output");
} else {
  for (const file of await readdir(".")) {
    if (/^page-.*\\.png$/i.test(file)) {
      await writeFile(file.replace(/\\.png$/i, ".md"), "page output");
    }
  }
}
`,
    );
    await Promise.all([
      writeFile(join(pageBatch, "page-01.png"), "image"),
      writeFile(join(pageBatch, "page-02.png"), "image"),
      writeFile(join(documentBatch, "page-01.png"), "image"),
      writeFile(join(documentBatch, "prompt.md"), "Custom instructions"),
    ]);

    try {
      const baseEnv = {
        ...process.env,
        PATH: `${bin};${process.env.PATH ?? ""}`,
        SUPERNOTE_NODE_EXE: process.execPath,
      };
      const pageResult = await spawnDesktopProcess(
        recipe,
        [pageBatch, "Notebook.note", "page"],
        {
          timeoutMs: 5_000,
          host: {
            platform: "win32",
            env: {
              ...baseEnv,
              SUPERNOTE_TEST_MODE: "page",
              SUPERNOTE_CAPTURE_STDIN: pageInput,
            },
          },
        },
      );
      expect(pageResult).toMatchObject({ exitCode: 0, timedOut: false });
      await expect(
        spawnDesktopProcess(
          recipe,
          [documentBatch, "Notebook.note", "document"],
          {
            timeoutMs: 5_000,
            host: {
              platform: "win32",
              env: {
                ...baseEnv,
                SUPERNOTE_TEST_MODE: "document",
                SUPERNOTE_CAPTURE_STDIN: documentInput,
              },
            },
          },
        ),
      ).resolves.toMatchObject({ exitCode: 0, timedOut: false });

      await expect(
        readFile(join(pageBatch, "page-01.md"), "utf8"),
      ).resolves.toContain("page output");
      await expect(
        readFile(join(pageBatch, "page-02.md"), "utf8"),
      ).resolves.toContain("page output");
      await expect(
        readFile(join(documentBatch, "document.md"), "utf8"),
      ).resolves.toContain("document output");
      await expect(readFile(pageInput, "utf8")).resolves.toContain(
        "For each image",
      );
      await expect(readFile(documentInput, "utf8")).resolves.toContain(
        "Custom instructions",
      );
    } finally {
      await rm(dirname(bin), { recursive: true, force: true });
    }
  });
});
