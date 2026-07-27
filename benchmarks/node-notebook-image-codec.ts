import { decode, encode } from "fast-png";

import {
  flattenOnWhite,
  type NotebookImageCodec,
} from "../src/note/notebook-image-codec";
import { encodeOpaqueNotebookPng } from "../src/note/notebook-png";
import type { RasterizedNotebookPage } from "../src/note/notebook-rasterizer";

const rgbaPixels = (
  data: Uint8Array | Uint8ClampedArray | Uint16Array,
  channels: number,
): Uint8ClampedArray<ArrayBuffer> => {
  if (data instanceof Uint16Array) {
    throw new Error("16-bit notebook bitmap backgrounds are not supported");
  }
  if (channels === 4) {
    return new Uint8ClampedArray(data);
  }
  const pixels = new Uint8ClampedArray((data.length / channels) * 4);
  for (
    let source = 0, destination = 0;
    source < data.length;
    source += channels, destination += 4
  ) {
    const red = data[source]!;
    const green = channels === 1 || channels === 2 ? red : data[source + 1]!;
    const blue = channels === 1 || channels === 2 ? red : data[source + 2]!;
    const alpha =
      channels === 2
        ? data[source + 1]!
        : channels === 4
          ? data[source + 3]!
          : 255;
    pixels[destination] = red;
    pixels[destination + 1] = green;
    pixels[destination + 2] = blue;
    pixels[destination + 3] = alpha;
  }
  return pixels;
};

export class NodeNotebookImageCodec implements NotebookImageCodec {
  constructor(
    private readonly bitmapFactory: (
      page: RasterizedNotebookPage,
    ) => Promise<ImageBitmap> = async (page) =>
      ({
        width: page.width,
        height: page.height,
        close: () => undefined,
      }) as unknown as ImageBitmap,
  ) {}

  async decodeBitmap(bytes: Uint8Array): Promise<RasterizedNotebookPage> {
    const decoded = decode(bytes);
    if (decoded.depth !== 8) {
      throw new Error("16-bit notebook bitmap backgrounds are not supported");
    }
    return {
      width: decoded.width,
      height: decoded.height,
      pixels: rgbaPixels(decoded.data, decoded.channels),
    };
  }

  async createBitmap(page: RasterizedNotebookPage): Promise<ImageBitmap> {
    return this.bitmapFactory(page);
  }

  async resize(
    page: RasterizedNotebookPage,
    width: number,
  ): Promise<RasterizedNotebookPage> {
    const height = Math.max(1, Math.round((page.height * width) / page.width));
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(
        page.height - 1,
        Math.floor((y * page.height) / height),
      );
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(
          page.width - 1,
          Math.floor((x * page.width) / width),
        );
        const sourceOffset = (sourceY * page.width + sourceX) * 4;
        const destinationOffset = (y * width + x) * 4;
        pixels.set(
          page.pixels.subarray(sourceOffset, sourceOffset + 4),
          destinationOffset,
        );
      }
    }
    return { width, height, pixels };
  }

  async encodePng(page: RasterizedNotebookPage): Promise<Uint8Array> {
    const flattened = flattenOnWhite(page.pixels);
    return encode({
      width: page.width,
      height: page.height,
      data: flattened,
      depth: 8,
      channels: 4,
    });
  }

  encodeOpaquePng(page: RasterizedNotebookPage): Promise<Uint8Array> {
    return encodeOpaqueNotebookPng(page.pixels, page.width, page.height);
  }
}
