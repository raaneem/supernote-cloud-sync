import { decodeEmbeddedFont } from "./font-codec";
import { MarkdownPdfRenderer } from "./markdown-pdf";
import { PdfLibExporter, type PdfExportPage } from "./pdf-export";
import symbolsFont from "@expo-google-fonts/noto-sans-symbols-2/400Regular/NotoSansSymbols2_400Regular.ttf";
import regularFont from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf";
import boldFont from "@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf";
import type {
  PdfWorkerRequest,
  PdfWorkerResponse,
  SerializedPdfPage,
} from "./pdf-worker-protocol";

interface PageQueueItem {
  done: boolean;
  page?: SerializedPdfPage;
}

class PageQueue {
  private readonly items: PageQueueItem[] = [];
  private waiter: ((item: PageQueueItem) => void) | null = null;

  push(page: SerializedPdfPage): void {
    this.enqueue({ done: false, page });
  }

  close(): void {
    this.enqueue({ done: true });
  }

  next(): Promise<PageQueueItem> {
    const item = this.items.shift();
    if (item) {
      return Promise.resolve(item);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private enqueue(item: PageQueueItem): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(item);
      return;
    }
    this.items.push(item);
  }
}

interface NativeRun {
  id: number;
  pages: PageQueue;
}

interface PdfWorkerFonts {
  symbols: Uint8Array;
  regular: Uint8Array;
  bold: Uint8Array;
}

export class PdfWorkerRuntime {
  private nativeRun: NativeRun | null = null;

  constructor(
    private readonly respond: (
      response: PdfWorkerResponse,
      transfer?: Transferable[],
    ) => void,
    private readonly fonts: PdfWorkerFonts = {
      symbols: symbolsFont,
      regular: regularFont,
      bold: boldFont,
    },
  ) {}

  handle(request: PdfWorkerRequest): void {
    try {
      if (request.type === "native-start") {
        this.startNative(request);
      } else if (request.type === "native-page") {
        this.requireNativeRun(request.id).pages.push(request.page);
      } else if (request.type === "native-finish") {
        this.requireNativeRun(request.id).pages.close();
      } else {
        void this.renderMarkdown(request);
      }
    } catch (error) {
      this.fail(request.id, error);
    }
  }

  private startNative(
    request: Extract<PdfWorkerRequest, { type: "native-start" }>,
  ): void {
    if (this.nativeRun) {
      throw new Error("PDF worker already has an active export");
    }
    const run = { id: request.id, pages: new PageQueue() };
    this.nativeRun = run;
    const exporter = new PdfLibExporter(decodeEmbeddedFont(this.fonts.symbols));
    this.respond({ type: "ready", id: request.id });
    void exporter
      .export(this.consumePages(run))
      .then((pdf) => {
        const bytes = exactBuffer(pdf);
        this.respond({ type: "native-result", id: request.id, pdf: bytes }, [
          bytes,
        ]);
      })
      .catch((error) => this.fail(request.id, error))
      .finally(() => {
        if (this.nativeRun === run) {
          this.nativeRun = null;
        }
      });
  }

  private async *consumePages(run: NativeRun): AsyncIterable<PdfExportPage> {
    while (true) {
      const item = await run.pages.next();
      if (item.done) {
        return;
      }
      const page = item.page!;
      yield { ...page, png: new Uint8Array(page.png) };
      this.respond({
        type: "page-consumed",
        id: run.id,
        pageNumber: page.pageNumber,
      });
    }
  }

  private async renderMarkdown(
    request: Extract<PdfWorkerRequest, { type: "markdown" }>,
  ): Promise<void> {
    try {
      const renderer = new MarkdownPdfRenderer(
        decodeEmbeddedFont(this.fonts.regular),
        decodeEmbeddedFont(this.fonts.bold),
      );
      const pdf = await renderer.render(request.markdown);
      const bytes = exactBuffer(pdf);
      this.respond({ type: "markdown-result", id: request.id, pdf: bytes }, [
        bytes,
      ]);
    } catch (error) {
      this.fail(request.id, error);
    }
  }

  private requireNativeRun(id: number): NativeRun {
    if (!this.nativeRun || this.nativeRun.id !== id) {
      throw new Error("PDF worker has no matching native export");
    }
    return this.nativeRun;
  }

  private fail(id: number, error: unknown): void {
    this.respond({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export const exactBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
};
