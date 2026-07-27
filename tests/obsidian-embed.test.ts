import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  nativeEmbedMarkdown,
  registerSupernoteNativeEmbed,
} from "../src/viewer/obsidian-embed";
import { parseFixedPageEmbed } from "../src/viewer/fixed-page-embed";

const attributes = (values: Record<string, string>) => ({
  getAttribute: (name: string) => values[name] ?? null,
});

describe("Obsidian native Supernote embeds", () => {
  it("reconstructs caption and numeric aliases from the native container", () => {
    expect(
      nativeEmbedMarkdown(
        "Journal.note#page=15",
        attributes({ width: "500", height: "320" }),
      ),
    ).toBe("![[Journal.note#page=15|500x320]]");
    expect(
      nativeEmbedMarkdown("Journal.note", attributes({ alt: "Daily journal" })),
    ).toBe("![[Journal.note|Daily journal]]");
  });

  it("routes a page-qualified native preview through the fixed-page contract", () => {
    const markdown = nativeEmbedMarkdown("Journal.note#page=12", {
      getAttribute: () => null,
    });

    expect(parseFixedPageEmbed(markdown)).toEqual({
      linkpath: "Journal.note",
      pageNumber: 12,
      width: null,
      height: null,
      caption: null,
    });
  });

  it("does not turn Obsidian's generated Page-preview label into a footer", () => {
    const target = "supernote/Note/Journal/7 July 2026.note#page=12";
    const markdown = nativeEmbedMarkdown(
      target,
      attributes({
        alt: "supernote/Note/Journal/7 July 2026.note > page=12",
      }),
    );

    expect(markdown).toBe(`![[${target}]]`);
    expect(parseFixedPageEmbed(markdown)?.caption).toBeNull();
  });

  it("registers one lifecycle-owned renderer for the note extension", () => {
    const unregisterExtension = vi.fn();
    const registry = {
      isExtensionRegistered: vi.fn(() => false),
      registerExtension: vi.fn(),
      unregisterExtension,
    };
    let cleanup: (() => void) | null = null;
    const registered = registerSupernoteNativeEmbed(
      {
        app: { embedRegistry: registry } as never,
        register: (callback) => {
          cleanup = callback;
        },
      },
      { notebooks: vi.fn() },
    );

    expect(registered).toBe(true);
    expect(registry.registerExtension).toHaveBeenCalledWith(
      "note",
      expect.any(Function),
    );
    expect(cleanup).not.toBeNull();
    (cleanup as unknown as () => void)();
    expect(unregisterExtension).toHaveBeenCalledWith("note");
  });

  it("does not compete with an existing note embed renderer", () => {
    const registerExtension = vi.fn();

    expect(
      registerSupernoteNativeEmbed(
        {
          app: {
            embedRegistry: {
              isExtensionRegistered: () => true,
              registerExtension,
              unregisterExtension: vi.fn(),
            },
          } as never,
          register: vi.fn(),
        },
        { notebooks: vi.fn() },
      ),
    ).toBe(false);
    expect(registerExtension).not.toHaveBeenCalled();
  });

  it("does not add a competing CodeMirror replacement", () => {
    const main = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const adapter = readFileSync(
      new URL("../src/viewer/obsidian-embed.ts", import.meta.url),
      "utf8",
    );

    expect(main).not.toContain("registerEditorExtension(");
    expect(adapter).toContain("embedRegistry");
    expect(adapter).toContain("FixedPageReadingView");
    expect(adapter).toContain("NotebookReadingView");
    expect(adapter).toContain("openNotebook: () => open(fixed.pageNumber)");
    expect(adapter).not.toContain("NoteReader");
  });
});
