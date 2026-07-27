export interface VaultStore {
  exists(path: string): Promise<boolean>;
  /** Returns an opaque metadata revision without reading file contents. */
  getRevision(path: string): Promise<string | null>;
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array | null>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, content: Uint8Array): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  delete(path: string): Promise<void>;
}
