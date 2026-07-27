import {
  decodeTextBoxField,
  encodeTextBoxField,
  parseNativeTextBoxRecord,
  type NativeTextBoxRect,
  TEXTBOX_FIELD_FONT_PATH,
  TEXTBOX_FIELD_FONT_SIZE,
  TEXTBOX_FIELD_ID,
  TEXTBOX_FIELD_LINE_HEIGHT,
  TEXTBOX_FIELD_RECT,
  TEXTBOX_FIELD_SECONDARY_RECT,
  TEXTBOX_FIELD_STYLE,
  TEXTBOX_FIELD_TEXT,
  TEXTBOX_INNER_LENGTH_OFFSET,
} from "./textbox-record-format";

export interface NativePageSize {
  width: number;
  height: number;
}

export interface NativeTextBoxDraft {
  creationId: string;
  rect: NativeTextBoxRect;
  text: string;
  fontSize: number;
  fontPath: string;
  numInPage: number;
  textFrameWidthType: 0 | 1;
}

export interface TextBoxRecordBuildResult {
  body: Uint8Array;
  changedRanges: readonly (readonly [start: number, end: number])[];
}

const A5X2_PAGE_SIZE: NativePageSize = { width: 1920, height: 2560 };
const EMR_MAX_X = 21632;
const EMR_MAX_Y = 16224;
const OUTER_BOUND_PADDING = 228;

const OUTER_LEFT_OFFSET = 100;
const OUTER_TOP_OFFSET = 104;
const OUTER_RIGHT_OFFSET = 116;
const OUTER_BOTTOM_OFFSET = 120;
const EMR_CONTOUR_OFFSET = 216;
const NUM_IN_PAGE_OFFSET = 319;
const FLOAT_CONTOUR_OFFSET = 385;
const SUPERSEDED_STATE_OFFSET = 311;
const TEXT_FRAME_WIDTH_TYPE_INDEX = 12;
const TEXT_STYLE_VALUE_COUNT = 18;

interface Point {
  x: number;
  y: number;
}

const writeUint32 = (
  bytes: Uint8Array,
  offset: number,
  value: number,
): void => {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
    true,
  );
};

const writeFloat32 = (
  bytes: Uint8Array,
  offset: number,
  value: number,
): void => {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(
    offset,
    value,
    true,
  );
};

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );

const readFloat32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(
    offset,
    true,
  );

const assertInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
};

const validateInputs = (
  draft: NativeTextBoxDraft,
  pageSize: NativePageSize,
): void => {
  if (
    pageSize.width !== A5X2_PAGE_SIZE.width ||
    pageSize.height !== A5X2_PAGE_SIZE.height
  ) {
    throw new Error(
      `Unsupported native text-box page size ${pageSize.width}x${pageSize.height}`,
    );
  }
  if (!/^\d{20}$/.test(draft.creationId)) {
    throw new Error("Text-box creation id must contain exactly 20 digits");
  }
  if (!draft.text) {
    throw new Error("Text-box content cannot be empty");
  }
  if (!draft.fontPath) {
    throw new Error("Text-box font path cannot be empty");
  }
  if (!Number.isFinite(draft.fontSize) || draft.fontSize <= 0) {
    throw new Error("Text-box font size must be positive");
  }
  assertInteger(draft.fontSize, "Text-box font size");
  assertInteger(draft.numInPage, "Text-box numInPage");
  if (draft.numInPage < 0) {
    throw new Error("Text-box numInPage cannot be negative");
  }
  if (draft.textFrameWidthType !== 0 && draft.textFrameWidthType !== 1) {
    throw new Error("Text-box frame width type must be 0 or 1");
  }

  const [x, y, width, height] = draft.rect;
  for (const [value, name] of [
    [x, "x"],
    [y, "y"],
    [width, "width"],
    [height, "height"],
  ] as const) {
    assertInteger(value, `Text-box rect ${name}`);
  }
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > pageSize.width ||
    y + height > pageSize.height
  ) {
    throw new Error("Text-box rect must have positive area within the page");
  }
};

const contourFor = (rect: NativeTextBoxRect): Point[] => {
  const [x, y, width, height] = rect;
  const right = x + width - 1;
  const bottom = y + height - 1;
  return [
    { x, y: bottom },
    { x: right, y: bottom },
    { x: right, y },
    { x, y },
    { x, y: bottom },
  ];
};

const translateEmrPoint = (
  source: Point,
  sourceEmr: Point,
  target: Point,
  pageSize: NativePageSize,
  sourceTextFrameWidthType: 0 | 1,
): Point => ({
  // Native edits transform the template's quantized EMR contour instead of
  // recomputing absolute EMR points. Preserving that path-dependent rounding
  // is required to reproduce a later device save byte-for-byte.
  x:
    sourceEmr.x +
    Math.round((target.y - source.y) * (EMR_MAX_X / (pageSize.height - 1))),
  y:
    sourceEmr.y +
    (sourceTextFrameWidthType === 0 ? Math.floor : Math.ceil)(
      (source.x - target.x) * (EMR_MAX_Y / (pageSize.width - 1)),
    ),
});

const changedRanges = (
  before: Uint8Array,
  after: Uint8Array,
): readonly (readonly [number, number])[] => {
  const ranges: Array<[number, number]> = [];
  const length = Math.max(before.byteLength, after.byteLength);
  for (let offset = 0; offset < length; offset += 1) {
    if (before[offset] === after[offset]) {
      continue;
    }
    const previous = ranges.at(-1);
    if (previous && previous[1] + 1 === offset) {
      previous[1] = offset;
    } else {
      ranges.push([offset, offset]);
    }
  }
  return ranges;
};

export const buildTextBoxRecord = (
  templateBody: Uint8Array,
  draft: NativeTextBoxDraft,
  pageSize: NativePageSize,
): TextBoxRecordBuildResult => {
  validateInputs(draft, pageSize);
  const template = parseNativeTextBoxRecord(templateBody);
  const fields = [...template.fields];
  const templateView = new DataView(
    template.prefix.buffer,
    template.prefix.byteOffset,
    template.prefix.byteLength,
  );
  const serializedEmrMaxX = templateView.getUint32(128, true);
  const serializedEmrMaxY = templateView.getUint32(132, true);
  const supersededState = templateView.getInt32(SUPERSEDED_STATE_OFFSET, true);
  if (
    (serializedEmrMaxX !== EMR_MAX_X && serializedEmrMaxX !== EMR_MAX_X - 1) ||
    serializedEmrMaxY !== EMR_MAX_Y
  ) {
    throw new Error(
      `Unsupported native text-box EMR bounds ${serializedEmrMaxX}x${serializedEmrMaxY}`,
    );
  }
  if (supersededState !== 0) {
    throw new Error(
      `Native text-box template is not live (state ${supersededState})`,
    );
  }

  const style = decodeTextBoxField(fields[TEXTBOX_FIELD_STYLE] ?? "").split(
    ",",
  );
  if (style.length !== TEXT_STYLE_VALUE_COUNT + 1 || style.at(-1) !== "") {
    throw new Error("Native text-box template has no style vector");
  }
  const sourceTextFrameWidthType = Number(style[TEXT_FRAME_WIDTH_TYPE_INDEX]);
  if (sourceTextFrameWidthType !== 0 && sourceTextFrameWidthType !== 1) {
    throw new Error(
      "Native text-box template has unsupported frame width type",
    );
  }
  style[TEXT_FRAME_WIDTH_TYPE_INDEX] = String(draft.textFrameWidthType);

  const rect = draft.rect.join(",");
  fields[TEXTBOX_FIELD_ID] = encodeTextBoxField(draft.creationId);
  fields[TEXTBOX_FIELD_RECT] = encodeTextBoxField(rect);
  fields[TEXTBOX_FIELD_SECONDARY_RECT] = encodeTextBoxField(rect);
  fields[TEXTBOX_FIELD_FONT_SIZE] = encodeTextBoxField(
    draft.fontSize.toFixed(6),
  );
  fields[TEXTBOX_FIELD_FONT_PATH] = encodeTextBoxField(draft.fontPath);
  fields[TEXTBOX_FIELD_TEXT] = encodeTextBoxField(draft.text);
  fields[TEXTBOX_FIELD_STYLE] = encodeTextBoxField(style.join(","));
  fields[TEXTBOX_FIELD_LINE_HEIGHT] = encodeTextBoxField(
    String(Math.floor((draft.fontSize * 4) / 3) - 1),
  );

  const prefix = template.prefix.slice();
  const [x, y, width, height] = draft.rect;
  const contour = contourFor(draft.rect);
  writeUint32(prefix, OUTER_LEFT_OFFSET, x);
  writeUint32(prefix, OUTER_TOP_OFFSET, y);
  writeUint32(prefix, OUTER_RIGHT_OFFSET, x + width - 1 + OUTER_BOUND_PADDING);
  writeUint32(
    prefix,
    OUTER_BOTTOM_OFFSET,
    y + height - 1 + OUTER_BOUND_PADDING,
  );
  writeUint32(prefix, NUM_IN_PAGE_OFFSET, draft.numInPage);

  contour.forEach((point, index) => {
    const sourcePoint = {
      x: readFloat32(template.prefix, FLOAT_CONTOUR_OFFSET + index * 8),
      y: readFloat32(template.prefix, FLOAT_CONTOUR_OFFSET + index * 8 + 4),
    };
    const sourceEmr = {
      x: readUint32(template.prefix, EMR_CONTOUR_OFFSET + index * 8),
      y: readUint32(template.prefix, EMR_CONTOUR_OFFSET + index * 8 + 4),
    };
    const emr = translateEmrPoint(
      sourcePoint,
      sourceEmr,
      point,
      pageSize,
      sourceTextFrameWidthType,
    );
    if (emr.x < 0 || emr.x > EMR_MAX_X || emr.y < 0 || emr.y > EMR_MAX_Y) {
      throw new Error("Native text-box EMR contour falls outside the page");
    }
    writeUint32(prefix, EMR_CONTOUR_OFFSET + index * 8, emr.x);
    writeUint32(prefix, EMR_CONTOUR_OFFSET + index * 8 + 4, emr.y);
    writeFloat32(prefix, FLOAT_CONTOUR_OFFSET + index * 8, point.x);
    writeFloat32(prefix, FLOAT_CONTOUR_OFFSET + index * 8 + 4, point.y);
  });

  const inner = new TextEncoder().encode(fields.join(","));
  writeUint32(prefix, TEXTBOX_INNER_LENGTH_OFFSET, inner.byteLength);
  const body = new Uint8Array(
    prefix.byteLength + inner.byteLength + template.trailer.byteLength,
  );
  body.set(prefix, 0);
  body.set(inner, prefix.byteLength);
  body.set(template.trailer, prefix.byteLength + inner.byteLength);

  return {
    body,
    changedRanges: changedRanges(templateBody, body),
  };
};
