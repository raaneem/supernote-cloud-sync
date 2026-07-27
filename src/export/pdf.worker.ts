import type {
  PdfWorkerRequest,
  PdfWorkerResponse,
} from "./pdf-worker-protocol";
import { PdfWorkerRuntime } from "./pdf-worker-runtime";

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<PdfWorkerRequest>) => void;
  postMessage: (response: PdfWorkerResponse, transfer?: Transferable[]) => void;
};

const runtime = new PdfWorkerRuntime((response, transfer = []) => {
  workerScope.postMessage(response, transfer);
});

workerScope.onmessage = (event) => {
  runtime.handle(event.data);
};

export type { PdfWorkerRequest, PdfWorkerResponse };
