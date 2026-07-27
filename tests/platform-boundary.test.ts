import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const desktopCommandPath = "shared/desktop-command.ts";
const execFileAsync = promisify(execFile);
const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);
const moduleSpecifierPattern =
  /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

const sourceFiles = async (folder: string): Promise<string[]> => {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
};

describe("desktop platform boundary", () => {
  it("loads the desktop seam without a Node process global", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "supernote-platform-boundary-"),
    );
    const outputPath = join(outputDirectory, "desktop-command.mjs");
    try {
      await build({
        entryPoints: [resolve(sourceRoot, desktopCommandPath)],
        bundle: true,
        format: "esm",
        outfile: outputPath,
        platform: "node",
        alias: {
          obsidian: resolve(pluginRoot, "tests/obsidian-stub.ts"),
        },
      });
      const probe = [
        "const hostProcess = process;",
        "globalThis.process = undefined;",
        `const seam = await import(${JSON.stringify(pathToFileURL(outputPath).href)});`,
        "new seam.DesktopBinaryResolver();",
        "globalThis.process = hostProcess;",
      ].join(" ");

      await expect(
        execFileAsync(process.execPath, ["--input-type=module", "-e", probe]),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("keeps host-platform and Node builtin access in desktop-command", async () => {
    const violations: string[] = [];
    for (const path of await sourceFiles(sourceRoot)) {
      const sourcePath = relative(sourceRoot, path).replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      if (sourcePath === desktopCommandPath) {
        const sourceFile = ts.createSourceFile(
          path,
          source,
          ts.ScriptTarget.Latest,
          true,
        );
        const visit = (node: ts.Node, insideFunction = false): void => {
          const nestedInsideFunction =
            insideFunction || ts.isFunctionLike(node);
          if (!nestedInsideFunction) {
            if (
              ts.isIdentifier(node) &&
              node.text === "process" &&
              ts.isPropertyAccessExpression(node.parent) &&
              node.parent.expression === node
            ) {
              violations.push(`${sourcePath}: module-scope process access`);
            }
            if (
              ts.isCallExpression(node) &&
              ts.isIdentifier(node.expression) &&
              node.expression.text === "require" &&
              node.arguments[0] !== undefined &&
              ts.isStringLiteral(node.arguments[0]) &&
              nodeBuiltins.has(node.arguments[0].text)
            ) {
              violations.push(`${sourcePath}: module-scope Node require`);
            }
          }
          ts.forEachChild(node, (child) => visit(child, nestedInsideFunction));
        };
        visit(sourceFile);
        expect(source).toContain('from "obsidian"');
        expect(source).toContain("Platform.isWin");
        continue;
      }
      const importsNodeBuiltin = [
        ...source.matchAll(moduleSpecifierPattern),
      ].some((match) => nodeBuiltins.has(match[1] ?? ""));
      if (source.includes("process.platform") || importsNodeBuiltin) {
        violations.push(sourcePath);
      }
    }

    expect(violations).toEqual([]);
  });
});
