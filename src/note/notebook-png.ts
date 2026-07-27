const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const chunkType = (value: string): Uint8Array =>
  Uint8Array.from([...value].map((character) => character.charCodeAt(0)));

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const output = new Uint8Array(data.byteLength + 12);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(chunkType(type), 4);
  output.set(data, 8);
  view.setUint32(
    data.byteLength + 8,
    crc32(output.subarray(4, data.byteLength + 8)),
  );
  return output;
};

const concatenate = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

export const encodeOpaqueNotebookPng = async (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> => {
  const rowBytes = width * 3 + 1;
  const compression = new CompressionStream("deflate");
  const compressedBytes = new Response(compression.readable).arrayBuffer();
  const writer = compression.writable.getWriter();
  const scanline = new Uint8Array(rowBytes);
  for (let row = 0; row < height; row += 1) {
    let source = row * width * 4;
    let destination = 1;
    for (let column = 0; column < width; column += 1) {
      const alphaByte = pixels[source + 3]!;
      if (alphaByte === 255) {
        scanline[destination] = pixels[source]!;
        scanline[destination + 1] = pixels[source + 1]!;
        scanline[destination + 2] = pixels[source + 2]!;
      } else {
        const alpha = alphaByte / 255;
        scanline[destination] = Math.round(
          pixels[source]! * alpha + 255 * (1 - alpha),
        );
        scanline[destination + 1] = Math.round(
          pixels[source + 1]! * alpha + 255 * (1 - alpha),
        );
        scanline[destination + 2] = Math.round(
          pixels[source + 2]! * alpha + 255 * (1 - alpha),
        );
      }
      source += 4;
      destination += 3;
    }
    await writer.write(scanline.slice());
    if ((row + 1) % 64 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  await writer.close();
  const compressed = new Uint8Array(await compressedBytes);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return concatenate([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
};
