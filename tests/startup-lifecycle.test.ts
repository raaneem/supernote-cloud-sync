import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("plugin startup lifecycle", () => {
  it("keeps executable discovery out of awaited onload work", async () => {
    const main = await source("../src/main.ts");
    const onload = main.slice(
      main.indexOf("async onload()"),
      main.indexOf("onunload()"),
    );

    expect(onload).not.toContain("await this.resolveAgent");
    expect(onload).not.toContain("runDesktopCommand");
    expect(main).toContain("scheduleConfiguredAgentWarmup()");
    expect(main).toContain("onLayoutReady");
  });

  it("constructs render and PDF capabilities only on first use", async () => {
    const main = await source("../src/main.ts");
    const pdfWorker = await source("../src/export/pdf-worker-runtime.ts");

    expect(main).not.toMatch(
      /private readonly notebookService\s*=\s*new NotebookService/,
    );
    expect(main).toContain("this.notebookService ??= new NotebookService({");
    expect(main).not.toMatch(/^import notoSans.+\.ttf";$/m);
    expect(main).toContain('import(\n      "./export/pdf-worker-client"');
    expect(main).not.toContain('import("./export/pdf-export")');
    expect(main).not.toContain('import("./export/markdown-pdf")');
    expect(pdfWorker).toContain('from "./pdf-export"');
    expect(pdfWorker).toContain('from "./markdown-pdf"');
    expect(pdfWorker).toContain("NotoSansSymbols2_400Regular.ttf");
  });

  it("minifies production output", async () => {
    const build = await source("../esbuild.config.mjs");

    expect(build).toContain("minify: production");
  });

  it("reuses one mirrored-note snapshot while rendering automation settings", async () => {
    const main = await source("../src/main.ts");
    const settings = await source("../src/settings.ts");
    const warningMethod = main.slice(
      main.indexOf("getWatchHookWarning("),
      main.indexOf("isAutomationActionAvailable("),
    );

    expect(settings.match(/getMirroredNotePaths\(\)/g)).toHaveLength(1);
    expect(settings).toMatch(
      /this\.syncPlugin\.getAutomationBlockingReason\(\s*automation,\s*mirroredNotes,?\s*\)/,
    );
    expect(warningMethod).not.toContain("getMirroredNotePaths()");
  });

  it("wraps Mirror and optional Pair sync in one manifest transaction", async () => {
    const main = await source("../src/main.ts");
    const sync = main.slice(
      main.indexOf("async syncMirroredNotebooks("),
      main.indexOf("private async maybeAutoSync("),
    );

    expect(sync).toContain("SyncManifestTransaction.open(");
    expect(sync).toContain("service.mirrorFile(input, manifest)");
    expect(sync).toContain(
      "this.createPairSyncService(directoryId).reconcile(",
    );
    expect(sync).toContain("this.instanceState.pairBaselines[baselineKey]");
    expect(sync).toContain("transaction.run(run)");
  });
});
