import { describe, expect, it } from "vitest";

import { extractTextBoxes } from "../src/note/textboxes";

const encodeField = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64");

const textboxRecord = (id: string, rect: string, text: string): string => {
  const fields = [
    "0",
    "0",
    "0",
    id,
    rect,
    rect,
    "none",
    "none",
    "none",
    "0",
    "48.000000",
    "/system/fonts/DroidSansFallbackFull.ttf",
    text,
    "0,0,0,0.000000,255,255,0,",
    "63",
    "1",
    "1",
    "0",
    "none",
    "",
  ];
  return fields.map(encodeField).join(",");
};

const block = (content: string): Buffer => {
  const body = Buffer.from(content, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
};

const noteFixture = (): Uint8Array => {
  const prefix = Buffer.from("note");
  const totalPath = block(
    [
      textboxRecord("20260723230536099858", "1228,320,462,64", "Live box"),
      textboxRecord("20260723230536099859", "10,20,300,64", "Deleted box"),
    ].join("|"),
  );
  const totalPathAddress = prefix.length;
  const page = block(
    `<PAGETEXTBOX:1><DISABLE:1228,320,462,64|><TOTALPATH:${totalPathAddress}>`,
  );
  const pageAddress = prefix.length + totalPath.length;
  const footer = block(`<PAGE1:${pageAddress}>`);
  const footerAddress = pageAddress + page.length;
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(footerAddress);
  return Buffer.concat([prefix, totalPath, page, footer, trailer]);
};

describe("extractTextBoxes", () => {
  it("returns only live records listed in DISABLE", () => {
    expect(extractTextBoxes(noteFixture())).toEqual([
      {
        pageNumber: 1,
        text: "Live box",
        rect: [1228, 320, 462, 64],
        fontSize: 48,
        fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
        id: "20260723230536099858",
      },
    ]);
  });

  it("returns no boxes for invalid note bytes", () => {
    expect(extractTextBoxes(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});
