import {
  decodeTextBoxField,
  parseNativeTextBoxRecord,
  TEXTBOX_FIELD_FONT_SIZE,
  TEXTBOX_FIELD_ID,
  TEXTBOX_FIELD_RECT,
  TEXTBOX_FIELD_TEXT,
  TEXTBOX_RECORD_PREFIX_LENGTH,
  TEXTBOX_RECORD_TRAILER_LENGTH,
  type NativeTextBoxRect,
} from "./textbox-record-format";

export type { NativeTextBoxRect } from "./textbox-record-format";

export interface NativeTextBoxRecordSample {
  name: string;
  rect: NativeTextBoxRect;
  text: string;
  fontSize: number;
  body: Uint8Array;
}

export interface TextBoxRecordCorpusAnalysis {
  sampleCount: number;
  prefixLength: number;
  trailerLength: number;
  fixedLength: number;
  stableOffsetCount: number;
  controlledGeometryCandidateOffsets: readonly number[];
  sameGeometryVariantOffsets: readonly number[];
  uncontrolledVariableOffsets: readonly number[];
  geometryDependentOffsets: readonly number[];
  templateVariantOffsets: readonly number[];
  supersededStateOffsets: readonly number[];
  templatePreservedOffsets: readonly number[];
  recordContextOffsets: readonly number[];
  innerLengthOffsets: readonly number[];
  unexplainedVariableOffsets: readonly number[];
}

interface SplitRecord {
  prefix: Uint8Array;
  trailer: Uint8Array;
}

const rectKey = (rect: NativeTextBoxRect): string => rect.join(",");

const offsetsInRanges = (
  offsets: readonly number[],
  ranges: readonly (readonly [number, number])[],
): number[] =>
  offsets.filter((offset) =>
    ranges.some(([start, end]) => offset >= start && offset < end),
  );

const GEOMETRY_RANGES = [
  [100, 108],
  [116, 124],
  [216, 256],
  [385, 425],
] as const;
const TEMPLATE_VARIANT_OFFSETS = [8, 128, 466, 467, 470, 471] as const;
const SUPERSEDED_STATE_OFFSETS = [311, 312, 313, 314] as const;
const TEMPLATE_PRESERVED_OFFSETS = [315] as const;
const RECORD_CONTEXT_OFFSETS = [319] as const;
const INNER_LENGTH_OFFSETS = [479] as const;

const splitRecord = (sample: NativeTextBoxRecordSample): SplitRecord => {
  const record = parseNativeTextBoxRecord(sample.body);
  const fields = record.fields;
  const id = decodeTextBoxField(fields[TEXTBOX_FIELD_ID] ?? "");
  const decodedFontSize = Number(
    decodeTextBoxField(fields[TEXTBOX_FIELD_FONT_SIZE] ?? ""),
  );
  if (
    !/^\d{20}$/.test(id) ||
    decodeTextBoxField(fields[TEXTBOX_FIELD_RECT] ?? "") !==
      rectKey(sample.rect) ||
    decodeTextBoxField(fields[TEXTBOX_FIELD_TEXT] ?? "") !== sample.text ||
    decodedFontSize !== sample.fontSize
  ) {
    throw new Error(
      `Native text-box record ${sample.name} disagrees with its semantic metadata`,
    );
  }
  return {
    prefix: record.prefix,
    trailer: record.trailer,
  };
};

const fixedByte = (record: SplitRecord, offset: number): number => {
  if (offset < record.prefix.byteLength) {
    return record.prefix[offset]!;
  }
  return record.trailer[offset - record.prefix.byteLength]!;
};

export const analyzeTextBoxRecordCorpus = (
  samples: readonly NativeTextBoxRecordSample[],
): TextBoxRecordCorpusAnalysis => {
  if (samples.length < 2) {
    throw new Error("At least two native text-box records are required");
  }

  const records = samples.map(splitRecord);
  const prefixLength = records[0]!.prefix.byteLength;
  const trailerLength = records[0]!.trailer.byteLength;
  if (
    prefixLength !== TEXTBOX_RECORD_PREFIX_LENGTH ||
    trailerLength !== TEXTBOX_RECORD_TRAILER_LENGTH
  ) {
    throw new Error(
      `Native text-box corpus has unsupported fixed layout ${prefixLength}/${trailerLength}`,
    );
  }
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (
      record.prefix.byteLength !== prefixLength ||
      record.trailer.byteLength !== trailerLength
    ) {
      throw new Error(
        `Native text-box record ${samples[index]!.name} has an incompatible fixed layout`,
      );
    }
  }

  const fixedLength = prefixLength + trailerLength;
  const controlledGeometryCandidateOffsets: number[] = [];
  const sameGeometryVariantOffsets: number[] = [];
  const uncontrolledVariableOffsets: number[] = [];
  let stableOffsetCount = 0;

  for (let offset = 0; offset < fixedLength; offset += 1) {
    const values = new Set(records.map((record) => fixedByte(record, offset)));
    if (values.size === 1) {
      stableOffsetCount += 1;
      continue;
    }

    let variesAtSameGeometry = false;
    let variesInControlledGeometryPair = false;
    for (let left = 0; left < records.length; left += 1) {
      for (let right = left + 1; right < records.length; right += 1) {
        if (
          fixedByte(records[left]!, offset) ===
          fixedByte(records[right]!, offset)
        ) {
          continue;
        }
        const leftSample = samples[left]!;
        const rightSample = samples[right]!;
        if (rectKey(leftSample.rect) === rectKey(rightSample.rect)) {
          variesAtSameGeometry = true;
        }
        if (
          leftSample.text === rightSample.text &&
          leftSample.fontSize === rightSample.fontSize &&
          rectKey(leftSample.rect) !== rectKey(rightSample.rect)
        ) {
          variesInControlledGeometryPair = true;
        }
      }
    }

    if (variesAtSameGeometry) {
      sameGeometryVariantOffsets.push(offset);
    } else if (variesInControlledGeometryPair) {
      controlledGeometryCandidateOffsets.push(offset);
    } else {
      uncontrolledVariableOffsets.push(offset);
    }
  }

  const allVariableOffsets = [
    ...controlledGeometryCandidateOffsets,
    ...sameGeometryVariantOffsets,
    ...uncontrolledVariableOffsets,
  ].sort((left, right) => left - right);
  const geometryDependentOffsets = offsetsInRanges(
    allVariableOffsets,
    GEOMETRY_RANGES,
  );
  const explainedOffsets = new Set([
    ...geometryDependentOffsets,
    ...TEMPLATE_VARIANT_OFFSETS,
    ...SUPERSEDED_STATE_OFFSETS,
    ...TEMPLATE_PRESERVED_OFFSETS,
    ...RECORD_CONTEXT_OFFSETS,
    ...INNER_LENGTH_OFFSETS,
  ]);
  const unexplainedVariableOffsets = allVariableOffsets.filter(
    (offset) => !explainedOffsets.has(offset),
  );

  return {
    sampleCount: samples.length,
    prefixLength,
    trailerLength,
    fixedLength,
    stableOffsetCount,
    controlledGeometryCandidateOffsets,
    sameGeometryVariantOffsets,
    uncontrolledVariableOffsets,
    geometryDependentOffsets,
    templateVariantOffsets: TEMPLATE_VARIANT_OFFSETS,
    supersededStateOffsets: SUPERSEDED_STATE_OFFSETS,
    templatePreservedOffsets: TEMPLATE_PRESERVED_OFFSETS,
    recordContextOffsets: RECORD_CONTEXT_OFFSETS,
    innerLengthOffsets: INNER_LENGTH_OFFSETS,
    unexplainedVariableOffsets,
  };
};
