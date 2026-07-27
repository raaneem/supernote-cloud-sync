import type {
  ChecksumWorkerRequest,
  ChecksumWorkerResponse,
} from "./checksum-worker-protocol";
import { ChecksumWorkerRuntime } from "./checksum-worker-runtime";

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<ChecksumWorkerRequest>) => void;
  postMessage: (
    message: ChecksumWorkerResponse,
    transfer?: Transferable[],
  ) => void;
};

const runtime = new ChecksumWorkerRuntime();

workerScope.onmessage = (event): void => {
  void runtime.handle(event.data).then((response) => {
    if (response) {
      workerScope.postMessage(response, [response.buffer]);
    }
  });
};
