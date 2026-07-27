import { describe, expect, it } from "vitest";

import {
  countImageEmbedsBeforeLine,
  exportedPageReaderLink,
  NoteViewerState,
  pageFromViewState,
  planPageOpen,
  planRevisionHandoff,
  parsePageSubpath,
  resolveExportedPage,
} from "../src/viewer/state";

describe("NoteViewerState", () => {
  it("keeps pager navigation within the notebook", () => {
    const state = new NoteViewerState(3, 2);

    expect(state.next()).toBe(3);
    expect(state.next()).toBe(3);
    expect(state.previous()).toBe(2);
    expect(state.goTo(0)).toBe(1);
    expect(state.goTo(99)).toBe(3);
  });

  it("clamps an out-of-range initial page to the last page", () => {
    expect(new NoteViewerState(3, 99).currentPage).toBe(3);
  });

  it("tracks page selection independently from the current page", () => {
    const state = new NoteViewerState(5, 1);

    state.toggleSelected(1);
    state.toggleSelected(3);
    state.goTo(4);

    expect(state.selectedPages).toEqual([1, 3]);
    state.toggleSelected(1);
    expect(state.selectedPages).toEqual([3]);
  });

  it("clamps the current page but discards only invalid selections on handoff", () => {
    expect(planRevisionHandoff(10, [2, 5, 10], 5)).toEqual({
      currentPage: 5,
      selectedPages: [],
      discardedPages: [10],
    });
  });
});

describe("resolveExportedPage", () => {
  it("maps exported image order using Markdown provenance", () => {
    expect(
      resolveExportedPage("supernote/Note/Journal/Journal.note", [2, 4, 7], 1),
    ).toEqual({
      rawNotePath: "supernote/Note/Journal/Journal.note",
      pageNumber: 4,
    });
  });

  it("rejects missing or malformed provenance", () => {
    expect(resolveExportedPage(null, [1], 0)).toBeNull();
    expect(resolveExportedPage("note.md", [1], 0)).toBeNull();
    expect(resolveExportedPage("note.note", [], 0)).toBeNull();
    expect(resolveExportedPage("note.note", ["bad"], 0)).toBeNull();
  });

  it("builds the exact-page reader link for Obsidian navigation", () => {
    expect(
      exportedPageReaderLink({
        rawNotePath: "supernote/Note/Journal/Journal.note",
        pageNumber: 4,
      }),
    ).toBe("supernote/Note/Journal/Journal.note#page=4");
  });
});

describe("countImageEmbedsBeforeLine", () => {
  it("keeps page order across separately rendered Markdown sections", () => {
    const markdown = [
      "---",
      "supernote-pages: [3, 5]",
      "---",
      "### Page 3",
      "![[Attachments/export p03.png]]",
      "### Page 5",
      "![[Attachments/export p05.png]]",
    ].join("\n");

    expect(countImageEmbedsBeforeLine(markdown, 5)).toBe(1);
  });
});

describe("Supernote page deep links", () => {
  it("parses a page subpath from wiki links and open URL state", () => {
    expect(parsePageSubpath("#page=7")).toBe(7);
    expect(parsePageSubpath("page=12")).toBe(12);
    expect(pageFromViewState({ subpath: "#page=3" })).toBe(3);
    expect(pageFromViewState({ page: 9 })).toBe(9);
    expect(pageFromViewState({ page: 2, subpath: "#page=12" })).toBe(12);
  });

  it("ignores malformed and unrelated subpaths", () => {
    expect(parsePageSubpath("#page=0")).toBeNull();
    expect(parsePageSubpath("#page=-2")).toBeNull();
    expect(parsePageSubpath("#heading")).toBeNull();
    expect(pageFromViewState({ page: 1.5 })).toBeNull();
    expect(pageFromViewState(null)).toBeNull();
  });

  it("never clamps an unavailable explicit page to another page", () => {
    expect(planPageOpen(12, 3, 20)).toEqual({
      page: 12,
      unavailablePage: null,
    });
    expect(planPageOpen(12, 3, 8)).toEqual({
      page: 3,
      unavailablePage: 12,
    });
    expect(planPageOpen(null, 15, 8)).toEqual({
      page: 8,
      unavailablePage: null,
    });
  });
});
