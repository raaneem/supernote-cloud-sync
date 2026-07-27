export interface GridWindowInput {
  pageCount: number;
  scrollTop: number;
  viewportHeight: number;
  viewportWidth: number;
}

export interface GridWindowPlan {
  cardHeight: number;
  columns: number;
  contentHeight: number;
  endPage: number;
  endRow: number;
  mountedPages: number;
  offsetTop: number;
  rowHeight: number;
  startPage: number;
  startRow: number;
}

const CARD_ASPECT_HEIGHT = 4 / 3;
const CARD_CHROME_HEIGHT = 44;
const GAP = 12;
const MIN_CARD_WIDTH = 150;
const OVERSCAN_ROWS = 2;
const PADDING_BOTTOM = 24;
const PADDING_TOP = 68;
const PADDING_X = 12;

/**
 * Plans the bounded DOM window for the page grid.
 *
 * Two rows on either side of the viewport are retained. Geometry is explicit
 * so scrolling never needs to materialize off-screen cards to measure them.
 */
export const planGridWindow = ({
  pageCount,
  scrollTop,
  viewportHeight,
  viewportWidth,
}: GridWindowInput): GridWindowPlan => {
  const safePageCount = Math.max(0, Math.trunc(pageCount));
  const availableWidth = Math.max(1, viewportWidth - PADDING_X * 2);
  const columns = Math.max(
    1,
    Math.floor((availableWidth + GAP) / (MIN_CARD_WIDTH + GAP)),
  );
  const cardWidth = Math.max(
    1,
    (availableWidth - GAP * (columns - 1)) / columns,
  );
  const cardHeight = cardWidth * CARD_ASPECT_HEIGHT + CARD_CHROME_HEIGHT;
  const rowHeight = cardHeight + GAP;
  const rows = Math.ceil(safePageCount / columns);
  const contentHeight =
    PADDING_TOP + Math.max(0, rows * rowHeight - GAP) + PADDING_BOTTOM;
  const visibleTop = Math.max(0, scrollTop - PADDING_TOP);
  const visibleBottom = Math.max(
    visibleTop,
    scrollTop + Math.max(0, viewportHeight) - PADDING_TOP,
  );
  const firstVisibleRow = Math.min(
    Math.max(0, rows - 1),
    Math.floor(visibleTop / rowHeight),
  );
  const afterVisibleRow = Math.min(
    rows,
    Math.max(firstVisibleRow + 1, Math.ceil(visibleBottom / rowHeight)),
  );
  const startRow = Math.max(0, firstVisibleRow - OVERSCAN_ROWS);
  const endRow = Math.min(rows, afterVisibleRow + OVERSCAN_ROWS);
  const startPage =
    safePageCount === 0 ? 0 : Math.min(safePageCount, startRow * columns + 1);
  const endPage = Math.min(safePageCount, endRow * columns);

  return {
    cardHeight,
    columns,
    contentHeight,
    endPage,
    endRow,
    mountedPages:
      startPage === 0 || endPage < startPage ? 0 : endPage - startPage + 1,
    offsetTop: PADDING_TOP + startRow * rowHeight,
    rowHeight,
    startPage,
    startRow,
  };
};

export const gridPageNumbers = (plan: GridWindowPlan): number[] =>
  plan.startPage === 0
    ? []
    : Array.from(
        { length: plan.mountedPages },
        (_, index) => plan.startPage + index,
      );

export const gridScrollTopForPage = (
  pageNumber: number,
  viewportHeight: number,
  plan: Pick<GridWindowPlan, "cardHeight" | "columns" | "rowHeight">,
): number => {
  const row = Math.floor((Math.max(1, pageNumber) - 1) / plan.columns);
  return Math.max(
    0,
    PADDING_TOP +
      row * plan.rowHeight -
      Math.max(0, viewportHeight - plan.cardHeight) / 2,
  );
};
