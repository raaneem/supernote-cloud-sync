import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("Settings dashboard", () => {
  it("contains exactly the four compact dashboard blocks", async () => {
    const settings = await source("../src/settings.ts");
    const headings = [
      ...settings.matchAll(
        /new Setting\(container\)\.setName\("([^"]+)"\)\.setHeading\(\)/g,
      ),
    ].map((match) => match[1]);

    expect(headings).toEqual(["Setup", "Sync", "Automations", "Transcription"]);
    const automations = settings.slice(
      settings.indexOf("private renderAutomations("),
      settings.indexOf("private renderTranscription("),
    );
    expect(automations).not.toContain(".addText(");
    expect(automations).not.toContain(".addTextArea(");
    expect(automations).not.toContain(".addDropdown(");
  });

  it("keeps the Setup flow to four repair rows plus diagnostics", async () => {
    const setup = await source("../src/ui/setup-flow.ts");

    for (const label of [
      "Account",
      "Mirror",
      "Paired folder",
      "Transcription",
      "Diagnostics",
    ]) {
      expect(setup).toContain(`.setName("${label}")`);
    }
    expect(setup).not.toContain('.setName("Claude Code CLI")');
    expect(setup).not.toContain('.setName("Codex CLI")');
  });

  it("does not expose the retired transfer terminology", async () => {
    const visibleSurfaces = (
      await Promise.all([
        source("../src/settings.ts"),
        source("../src/ui/setup-flow.ts"),
        source("../src/ui/folder-picker-modal.ts"),
        source("../manifest.json"),
        source("../package.json"),
      ])
    ).join("\n");

    expect(visibleSurfaces).not.toMatch(
      /\bwritable subtree\b|\bwritable sync\b|\bpush folder\b|Send to Supernote folder/i,
    );
  });

  it("tests the current draft CLI path and invalidates before activation", async () => {
    const editor = await source("../src/ui/transcription-editor.ts");
    const main = await source("../src/main.ts");
    const updateSettings = main.slice(
      main.indexOf("async updateSettings("),
      main.indexOf("getMirroredNotePaths()"),
    );

    expect(editor).toContain(
      'engine === "claude" ? draft.claudePath : draft.codexPath',
    );
    expect(editor).toMatch(
      /plugin\.testAgentCandidate\(\s*engine,\s*candidatePath,?\s*\)/,
    );
    expect(
      updateSettings.indexOf("this.binaryResolver.invalidate"),
    ).toBeLessThan(
      updateSettings.indexOf("await this.resolveAgentBinary(selectedEngine)"),
    );
  });

  it("keeps an open reader bound to the current Mirror path", async () => {
    const main = await source("../src/main.ts");
    const view = await source("../src/viewer/note-view.ts");
    const reader = await source("../src/viewer/note-reader.ts");

    expect(main).toContain(
      "getTargetFolder: () => this.data.settings.targetFolder",
    );
    expect(view).toContain(
      "getTargetFolder: this.dependencies.getTargetFolder",
    );
    expect(reader).toContain("this.getTargetFolder()");
  });
});
