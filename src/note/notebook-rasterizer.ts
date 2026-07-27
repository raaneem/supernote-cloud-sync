export interface RasterLayer {
  readonly LAYERNAME: string;
  readonly LAYERPROTOCOL: string;
  readonly bitmapBuffer: Uint8Array | null;
}

export interface RasterPage {
  readonly pageStyle: string;
  readonly layerSequence: readonly string[];
  readonly layers: Readonly<Record<string, RasterLayer>>;
}

export interface RasterizedNotebookPage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

export type BitmapBackgroundDecoder = (
  bytes: Uint8Array,
) => Promise<RasterizedNotebookPage>;

interface Rgba {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

const transparent: Rgba = { red: 0, green: 0, blue: 0, alpha: 0 };
const unknown: Rgba = { red: 255, green: 255, blue: 255, alpha: 0 };
const black: Rgba = { red: 0, green: 0, blue: 0, alpha: 255 };
const darkGray: Rgba = { red: 169, green: 169, blue: 169, alpha: 255 };
const gray: Rgba = { red: 128, green: 128, blue: 128, alpha: 255 };
const white: Rgba = { red: 255, green: 255, blue: 255, alpha: 255 };

const palette = new Map<number, Rgba>([
  [0x61, black],
  [0x62, transparent],
  [0x63, darkGray],
  [0x64, gray],
  [0x65, white],
  [0x66, black],
  [0x67, darkGray],
  [0x68, gray],
  [0x9d, darkGray],
  [0xc9, gray],
  [0x9e, darkGray],
  [0xca, gray],
]);

const isTransparentBlank = (color: Rgba): boolean =>
  color.red === 0 && color.green === 0 && color.blue === 0 && color.alpha === 0;

const writeRun = (
  pixels: Uint8ClampedArray,
  pixelOffset: number,
  length: number,
  color: Rgba,
): number => {
  const nextOffset = pixelOffset + length;
  if (nextOffset * 4 > pixels.byteLength) {
    throw new Error("Ratta RLE data exceeds the notebook page dimensions");
  }
  if (!isTransparentBlank(color)) {
    for (
      let byteOffset = pixelOffset * 4;
      byteOffset < nextOffset * 4;
      byteOffset += 4
    ) {
      pixels[byteOffset] = color.red;
      pixels[byteOffset + 1] = color.green;
      pixels[byteOffset + 2] = color.blue;
      pixels[byteOffset + 3] = color.alpha;
    }
  }
  return nextOffset;
};

/**
 * Run parsing follows supernote-typescript 0.3.0 (GPL-3.0-or-later), whose
 * decoder credits jya-dev/supernote-tool. This implementation writes runs
 * directly into the composite page instead of allocating a buffer per run or
 * per layer.
 */
const compositeRattaLayer = (
  encoded: Uint8Array,
  pixels: Uint8ClampedArray,
): void => {
  const expectedPixels = pixels.byteLength / 4;
  let pixelOffset = 0;
  let heldColor: number | null = null;
  let heldLength = 0;

  const emit = (encodedColor: number, length: number): void => {
    pixelOffset = writeRun(
      pixels,
      pixelOffset,
      length,
      palette.get(encodedColor) ?? unknown,
    );
  };

  for (let index = 1; index < encoded.length; index += 2) {
    const encodedColor = encoded[index - 1]!;
    let length = encoded[index]!;
    let emitted = false;
    if (heldColor !== null) {
      const previousColor: number = heldColor;
      const previousLength = heldLength;
      heldColor = null;
      if (encodedColor === previousColor) {
        length = 1 + length + (((previousLength & 0x7f) + 1) << 7);
        emit(encodedColor, length);
        emitted = true;
      } else {
        emit(previousColor, ((previousLength & 0x7f) + 1) << 7);
      }
    }
    if (emitted) {
      continue;
    }
    if (length === 0xff) {
      emit(encodedColor, 0x4000);
    } else if ((length & 0x80) !== 0) {
      heldColor = encodedColor;
      heldLength = length;
    } else {
      emit(encodedColor, length + 1);
    }
  }

  if (heldColor !== null) {
    const remainingPixels = expectedPixels - pixelOffset;
    for (let shift = 7; shift >= 0; shift -= 1) {
      const length = ((heldLength & 0x7f) + 1) << shift;
      if (length <= remainingPixels) {
        emit(heldColor, length);
        break;
      }
    }
  }
  if (pixelOffset !== expectedPixels) {
    throw new Error(
      `Ratta RLE decoded ${pixelOffset} pixels; expected ${expectedPixels}`,
    );
  }
};

const convertToGrayscale = (pixels: Uint8ClampedArray): void => {
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const gray =
      (pixels[offset]! * 6966 +
        pixels[offset + 1]! * 23_436 +
        pixels[offset + 2]! * 2366) >>
      15;
    pixels[offset] = gray;
    pixels[offset + 1] = gray;
    pixels[offset + 2] = gray;
  }
};

const compositeBitmap = (
  source: RasterizedNotebookPage,
  destination: RasterizedNotebookPage,
): void => {
  if (
    source.width !== destination.width ||
    source.height !== destination.height
  ) {
    throw new Error("Notebook bitmap background dimensions do not match page");
  }
  for (let offset = 0; offset < source.pixels.byteLength; offset += 4) {
    if (
      source.pixels[offset] === 0 &&
      source.pixels[offset + 1] === 0 &&
      source.pixels[offset + 2] === 0 &&
      source.pixels[offset + 3] === 0
    ) {
      continue;
    }
    destination.pixels[offset] = source.pixels[offset]!;
    destination.pixels[offset + 1] = source.pixels[offset + 1]!;
    destination.pixels[offset + 2] = source.pixels[offset + 2]!;
    destination.pixels[offset + 3] = source.pixels[offset + 3]!;
  }
};

export const rasterizeNotebookPage = async (
  width: number,
  height: number,
  page: RasterPage,
  decodeBitmapBackground: BitmapBackgroundDecoder,
): Promise<RasterizedNotebookPage> => {
  const output: RasterizedNotebookPage = {
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4),
  };
  const layers = page.layerSequence
    .map((name) => page.layers[name])
    .filter(
      (layer): layer is RasterLayer =>
        layer?.bitmapBuffer !== null &&
        layer?.bitmapBuffer !== undefined &&
        layer.bitmapBuffer.byteLength > 0,
    )
    .reverse();

  for (const layer of layers) {
    if (layer.LAYERNAME === "BGLAYER" && page.pageStyle.startsWith("user_")) {
      compositeBitmap(
        await decodeBitmapBackground(layer.bitmapBuffer!),
        output,
      );
    } else {
      if (layer.LAYERPROTOCOL !== "RATTA_RLE") {
        throw new Error(
          `Unsupported Supernote layer protocol: ${layer.LAYERPROTOCOL}`,
        );
      }
      compositeRattaLayer(layer.bitmapBuffer!, output.pixels);
    }
  }
  convertToGrayscale(output.pixels);
  return output;
};
