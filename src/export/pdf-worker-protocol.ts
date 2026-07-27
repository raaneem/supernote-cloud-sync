import type { PdfExportPage } from "./pdf-export";

export interface SerializedPdfPage extends Omit<PdfExportPage, "png"> {
  png: ArrayBuffer;
}

export type PdfWorkerRequest =
  | {
      type: "native-start";
      id: number;
    }
  | {
      type: "native-page";
      id: number;
      page: SerializedPdfPage;
    }
  | {
      type: "native-finish";
      id: number;
    }
  | {
      type: "markdown";
      id: number;
      markdown: string;
    };

export type PdfWorkerResponse =
  | {
      type: "ready";
      id: number;
    }
  | {
      type: "page-consumed";
      id: number;
      pageNumber: number;
    }
  | {
      type: "native-result";
      id: number;
      pdf: ArrayBuffer;
    }
  | {
      type: "markdown-result";
      id: number;
      pdf: ArrayBuffer;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
