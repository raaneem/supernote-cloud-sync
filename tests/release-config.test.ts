import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("release repository configuration", () => {
  it("keeps root-relative CI on all supported desktop runners", async () => {
    const ci = await source("../.github/workflows/ci.yml");
    const workflow = await source("../.github/workflows/check.yml");

    expect(ci).toContain("uses: ./.github/workflows/check.yml");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("cache-dependency-path: pnpm-lock.yaml");
    expect(workflow).not.toContain("working-directory: plugin");
    expect(workflow).not.toContain("plugin/pnpm-lock.yaml");
  });

  it("creates only a draft after the full release matrix", async () => {
    const workflow = await source("../.github/workflows/release.yml");

    expect(workflow).toContain("uses: ./.github/workflows/check.yml");
    expect(workflow).toContain("needs: check");
    expect(workflow).toContain("draft: true");
    expect(workflow).toContain("main.js");
    expect(workflow).toContain("manifest.json");
    expect(workflow).toContain("styles.css");
    expect(workflow).not.toMatch(/draft:\s*false|prerelease:\s*false/);
  });

  it("carries the portable release safety ignores", async () => {
    const ignores = await source("../.gitignore");
    for (const pattern of [
      "node_modules/",
      "main.js",
      "*.js.map",
      "data.json",
      "**/benchmarks/private/",
      "**/benchmarks/results/",
    ]) {
      expect(ignores).toContain(pattern);
    }
  });

  it("keeps text files stable across hosted runners", async () => {
    const attributes = await source("../.gitattributes");

    expect(attributes).toContain("* text=auto eol=lf");
  });

  it("audits source paths with platform-native containment", async () => {
    const audit = await source("../scripts/audit-obsidian-api.mjs");

    expect(audit).toContain(
      'relative(resolve(root, "src"), sourceFile.fileName)',
    );
    expect(audit).toContain("isAbsolute(sourcePath)");
    expect(audit).not.toContain('resolve(root, "src")}/');
  });
});
