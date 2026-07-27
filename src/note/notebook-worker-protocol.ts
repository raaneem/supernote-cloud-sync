import type {
  NotebookDescriptor,
  RenderedNotebookPage,
} from "./notebook-types";

export type NotebookWorkerRequest =
  | {
      type: "open";
      id: number;
      sessionId: number;
      generation: number;
      path: string;
      revision: string;
      bytes: ArrayBuffer;
    }
  | {
      type: "close";
      sessionId: number;
      generation: number;
    }
  | {
      type: "cancel";
      id: number;
      sessionId: number;
      generation: number;
    }
  | {
      type: "render";
      id: number;
      sessionId: number;
      generation: number;
      pageNumber: number;
      output: "bitmap";
      maxWidth?: number;
    }
  | {
      type: "render";
      id: number;
      sessionId: number;
      generation: number;
      pageNumber: number;
      output: "png";
      scale: number;
      encoding?: "opaque-rgb";
    };

export type NotebookWorkerResponse =
  | {
      type: "opened";
      id: number;
      sessionId: number;
      generation: number;
      pagePixelBytes: number;
      pageWidth: number;
      pageHeight: number;
      parsedMetadataBytes: number;
      descriptorMetadataBytes: number;
      descriptor: NotebookDescriptor;
    }
  | {
      type: "error";
      id: number;
      sessionId: number;
      generation: number;
      message: string;
      errorKind?: "cancelled";
    }
  | {
      type: "rendered";
      id: number;
      sessionId: number;
      generation: number;
      output: "bitmap";
      bitmap: ImageBitmap;
    }
  | {
      type: "rendered";
      id: number;
      sessionId: number;
      generation: number;
      output: "png";
      page: RenderedNotebookPage;
    };
