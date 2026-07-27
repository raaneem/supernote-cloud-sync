import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  analyzeTextBoxRecordCorpus,
  type NativeTextBoxRecordSample,
} from "../src/note/textbox-record-corpus";

interface CorpusFixture {
  name: string;
  role?: "regression-oracle" | "failed-blind-oracle";
  sha256: string;
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

const samples: NativeTextBoxRecordSample[] = fixture
  .filter((sample) => sample.role === undefined)
  .map((sample) => ({
    name: sample.name,
    rect: sample.rect,
    text: sample.text,
    fontSize: sample.fontSize,
    body: Uint8Array.from(Buffer.from(sample.bodyBase64, "base64")),
  }));

describe("analyzeTextBoxRecordCorpus", () => {
  it("classifies every fixed byte without treating same-geometry variants as geometry", () => {
    for (const sample of fixture) {
      expect(
        createHash("sha256")
          .update(Buffer.from(sample.bodyBase64, "base64"))
          .digest("hex"),
      ).toBe(sample.sha256);
    }

    const analysis = analyzeTextBoxRecordCorpus(samples);

    expect(analysis).toEqual({
      sampleCount: 15,
      prefixLength: 483,
      trailerLength: 24,
      fixedLength: 507,
      stableOffsetCount: 441,
      controlledGeometryCandidateOffsets: [
        100, 101, 104, 105, 116, 117, 120, 121, 216, 217, 220, 221, 224, 225,
        228, 229, 232, 233, 236, 237, 240, 241, 244, 245, 248, 249, 252, 253,
        315, 386, 387, 390, 391, 392, 394, 395, 398, 399, 400, 402, 403, 406,
        407, 408, 410, 411, 414, 415, 416, 418, 419, 422, 423, 424,
      ],
      sameGeometryVariantOffsets: [311, 312, 313, 314, 319],
      uncontrolledVariableOffsets: [8, 128, 466, 467, 470, 471, 479],
      geometryDependentOffsets: [
        100, 101, 104, 105, 116, 117, 120, 121, 216, 217, 220, 221, 224, 225,
        228, 229, 232, 233, 236, 237, 240, 241, 244, 245, 248, 249, 252, 253,
        386, 387, 390, 391, 392, 394, 395, 398, 399, 400, 402, 403, 406, 407,
        408, 410, 411, 414, 415, 416, 418, 419, 422, 423, 424,
      ],
      templateVariantOffsets: [8, 128, 466, 467, 470, 471],
      supersededStateOffsets: [311, 312, 313, 314],
      templatePreservedOffsets: [315],
      recordContextOffsets: [319],
      innerLengthOffsets: [479],
      unexplainedVariableOffsets: [],
    });
  });

  it("rejects semantic labels that disagree with the native record", () => {
    expect(() =>
      analyzeTextBoxRecordCorpus([
        samples[0]!,
        {
          ...samples[1]!,
          text: "incorrect fixture label",
        },
      ]),
    ).toThrow(/semantic metadata/);
  });

  it("rejects a uniformly incompatible fixed layout", () => {
    const shifted = samples.slice(0, 2).map((sample) => {
      const body = new Uint8Array(sample.body.byteLength + 1);
      body.set(sample.body, 1);
      return { ...sample, body };
    });

    expect(() => analyzeTextBoxRecordCorpus(shifted)).toThrow(
      /disagrees with inner length/,
    );
  });
});
