import type { DesktopBatch } from "../shared/desktop-command";
import type { OcrPageSource } from "./types";

export interface PreparedImageBatch {
  fileName(pageNumber: number, extension: "md" | "png"): string;
}

export const prepareImageBatch = async (
  batch: Pick<DesktopBatch, "write">,
  pages: OcrPageSource,
): Promise<PreparedImageBatch> => {
  const width = Math.max(2, String(Math.max(...pages.pageNumbers, 1)).length);
  const fileName = (pageNumber: number, extension: "md" | "png"): string =>
    `page-${String(pageNumber).padStart(width, "0")}.${extension}`;

  for (const pageNumber of pages.pageNumbers) {
    await batch.write(
      fileName(pageNumber, "png"),
      await pages.render(pageNumber),
    );
  }

  return { fileName };
};
