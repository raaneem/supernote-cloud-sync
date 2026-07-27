import type { RasterizedNotebookPage } from "./notebook-rasterizer";
import { encodeOpaqueNotebookPng } from "./notebook-png";

export interface NotebookImageCodec {
  decodeBitmap(bytes: Uint8Array): Promise<RasterizedNotebookPage>;
  createBitmap(page: RasterizedNotebookPage): Promise<ImageBitmap>;
  resize(
    page: RasterizedNotebookPage,
    width: number,
  ): Promise<RasterizedNotebookPage>;
  encodePng(page: RasterizedNotebookPage): Promise<Uint8Array>;
  encodeOpaquePng?(page: RasterizedNotebookPage): Promise<Uint8Array>;
}

export const flattenOnWhite = (
  pixels: Uint8ClampedArray,
): Uint8ClampedArray => {
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const alpha = pixels[offset + 3]! / 255;
    pixels[offset] = Math.round(pixels[offset]! * alpha + 255 * (1 - alpha));
    pixels[offset + 1] = Math.round(
      pixels[offset + 1]! * alpha + 255 * (1 - alpha),
    );
    pixels[offset + 2] = Math.round(
      pixels[offset + 2]! * alpha + 255 * (1 - alpha),
    );
    pixels[offset + 3] = 255;
  }
  return pixels;
};

const contextFor = (
  canvas: OffscreenCanvas,
): OffscreenCanvasRenderingContext2D => {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Supernote worker cannot create a 2D canvas");
  }
  return context;
};

const imageDataFor = (page: RasterizedNotebookPage): ImageData =>
  new ImageData(page.pixels, page.width, page.height);

const drawRaster = async (
  page: RasterizedNotebookPage,
  width: number,
  height: number,
): Promise<RasterizedNotebookPage> => {
  const source = await createImageBitmap(imageDataFor(page));
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = contextFor(canvas);
    context.drawImage(source, 0, 0, width, height);
    return {
      width,
      height,
      pixels: context.getImageData(0, 0, width, height).data,
    };
  } finally {
    source.close();
  }
};

export class BrowserNotebookImageCodec implements NotebookImageCodec {
  private compatibleEncoderReported = false;

  async decodeBitmap(bytes: Uint8Array): Promise<RasterizedNotebookPage> {
    const source = await createImageBitmap(new Blob([bytes]));
    try {
      const canvas = new OffscreenCanvas(source.width, source.height);
      const context = contextFor(canvas);
      context.drawImage(source, 0, 0);
      return {
        width: source.width,
        height: source.height,
        pixels: context.getImageData(0, 0, source.width, source.height).data,
      };
    } finally {
      source.close();
    }
  }

  createBitmap(page: RasterizedNotebookPage): Promise<ImageBitmap> {
    return createImageBitmap(imageDataFor(page));
  }

  resize(
    page: RasterizedNotebookPage,
    width: number,
  ): Promise<RasterizedNotebookPage> {
    const height = Math.max(1, Math.round((page.height * width) / page.width));
    return drawRaster(page, width, height);
  }

  async encodePng(page: RasterizedNotebookPage): Promise<Uint8Array> {
    const flattened = flattenOnWhite(page.pixels);
    const canvas = new OffscreenCanvas(page.width, page.height);
    contextFor(canvas).putImageData(
      new ImageData(flattened, page.width, page.height),
      0,
      0,
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }

  encodeOpaquePng(page: RasterizedNotebookPage): Promise<Uint8Array> {
    if (typeof CompressionStream === "undefined") {
      if (!this.compatibleEncoderReported) {
        this.compatibleEncoderReported = true;
        console.warn(
          "Supernote worker is using the compatible canvas PNG encoder because CompressionStream is unavailable.",
        );
      }
      return this.encodePng(page);
    }
    return encodeOpaqueNotebookPng(page.pixels, page.width, page.height);
  }
}
