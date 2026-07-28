export type ReaderToolbarMode = "pager" | "grid";

export type ReaderToolbarActionId =
  | "pages"
  | "zoom-out"
  | "zoom-in"
  | "copy-page"
  | "copy-notebook"
  | "export-current"
  | "back"
  | "toggle-selection"
  | "export-selected";

export interface ReaderToolbarContext {
  mode: ReaderToolbarMode;
  selecting: boolean;
  selectedPages: number;
  canZoomOut: boolean;
  canZoomIn: boolean;
}

export interface ReaderToolbarState extends ReaderToolbarContext {
  compact: boolean;
  showZoomControls: boolean;
}

export interface ReaderToolbarAction {
  id: ReaderToolbarActionId;
  icon: string;
  label: string;
  disabled: boolean;
  badge: number | null;
}

export interface ReaderToolbarPresentation {
  visibleActions: readonly ReaderToolbarAction[];
  menuActions: readonly ReaderToolbarAction[];
}

export const READER_TOOLBAR_ACTION_CATALOG: Readonly<
  Record<ReaderToolbarActionId, { icon: string; label: string }>
> = {
  pages: { icon: "layout-grid", label: "Pages" },
  "zoom-out": { icon: "zoom-out", label: "Zoom out" },
  "zoom-in": { icon: "zoom-in", label: "Zoom in" },
  "copy-page": { icon: "copy", label: "Copy current page embed" },
  "copy-notebook": { icon: "notebook", label: "Copy notebook embed" },
  "export-current": { icon: "download", label: "Export current page" },
  back: { icon: "arrow-left", label: "Back to page" },
  "toggle-selection": { icon: "list-checks", label: "Select pages" },
  "export-selected": {
    icon: "download",
    label: "Export selected pages",
  },
};

const READER_TOOLBAR_ACTION_IDS = Object.keys(
  READER_TOOLBAR_ACTION_CATALOG,
) as ReaderToolbarActionId[];

const ROOMY_READER_TOOLBAR_MIN_WIDTH = 600;

export const readerToolbarIsCompact = (paneWidth: number): boolean =>
  paneWidth < ROOMY_READER_TOOLBAR_MIN_WIDTH;

export const readerToolbarNativeActionIdsForPhone = (
  isPhone: boolean,
): readonly ReaderToolbarActionId[] =>
  isPhone ? [] : READER_TOOLBAR_ACTION_IDS;

export class MobileReaderNavbarVisibility<Owner> {
  private owner: Owner | null = null;

  constructor(private readonly applyHidden: (hidden: boolean) => void) {}

  sync(candidate: Owner, hidden: boolean): void {
    if (hidden) {
      const wasHidden = this.owner !== null;
      this.owner = candidate;
      if (!wasHidden) {
        this.applyHidden(true);
      }
      return;
    }
    if (this.owner !== candidate) {
      return;
    }
    this.owner = null;
    this.applyHidden(false);
  }
}

const action = (
  id: ReaderToolbarActionId,
  icon: string,
  label: string,
): ReaderToolbarAction => ({
  id,
  icon,
  label,
  disabled: false,
  badge: null,
});

const catalogAction = (id: ReaderToolbarActionId): ReaderToolbarAction => {
  const definition = READER_TOOLBAR_ACTION_CATALOG[id];
  return action(id, definition.icon, definition.label);
};

export const readerToolbarPresentation = (
  state: ReaderToolbarState,
): ReaderToolbarPresentation => {
  const zoomActions = state.showZoomControls
    ? [
        {
          ...catalogAction("zoom-out"),
          disabled: !state.canZoomOut,
        },
        {
          ...catalogAction("zoom-in"),
          disabled: !state.canZoomIn,
        },
      ]
    : [];
  const pagerActions = [
    catalogAction("pages"),
    ...zoomActions,
    catalogAction("copy-page"),
    catalogAction("copy-notebook"),
    catalogAction("export-current"),
  ];
  const gridActions = [
    catalogAction("back"),
    {
      ...catalogAction("toggle-selection"),
      ...(state.selecting
        ? { icon: "check", label: "Done selecting pages" }
        : {}),
    },
    {
      ...catalogAction("export-selected"),
      label: `Export selected (${state.selectedPages})`,
      disabled: state.selectedPages === 0,
      badge: state.selectedPages,
    },
  ];
  const actions = state.mode === "grid" ? gridActions : pagerActions;
  return {
    visibleActions: state.compact ? [] : actions,
    menuActions: state.compact ? actions : [],
  };
};
