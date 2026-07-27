export type ChecksumWorkerRequest =
  | {
      type: "hash";
      id: number;
      buffer: ArrayBuffer;
    }
  | {
      type: "cancel";
      id: number;
    };

export type ChecksumWorkerResponse =
  | {
      type: "hashed";
      id: number;
      checksum: string;
      buffer: ArrayBuffer;
    }
  | {
      type: "cancelled";
      id: number;
      buffer: ArrayBuffer;
    }
  | {
      type: "error";
      id: number;
      message: string;
      buffer: ArrayBuffer;
    };
