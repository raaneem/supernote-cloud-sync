import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { decodeEmbeddedFont } from "../src/export/font-codec";
import { pdfFontBytes } from "./pdf-font-fixture";

describe("embedded PDF fonts", () => {
  it("decode byte-identically on first use", () => {
    const compressed = gzipSync(pdfFontBytes, { level: 9 });

    expect(decodeEmbeddedFont(compressed)).toEqual(pdfFontBytes);
  }, 20_000);
});
