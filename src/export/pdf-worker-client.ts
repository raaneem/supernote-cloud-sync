import type { MarkdownPdfPort } from "../sync/send-to-supernote";
import type { PdfExporter, PdfExportPage } from "./pdf-export";
import type {
  PdfWorkerRequest,
  PdfWorkerResponse,
  SerializedPdfPage,
} from "./pdf-worker-protocol";

type WorkerFactory = () => Worker;

class WorkerResponses {
  private readonly queued: PdfWorkerResponse[] = [];
  private waiter: ((response: PdfWorkerResponse) => void) | null = null;
  private failure: Error | null = null;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(event.data);
      } else {
        this.queued.push(event.data);
      }
    };
    worker.onerror = (event) => {
      this.failure = new Error(event.message || "PDF worker failed");
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter({ type: "error", id: -1, message: this.failure.message });
      }
    };
  }

  async next(id: number): Promise<PdfWorkerResponse> {
    if (this.failure) {
      throw this.failure;
    }
    const response =
      this.queued.shift() ??
      (await new Promise<PdfWorkerResponse>((resolve) => {
        this.waiter = resolve;
      }));
    if (response.type === "error") {
      throw new Error(response.message);
    }
    if (response.id !== id) {
      throw new Error("PDF worker returned a mismatched operation");
    }
    return response;
  }
}

const transferCopy = (bytes: Uint8Array): ArrayBuffer =>
  bytes.slice().buffer as ArrayBuffer;

export class WorkerPdfExporter implements PdfExporter {
  private nextId = 1;

  constructor(private readonly createWorker: WorkerFactory) {}

  async export(
    pages: AsyncIterable<PdfExportPage> | Iterable<PdfExportPage>,
  ): Promise<Uint8Array> {
    const worker = this.createWorker();
    const responses = new WorkerResponses(worker);
    const id = this.nextId++;
    try {
      post(worker, { type: "native-start", id });
      expectType(await responses.next(id), "ready");
      for await (const page of pages) {
        const png = transferCopy(page.png);
        const serialized: SerializedPdfPage = { ...page, png };
        post(worker, { type: "native-page", id, page: serialized }, [png]);
        const consumed = expectType(await responses.next(id), "page-consumed");
        if (consumed.pageNumber !== page.pageNumber) {
          throw new Error("PDF worker consumed an unexpected page");
        }
      }
      post(worker, { type: "native-finish", id });
      const result = expectType(await responses.next(id), "native-result");
      return new Uint8Array(result.pdf);
    } finally {
      worker.terminate();
    }
  }
}

export class WorkerMarkdownPdfRenderer implements MarkdownPdfPort {
  private nextId = 1;

  constructor(private readonly createWorker: WorkerFactory) {}

  async render(markdown: string): Promise<Uint8Array> {
    const worker = this.createWorker();
    const responses = new WorkerResponses(worker);
    const id = this.nextId++;
    try {
      post(worker, { type: "markdown", id, markdown });
      const result = expectType(await responses.next(id), "markdown-result");
      return new Uint8Array(result.pdf);
    } finally {
      worker.terminate();
    }
  }
}

const post = (
  worker: Worker,
  request: PdfWorkerRequest,
  transfer: Transferable[] = [],
): void => worker.postMessage(request, transfer);

const expectType = <Type extends PdfWorkerResponse["type"]>(
  response: PdfWorkerResponse,
  type: Type,
): Extract<PdfWorkerResponse, { type: Type }> => {
  if (response.type !== type) {
    throw new Error(`PDF worker returned ${response.type}; expected ${type}`);
  }
  return response as Extract<PdfWorkerResponse, { type: Type }>;
};
