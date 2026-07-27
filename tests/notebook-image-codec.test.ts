import { decode } from "fast-png";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserNotebookImageCodec } from "../src/note/notebook-image-codec";

describe("browser notebook image codec", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes bitmap backgrounds with worker-native browser primitives", async () => {
    const pixels = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 255]);
    const source = {
      width: 2,
      height: 1,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: pixels }));
    const createImageBitmap = vi.fn(async (_input: Blob) => source);
    class TestOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext(): {
        drawImage: typeof drawImage;
        getImageData: typeof getImageData;
      } {
        return { drawImage, getImageData };
      }
    }
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    vi.stubGlobal("OffscreenCanvas", TestOffscreenCanvas);

    const decoded = await new BrowserNotebookImageCodec().decodeBitmap(
      Uint8Array.from([1, 2, 3]),
    );

    expect(createImageBitmap.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(decoded).toEqual({ width: 2, height: 1, pixels });
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("encodes flattened RGB PNGs with worker-native compression", async () => {
    const png = await new BrowserNotebookImageCodec().encodeOpaquePng({
      width: 2,
      height: 2,
      pixels: Uint8ClampedArray.from([
        255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 255, 255, 0, 255,
      ]),
    });

    const decoded = decode(png);
    expect(decoded).toMatchObject({
      channels: 3,
      depth: 8,
      height: 2,
      width: 2,
    });
    expect([...decoded.data]).toEqual([
      255, 0, 0, 255, 255, 255, 0, 255, 0, 255, 255, 0,
    ]);
  });

  it("falls back to the compatible RGBA encoder without compression streams", async () => {
    const codec = new BrowserNotebookImageCodec();
    const fallback = Uint8Array.from([1, 2, 3]);
    const encodePng = vi.spyOn(codec, "encodePng").mockResolvedValue(fallback);
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("CompressionStream", undefined);
    const page = {
      width: 1,
      height: 1,
      pixels: Uint8ClampedArray.from([10, 20, 30, 255]),
    };

    await expect(codec.encodeOpaquePng(page)).resolves.toBe(fallback);
    await expect(codec.encodeOpaquePng(page)).resolves.toBe(fallback);
    expect(encodePng).toHaveBeenCalledWith(page);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      "Supernote worker is using the compatible canvas PNG encoder because CompressionStream is unavailable.",
    );
  });
});
