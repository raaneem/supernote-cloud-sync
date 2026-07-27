import type { RecognitionSpan } from "./recognition";
import type { TextBox } from "./textboxes";

export interface NotebookPageDescriptor {
  pageNumber: number;
  fingerprint: string;
  hasBitmapBackground?: boolean;
  bitmapBackgroundBytes?: number;
  recognitionText: string | null;
  recognitionSpans: readonly RecognitionSpan[];
}

export interface NotebookDescriptor {
  path: string;
  revision: string;
  pageCount: number;
  devicePage: number | null;
  pages: readonly NotebookPageDescriptor[];
  textBoxes: readonly TextBox[];
}

interface NotebookIdentity {
  path: string;
  revision: string;
}

export type NotebookSource =
  | (NotebookIdentity & {
      bytes: Uint8Array;
      transfer?: "move" | "copy";
    })
  | (NotebookIdentity & { load: () => Promise<Uint8Array> });
export interface RenderedNotebookPage {
  png: Uint8Array;
  width: number;
  height: number;
}
