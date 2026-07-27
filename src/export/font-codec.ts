import pako from "pako";

export const decodeEmbeddedFont = (compressed: Uint8Array): Uint8Array =>
  pako.ungzip(compressed);
