import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildTextBoxRecord } from "../src/note/textbox-record-builder";
import {
  decodeTextBoxField,
  parseNativeTextBoxRecord,
  TEXTBOX_FIELD_FONT_PATH,
  TEXTBOX_FIELD_ID,
  TEXTBOX_FIELD_STYLE,
} from "../src/note/textbox-record-format";

interface CorpusFixture {
  name: string;
  role?: "regression-oracle" | "failed-blind-oracle";
  rect: [number, number, number, number];
  text: string;
  fontSize: number;
  bodyBase64: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/native-textbox-records.json", import.meta.url),
    "utf8",
  ),
) as CorpusFixture[];

const record = (name: string): Uint8Array => {
  const sample = fixture.find((candidate) => candidate.name === name);
  if (!sample) {
    throw new Error(`Missing native text-box fixture ${name}`);
  }
  return Uint8Array.from(Buffer.from(sample.bodyBase64, "base64"));
};

const buildFromTargetSemantics = (
  templateName: string,
  targetName: string,
): Uint8Array => {
  const targetFixture = fixture.find(
    (candidate) => candidate.name === targetName,
  );
  if (!targetFixture) {
    throw new Error(`Missing native text-box fixture ${targetName}`);
  }
  const targetBody = record(targetName);
  const target = parseNativeTextBoxRecord(targetBody);
  const style = decodeTextBoxField(
    target.fields[TEXTBOX_FIELD_STYLE] ?? "",
  ).split(",");

  return buildTextBoxRecord(
    record(templateName),
    {
      creationId: decodeTextBoxField(target.fields[TEXTBOX_FIELD_ID] ?? ""),
      rect: targetFixture.rect,
      text: targetFixture.text,
      fontSize: targetFixture.fontSize,
      fontPath: decodeTextBoxField(
        target.fields[TEXTBOX_FIELD_FONT_PATH] ?? "",
      ),
      numInPage: new DataView(
        target.prefix.buffer,
        target.prefix.byteOffset,
        target.prefix.byteLength,
      ).getUint32(319, true),
      textFrameWidthType: Number(style[12]) as 0 | 1,
    },
    {
      width: 1920,
      height: 2560,
    },
  ).body;
};

describe("buildTextBoxRecord", () => {
  it("reproduces EMR bytes from the remaining native geometry transitions", () => {
    for (const [source, target] of [
      ["native-0-4f6cd074", "native-2-53281a52"],
      ["native-4-8e7186ed", "native-6-bacf6968"],
    ] as const) {
      const built = buildFromTargetSemantics(source, target);
      const native = record(target);
      expect(built.slice(216, 256), `${source} -> ${target}`).toEqual(
        native.slice(216, 256),
      );
    }
  });

  it("reproduces an excluded native geometry regression oracle byte-for-byte", () => {
    expect(
      fixture.find((sample) => sample.name === "native-10-663d88f1")?.role,
    ).toBe("regression-oracle");
    const template = record("native-8-b03c32cd");
    const oracle = record("native-10-663d88f1");

    const result = buildTextBoxRecord(
      template,
      {
        creationId: "20260725113603537237",
        rect: [951, 1280, 191, 64],
        text: "testing",
        fontSize: 48,
        fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
        numInPage: 51,
        textFrameWidthType: 1,
      },
      {
        width: 1920,
        height: 2560,
      },
    );

    expect(result.body).toEqual(oracle);
    expect(result.changedRanges).toEqual([
      [104, 105],
      [120, 120],
      [216, 216],
      [224, 224],
      [232, 232],
      [240, 240],
      [248, 248],
      [319, 319],
      [390, 390],
      [398, 398],
      [406, 407],
      [414, 415],
      [422, 422],
      [535, 537],
      [542, 542],
      [556, 558],
      [563, 563],
      [603, 603],
      [767, 767],
    ]);
  });

  it("reproduces a native resize and variable-length text edit", () => {
    const result = buildTextBoxRecord(
      record("native-12-dcd21ec4"),
      {
        creationId: "20260725150604122324",
        rect: [1228, 320, 491, 59],
        text: "Codexify text box 23 k",
        fontSize: 45,
        fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
        numInPage: 55,
        textFrameWidthType: 1,
      },
      {
        width: 1920,
        height: 2560,
      },
    );

    expect(result.body).toEqual(record("native-14-b15114db"));
  });

  it("refuses unsupported page geometry", () => {
    expect(() =>
      buildTextBoxRecord(
        record("native-8-b03c32cd"),
        {
          creationId: "20260725113603537237",
          rect: [951, 1280, 191, 64],
          text: "testing",
          fontSize: 48,
          fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
          numInPage: 51,
          textFrameWidthType: 1,
        },
        {
          width: 1404,
          height: 1872,
        },
      ),
    ).toThrow(/Unsupported native text-box page size/);
  });

  it("reproduces the fresh post-freeze device move byte-for-byte", () => {
    expect(
      fixture.find((sample) => sample.name === "blind-target-3afb017a")?.role,
    ).toBe("failed-blind-oracle");

    const result = buildTextBoxRecord(
      record("blind-live-source-6110cd5f"),
      {
        creationId: "20260725183520001615",
        rect: [263, 1821, 491, 59],
        text: "Codexify text box 23 k",
        fontSize: 45,
        fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
        numInPage: 62,
        textFrameWidthType: 0,
      },
      {
        width: 1920,
        height: 2560,
      },
    );

    expect(result.body).toEqual(record("blind-target-3afb017a"));
  });

  it("reproduces the reverse-direction blind move byte-for-byte", () => {
    expect(
      fixture.find((sample) => sample.name === "blind-2-target-1b1d7166")?.role,
    ).toBe("failed-blind-oracle");

    const result = buildTextBoxRecord(
      record("blind-target-3afb017a"),
      {
        creationId: "20260725190332737210",
        rect: [1208, 201, 491, 59],
        text: "Codexify text box 23 k",
        fontSize: 45,
        fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
        numInPage: 63,
        textFrameWidthType: 0,
      },
      {
        width: 1920,
        height: 2560,
      },
    );

    expect(result.body).toEqual(record("blind-2-target-1b1d7166"));
  });

  it("refuses a superseded record as the structural template", () => {
    expect(() =>
      buildTextBoxRecord(
        record("blind-source-69642d6e"),
        {
          creationId: "20260725183520001615",
          rect: [263, 1821, 491, 59],
          text: "Codexify text box 23 k",
          fontSize: 45,
          fontPath: "/system/fonts/DroidSansFallbackFull.ttf",
          numInPage: 62,
          textFrameWidthType: 0,
        },
        {
          width: 1920,
          height: 2560,
        },
      ),
    ).toThrow(/template is not live/);
  });
});
