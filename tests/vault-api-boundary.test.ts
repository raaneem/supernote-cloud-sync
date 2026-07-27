import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("Obsidian vault mutation boundary", () => {
  it("does not hard-delete indexed files through Obsidian Vault", async () => {
    const main = await source("../src/main.ts");
    const store = await source("../src/sync/obsidian-vault-store.ts");

    expect(main).not.toContain("this.app.vault.delete(");
    expect(store).not.toContain("this.vault.delete(");
    expect(store).not.toContain("this.vault.modify(");
    expect(store).toContain("this.fileManager.trashFile(");
    expect(store).toContain("this.vault.process(");
  });
});
