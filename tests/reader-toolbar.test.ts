import { describe, expect, it, vi } from "vitest";

import {
  MobileReaderNavbarVisibility,
  readerToolbarIsCompact,
  readerToolbarNativeActionIdsForPhone,
  readerToolbarPresentation,
} from "../src/viewer/reader-toolbar";

describe("Reader toolbar presentation", () => {
  it("shows the complete pager action group in a roomy pane", () => {
    const presentation = readerToolbarPresentation({
      mode: "pager",
      compact: false,
      selecting: false,
      selectedPages: 0,
      canZoomOut: false,
      canZoomIn: true,
      showZoomControls: true,
    });

    expect(presentation.visibleActions.map((action) => action.id)).toEqual([
      "pages",
      "zoom-out",
      "zoom-in",
      "copy-page",
      "copy-notebook",
      "export-current",
    ]);
    expect(presentation.visibleActions.slice(1, 3)).toMatchObject([
      { id: "zoom-out", disabled: true },
      { id: "zoom-in", disabled: false },
    ]);
    expect(presentation.menuActions).toEqual([]);
  });

  it("leaves zoom entirely to gestures on mobile", () => {
    const presentation = readerToolbarPresentation({
      mode: "pager",
      compact: true,
      selecting: false,
      selectedPages: 0,
      canZoomOut: true,
      canZoomIn: true,
      showZoomControls: false,
    });

    expect(presentation.menuActions.map((action) => action.id)).not.toContain(
      "zoom-out",
    );
    expect(presentation.menuActions.map((action) => action.id)).not.toContain(
      "zoom-in",
    );
  });

  it("moves the complete pager action group into the compact menu", () => {
    const presentation = readerToolbarPresentation({
      mode: "pager",
      compact: true,
      selecting: false,
      selectedPages: 0,
      canZoomOut: false,
      canZoomIn: true,
      showZoomControls: true,
    });

    expect(presentation.visibleActions).toEqual([]);
    expect(presentation.menuActions.map((action) => action.id)).toEqual([
      "pages",
      "zoom-out",
      "zoom-in",
      "copy-page",
      "copy-notebook",
      "export-current",
    ]);
  });

  it("shows contextual grid actions and the selected-page count", () => {
    const presentation = readerToolbarPresentation({
      mode: "grid",
      compact: false,
      selecting: true,
      selectedPages: 3,
      canZoomOut: false,
      canZoomIn: true,
      showZoomControls: true,
    });

    expect(presentation.visibleActions).toEqual([
      {
        id: "back",
        icon: "arrow-left",
        label: "Back to page",
        disabled: false,
        badge: null,
      },
      {
        id: "toggle-selection",
        icon: "check",
        label: "Done selecting pages",
        disabled: false,
        badge: null,
      },
      {
        id: "export-selected",
        icon: "download",
        label: "Export selected (3)",
        disabled: false,
        badge: 3,
      },
    ]);
    expect(presentation.menuActions).toEqual([]);
  });

  it("keeps a zero badge on the disabled grid export action", () => {
    const presentation = readerToolbarPresentation({
      mode: "grid",
      compact: false,
      selecting: false,
      selectedPages: 0,
      canZoomOut: false,
      canZoomIn: true,
      showZoomControls: true,
    });

    expect(presentation.visibleActions.at(-1)).toMatchObject({
      id: "export-selected",
      label: "Export selected (0)",
      disabled: true,
      badge: 0,
    });
  });

  it("compacts from pane width rather than device category", () => {
    expect(readerToolbarIsCompact(480)).toBe(true);
    expect(readerToolbarIsCompact(900)).toBe(false);
  });

  it("does not register individual native actions in the phone header", () => {
    expect(readerToolbarNativeActionIdsForPhone(true)).toEqual([]);
  });

  it("restores bottom navigation only when the owning reader releases it", () => {
    const applyHidden = vi.fn();
    const visibility = new MobileReaderNavbarVisibility<object>(applyHidden);
    const firstReader = {};
    const secondReader = {};

    visibility.sync(firstReader, true);
    visibility.sync(secondReader, true);
    visibility.sync(firstReader, false);
    visibility.sync(secondReader, false);

    expect(applyHidden.mock.calls).toEqual([[true], [false]]);
  });
});
