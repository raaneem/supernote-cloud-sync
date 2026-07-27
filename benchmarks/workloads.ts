import type { BenchmarkProfile } from "./harness";

export const REFERENCE_NOTEBOOK_PAGES = 20;
export const REFERENCE_GRID_PAGES = 1_000;
export const REFERENCE_SYNC_FILES = 500;
export const REFERENCE_SYNC_BYTES = 1_024 ** 3;

export interface PageWorkload {
  pages: number;
  width: number;
  height: number;
}

export interface SyncWorkload {
  files: number;
  bytesPerFile: number;
  totalBytes: number;
}

export const pageWorkload = (profile: BenchmarkProfile): PageWorkload => {
  if (profile === "smoke") {
    return { pages: 1, width: 192, height: 256 };
  }
  return {
    pages: profile === "reference" ? REFERENCE_NOTEBOOK_PAGES : 3,
    width: 1_920,
    height: 2_560,
  };
};

export const syncWorkload = (profile: BenchmarkProfile): SyncWorkload => {
  const files = profile === "smoke" ? 20 : REFERENCE_SYNC_FILES;
  const totalBytes =
    profile === "reference" ? REFERENCE_SYNC_BYTES : files * 64 * 1_024;
  return {
    files,
    bytesPerFile: Math.floor(totalBytes / files),
    totalBytes,
  };
};

export const blankRlePage = (width: number, height: number): Uint8Array => {
  const pixels = width * height;
  const runLength = 0x4_000;
  if (pixels % runLength !== 0) {
    throw new Error(
      `Generated RLE dimensions must contain a multiple of ${runLength} pixels`,
    );
  }
  const runs = pixels / runLength;
  const bytes = new Uint8Array(runs * 2);
  for (let index = 0; index < runs; index += 1) {
    bytes[index * 2] = 0x62;
    bytes[index * 2 + 1] = 0xff;
  }
  return bytes;
};

export const gridPages = (
  count = REFERENCE_GRID_PAGES,
): { label: string; pageNumber: number }[] =>
  Array.from({ length: count }, (_, index) => ({
    label: `Page ${index + 1}`,
    pageNumber: index + 1,
  }));

export const syncPaths = (files: number): string[] =>
  Array.from(
    { length: files },
    (_, index) =>
      `Supernote/Push/file-${String(index + 1).padStart(4, "0")}.bin`,
  );

export const generatedBytes = (size: number, index: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, index, true);
  bytes[bytes.length - 1] = index % 251;
  return bytes;
};
