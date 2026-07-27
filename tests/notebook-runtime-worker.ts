import type {
  NotebookWorkerRequest,
  NotebookWorkerResponse,
} from "../src/note/notebook-worker-protocol";
import type { NotebookImageCodec } from "../src/note/notebook-image-codec";
import { NotebookWorkerRuntime } from "../src/note/notebook-worker-runtime";
import { NodeNotebookImageCodec } from "../benchmarks/node-notebook-image-codec";

export class NotebookRuntimeWorker {
  onmessage: ((event: MessageEvent<NotebookWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private readonly runtime: NotebookWorkerRuntime;

  constructor(imageCodec: NotebookImageCodec = new NodeNotebookImageCodec()) {
    this.runtime = new NotebookWorkerRuntime(imageCodec);
  }
  private terminated = false;

  postMessage(request: NotebookWorkerRequest): void {
    if (this.terminated) {
      throw new Error("Notebook test worker is terminated");
    }
    void this.runtime.handle(request).then(
      (response) => {
        if (response && !this.terminated) {
          this.onmessage?.({
            data: response,
          } as MessageEvent<NotebookWorkerResponse>);
        }
      },
      (error: unknown) => {
        this.onerror?.({
          message:
            error instanceof Error
              ? error.message
              : "Notebook test worker failed",
        } as ErrorEvent);
      },
    );
  }

  terminate(): void {
    this.terminated = true;
  }
}
