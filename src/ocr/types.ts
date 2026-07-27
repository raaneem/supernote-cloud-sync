export type TranscriptionMode = "page" | "document";

export interface OcrPage {
  pageNumber: number;
  image: Uint8Array;
}

export interface OcrPageSource {
  pageNumbers: readonly number[];
  render(pageNumber: number): Promise<Uint8Array>;
}

export interface OcrRequest {
  mode: TranscriptionMode;
  note: string;
  customPrompt?: string;
  pages: OcrPageSource;
}

export interface OcrResult {
  pageText: ReadonlyMap<number, string>;
  documentText: string | null;
  failedPages: readonly number[];
  errors: readonly string[];
  retainedBatchPath?: string;
}

export interface PreparedOcr {
  remainingPageNumbers: readonly number[];
  transcribe(): Promise<OcrResult>;
}

export interface OcrPort {
  prepare(request: OcrRequest): Promise<PreparedOcr>;
}

export const emptyOcrResult = (): OcrResult => ({
  pageText: new Map(),
  documentText: null,
  failedPages: [],
  errors: [],
});
