import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("submission polish", () => {
  it("uses Modal.setTitle for the three reviewed modal titles", async () => {
    const verification = await source("../src/ui/verification-modal.ts");
    const browser = await source("../src/ui/folder-picker-modal.ts");

    expect(verification).toContain(
      'this.setTitle("Verify your Supernote login")',
    );
    expect(verification).not.toContain('createEl("h2"');
    expect(browser).toContain('this.setTitle("Stop mirroring?")');
    expect(browser).toContain('this.setTitle("Supernote Cloud")');
    expect(browser).not.toContain('createEl("h2"');
  });

  it("names the conflicting community plugin exactly", async () => {
    const main = await source("../src/main.ts");

    expect(main).toContain('Disable "Supernote (Unofficial)"');
    expect(main).not.toContain("Unofficial Supernote by Ratta Integration");
  });

  it("derives all reader chrome colours from Obsidian theme roles", async () => {
    const styles = await source("../styles.css");
    const readerStyles = styles.slice(styles.indexOf(".supernote-note-view"));

    expect(readerStyles).toContain("--supernote-reader-surface:");
    expect(readerStyles).toContain("--supernote-reader-chrome:");
    expect(readerStyles).not.toMatch(
      /#111|#f5f5f5|#333|rgb\(20 20 20\s*\/\s*72%\)/,
    );
  });

  it("keeps the mobile Cloud browser and close control inside iOS safe areas", async () => {
    const browser = await source("../src/ui/folder-picker-modal.ts");
    const styles = await source("../styles.css");
    const mobileBrowserStyles = styles.slice(
      styles.indexOf(".supernote-sync-browser-modal.is-mobile"),
      styles.indexOf(".supernote-note-view"),
    );

    expect(browser).toContain(
      'this.modalEl.toggleClass("is-mobile", Platform.isMobile)',
    );
    expect(mobileBrowserStyles).toContain("100dvh");
    expect(mobileBrowserStyles).toContain("env(safe-area-inset-top, 0px)");
    expect(mobileBrowserStyles).toContain("env(safe-area-inset-bottom, 0px)");
    expect(mobileBrowserStyles).toContain(
      ".supernote-sync-browser-modal.is-mobile .modal-close-button",
    );
  });

  it("shares animated Cloud folder loading feedback across platforms", async () => {
    const browser = await source("../src/ui/folder-picker-modal.ts");
    const loadingState = browser.slice(
      browser.indexOf("private renderLoadingState("),
      browser.indexOf("private transitionClass("),
    );
    const styles = await source("../styles.css");

    expect(loadingState).toContain("supernote-sync-browser-skeleton-row");
    expect(loadingState).not.toContain("Platform.isMobile");
    expect(styles).toContain("@keyframes supernote-sync-enter-forward");
    expect(styles).toContain("@keyframes supernote-sync-enter-back");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
