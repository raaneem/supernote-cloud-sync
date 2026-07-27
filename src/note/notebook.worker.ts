import type {
  NotebookWorkerRequest,
  NotebookWorkerResponse,
} from "./notebook-worker-protocol";
import { NotebookWorkerRuntime } from "./notebook-worker-runtime";

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<NotebookWorkerRequest>) => void;
  postMessage: (
    message: NotebookWorkerResponse,
    transfer?: Transferable[],
  ) => void;
};

const runtime = new NotebookWorkerRuntime();

workerScope.onmessage = (event): void => {
  void runtime.handle(event.data).then((response) => {
    if (!response) {
      return;
    }
    if (response.type !== "rendered") {
      workerScope.postMessage(response);
      return;
    }
    if (response.output === "bitmap") {
      workerScope.postMessage(response, [response.bitmap]);
      return;
    }
    const buffer = response.page.png.buffer;
    workerScope.postMessage(
      {
        ...response,
        page: {
          ...response.page,
          png: new Uint8Array(
            buffer,
            response.page.png.byteOffset,
            response.page.png.byteLength,
          ),
        },
      },
      buffer instanceof ArrayBuffer ? [buffer] : [],
    );
  });
};
