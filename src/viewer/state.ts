import { normalizeRelativePath } from "../shared/path";

export interface RevisionHandoffPlan {
  currentPage: number;
  selectedPages: readonly number[];
  discardedPages: readonly number[];
}

export interface PageOpenPlan {
  page: number;
  unavailablePage: number | null;
}

export const planPageOpen = (
  requestedPage: number | null,
  fallbackPage: number,
  pageCount: number,
): PageOpenPlan => {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("A Supernote viewer requires at least one page");
  }
  const fallback = Math.max(
    1,
    Math.min(
      pageCount,
      Number.isFinite(fallbackPage) ? Math.trunc(fallbackPage) : 1,
    ),
  );
  if (requestedPage === null) {
    return { page: fallback, unavailablePage: null };
  }
  return requestedPage <= pageCount
    ? { page: requestedPage, unavailablePage: null }
    : { page: fallback, unavailablePage: requestedPage };
};

export const planRevisionHandoff = (
  currentPage: number,
  selectedPages: readonly number[],
  nextPageCount: number,
): RevisionHandoffPlan => {
  if (!Number.isInteger(nextPageCount) || nextPageCount < 1) {
    throw new Error("A Supernote viewer requires at least one page");
  }
  const normalizedSelection = [
    ...new Set(
      selectedPages.filter(
        (pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0,
      ),
    ),
  ].sort((left, right) => left - right);
  const discardedPages = normalizedSelection.filter(
    (pageNumber) => pageNumber > nextPageCount,
  );
  return {
    currentPage: Math.max(
      1,
      Math.min(
        nextPageCount,
        Number.isFinite(currentPage) ? Math.trunc(currentPage) : 1,
      ),
    ),
    selectedPages: discardedPages.length === 0 ? normalizedSelection : [],
    discardedPages,
  };
};

export class NoteViewerState {
  private current: number;
  private readonly selected = new Set<number>();

  constructor(
    readonly pageCount: number,
    initialPage = 1,
  ) {
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error("A Supernote viewer requires at least one page");
    }
    this.current = this.clamp(initialPage);
  }

  get currentPage(): number {
    return this.current;
  }

  get selectedPages(): number[] {
    return [...this.selected].sort((left, right) => left - right);
  }

  next(): number {
    return this.goTo(this.current + 1);
  }

  previous(): number {
    return this.goTo(this.current - 1);
  }

  goTo(pageNumber: number): number {
    this.current = this.clamp(pageNumber);
    return this.current;
  }

  toggleSelected(pageNumber: number): void {
    const page = this.clamp(pageNumber);
    if (this.selected.has(page)) {
      this.selected.delete(page);
    } else {
      this.selected.add(page);
    }
  }

  isSelected(pageNumber: number): boolean {
    return this.selected.has(pageNumber);
  }

  clearSelection(): void {
    this.selected.clear();
  }

  selectAll(): void {
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      this.selected.add(pageNumber);
    }
  }

  private clamp(pageNumber: number): number {
    if (!Number.isFinite(pageNumber)) {
      return 1;
    }
    return Math.max(1, Math.min(this.pageCount, Math.trunc(pageNumber)));
  }
}

export interface ResolvedExportedPage {
  rawNotePath: string;
  pageNumber: number;
}

export const exportedPageReaderLink = (page: ResolvedExportedPage): string =>
  `${page.rawNotePath}#page=${page.pageNumber}`;

export const parsePageSubpath = (subpath: unknown): number | null => {
  if (typeof subpath !== "string") {
    return null;
  }
  const match = /^#?page=(\d+)$/i.exec(subpath.trim());
  if (!match) {
    return null;
  }
  const page = Number(match[1]);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
};

export const pageFromViewState = (state: unknown): number | null => {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const record = state as Record<string, unknown>;
  const subpathPage = parsePageSubpath(record.subpath);
  if (subpathPage !== null) {
    return subpathPage;
  }
  const page = record.page;
  if (Number.isSafeInteger(page) && Number(page) > 0) {
    return Number(page);
  }
  return null;
};

export const countImageEmbedsBeforeLine = (
  markdown: string,
  lineNumber: number,
): number => {
  const prefix = markdown
    .split(/\r?\n/)
    .slice(0, Math.max(0, Math.trunc(lineNumber)))
    .join("\n");
  return (
    prefix.match(/!\[\[[^\]]+\.(?:png|jpe?g|gif|webp)(?:\|[^\]]*)?\]\]/gi) ?? []
  ).length;
};

export const resolveExportedPage = (
  sourceNote: unknown,
  pages: unknown,
  imageIndex: number,
): ResolvedExportedPage | null => {
  if (
    typeof sourceNote !== "string" ||
    !sourceNote.toLocaleLowerCase().endsWith(".note") ||
    !Array.isArray(pages) ||
    !Number.isInteger(imageIndex) ||
    imageIndex < 0
  ) {
    return null;
  }
  const pageNumber = Number(pages[imageIndex]);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return null;
  }
  return {
    rawNotePath: normalizeRelativePath(sourceNote),
    pageNumber,
  };
};
