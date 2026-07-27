import SparkMD5 from "spark-md5";

export const md5 = (bytes: Uint8Array): string =>
  SparkMD5.ArrayBuffer.hash(
    bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : Uint8Array.from(bytes).buffer,
  );

export const sameMd5 = (left: string, right: string): boolean =>
  left.toLocaleLowerCase() === right.toLocaleLowerCase();
