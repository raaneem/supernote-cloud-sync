import type { OcrPage, OcrPageSource } from "../src/ocr/types";

export const fixedOcrPageSource = (
  pages: readonly OcrPage[],
): OcrPageSource => {
  const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
  return {
    pageNumbers: pages.map((page) => page.pageNumber),
    render: async (pageNumber) => {
      const page = byNumber.get(pageNumber);
      if (!page) {
        throw new Error(`Missing OCR page ${pageNumber}`);
      }
      return page.image;
    },
  };
};
