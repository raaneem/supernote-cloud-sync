import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { encode } from "fast-png";
import { SupernoteX } from "supernote-typescript/lib/parsing";
import { describe, expect, it } from "vitest";

import { NodeNotebookImageCodec } from "../benchmarks/node-notebook-image-codec";
import { rasterizeNotebookPage } from "../src/note/notebook-rasterizer";

const fixturePath = process.env.SUPERNOTE_REAL_NOTE_FIXTURE ?? "";

const layer = (name: string, bitmap: number[]) => ({
  LAYERNAME: name,
  LAYERPROTOCOL: "RATTA_RLE",
  bitmapBuffer: Uint8Array.from(bitmap),
});

describe("notebook rasterizer", () => {
  it("composites Ratta RLE layers directly into one RGBA buffer", async () => {
    const page = await rasterizeNotebookPage(
      2,
      2,
      {
        pageStyle: "style_white_a5x2",
        layerSequence: ["MAINLAYER", "BGLAYER"],
        layers: {
          MAINLAYER: layer("MAINLAYER", [0x62, 0, 0x61, 0, 0x64, 0, 0x62, 0]),
          BGLAYER: layer("BGLAYER", [0x65, 3]),
        },
      },
      async () => {
        throw new Error("Unexpected bitmap background");
      },
    );

    expect(page).toEqual({
      width: 2,
      height: 2,
      pixels: Uint8ClampedArray.from([
        255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255,
        255,
      ]),
    });
  });

  it("decodes and grayscales a generated PNG user background", async () => {
    const backgroundBytes = encode({
      width: 2,
      height: 1,
      data: Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255]),
      depth: 8,
      channels: 4,
    });
    const imageCodec = new NodeNotebookImageCodec();

    const page = await rasterizeNotebookPage(
      2,
      1,
      {
        pageStyle: "user_custom",
        layerSequence: ["MAINLAYER", "BGLAYER"],
        layers: {
          MAINLAYER: layer("MAINLAYER", [0x62, 0, 0x61, 0]),
          BGLAYER: {
            ...layer("BGLAYER", []),
            bitmapBuffer: backgroundBytes,
          },
        },
      },
      (bytes) => imageCodec.decodeBitmap(bytes),
    );

    expect(page.pixels).toEqual(
      Uint8ClampedArray.from([18, 18, 18, 255, 0, 0, 0, 255]),
    );
  });

  it("decodes special, continued, and final held Ratta runs", async () => {
    const cases = [
      {
        width: 0x4000,
        encoded: [0x61, 0xff],
        finalPixel: [0, 0, 0, 255],
      },
      {
        width: 129,
        encoded: [0x64, 0x80, 0x64, 0],
        finalPixel: [128, 128, 128, 255],
      },
      {
        width: 10,
        encoded: [0x65, 7, 0x61, 0x80],
        finalPixel: [0, 0, 0, 255],
      },
    ] as const;

    for (const fixture of cases) {
      const page = await rasterizeNotebookPage(
        fixture.width,
        1,
        {
          pageStyle: "style_white_a5x2",
          layerSequence: ["MAINLAYER"],
          layers: {
            MAINLAYER: layer("MAINLAYER", [...fixture.encoded]),
          },
        },
        async () => {
          throw new Error("Unexpected bitmap background");
        },
      );
      expect([...page.pixels.slice(-4)]).toEqual(fixture.finalPixel);
    }
  });

  it("preserves unknown colors as transparent white", async () => {
    const page = await rasterizeNotebookPage(
      1,
      1,
      {
        pageStyle: "style_white_a5x2",
        layerSequence: ["MAINLAYER"],
        layers: {
          MAINLAYER: layer("MAINLAYER", [0, 0]),
        },
      },
      async () => {
        throw new Error("Unexpected bitmap background");
      },
    );

    expect(page.pixels).toEqual(Uint8ClampedArray.from([255, 255, 255, 0]));
  });

  it("rejects malformed Ratta lengths", async () => {
    await expect(
      rasterizeNotebookPage(
        2,
        1,
        {
          pageStyle: "style_white_a5x2",
          layerSequence: ["MAINLAYER"],
          layers: {
            MAINLAYER: layer("MAINLAYER", [0x61, 0]),
          },
        },
        async () => {
          throw new Error("Unexpected bitmap background");
        },
      ),
    ).rejects.toThrow("decoded 1 pixels; expected 2");
  });

  it("honors the complete layer sequence from bottom to top", async () => {
    const page = await rasterizeNotebookPage(
      1,
      1,
      {
        pageStyle: "style_white_a5x2",
        layerSequence: ["MAINLAYER", "LAYER1", "LAYER2", "LAYER3", "BGLAYER"],
        layers: {
          MAINLAYER: layer("MAINLAYER", [0x62, 0]),
          LAYER1: layer("LAYER1", [0x61, 0]),
          LAYER2: layer("LAYER2", [0x64, 0]),
          LAYER3: layer("LAYER3", [0x62, 0]),
          BGLAYER: layer("BGLAYER", [0x65, 0]),
        },
      },
      async () => {
        throw new Error("Unexpected bitmap background");
      },
    );

    expect(page.pixels).toEqual(Uint8ClampedArray.from([0, 0, 0, 255]));
  });

  it.skipIf(!existsSync(fixturePath))(
    "matches the independently recorded real-note RGBA hash",
    async () => {
      const note = new SupernoteX(readFileSync(fixturePath));
      const source = note.pages[0]!;
      const page = await rasterizeNotebookPage(
        note.pageWidth,
        note.pageHeight,
        {
          pageStyle: source.PAGESTYLE,
          layerSequence: source.LAYERSEQ,
          layers: Object.fromEntries(
            source.LAYERSEQ.map((name) => [name, source[name]]),
          ),
        },
        async () => {
          throw new Error("Fixture unexpectedly uses a bitmap background");
        },
      );

      expect(page).toMatchObject({ width: 1920, height: 2560 });
      expect(createHash("sha256").update(page.pixels).digest("hex")).toBe(
        "45b910c9e98f6b2cb71f40b08f1b5818aa9aeb677a6fff052cc9e4359b752729",
      );
    },
  );
});
