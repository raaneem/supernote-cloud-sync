export const TEXTBOX_RECORD_PREFIX_LENGTH = 483;
export const TEXTBOX_RECORD_TRAILER_LENGTH = 24;
export const TEXTBOX_INNER_LENGTH_OFFSET = 479;
export const TEXTBOX_FIELD_COUNT = 20;

export const TEXTBOX_FIELD_ID = 3;
export const TEXTBOX_FIELD_RECT = 4;
export const TEXTBOX_FIELD_SECONDARY_RECT = 5;
export const TEXTBOX_FIELD_FONT_SIZE = 10;
export const TEXTBOX_FIELD_FONT_PATH = 11;
export const TEXTBOX_FIELD_TEXT = 12;
export const TEXTBOX_FIELD_STYLE = 13;
export const TEXTBOX_FIELD_LINE_HEIGHT = 14;

export type NativeTextBoxRect = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
];

export interface ParsedNativeTextBoxRecord {
  prefix: Uint8Array;
  fields: string[];
  trailer: Uint8Array;
}

const asciiDecoder = new TextDecoder("windows-1252", { fatal: true });
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

const readUint32 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw new Error(`Cannot read uint32 at text-box body offset ${offset}`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    true,
  );
};

export const decodeTextBoxField = (encoded: string): string => {
  try {
    const binary = atob(encoded);
    return utf8Decoder.decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new Error("Text-box record contains an invalid base64 field");
  }
};

export const encodeTextBoxField = (value: string): string => {
  const bytes = utf8Encoder.encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export const parseNativeTextBoxRecord = (
  body: Uint8Array,
): ParsedNativeTextBoxRecord => {
  if (
    body.byteLength <
    TEXTBOX_RECORD_PREFIX_LENGTH + TEXTBOX_RECORD_TRAILER_LENGTH
  ) {
    throw new Error("Native text-box record is shorter than its fixed layout");
  }

  const innerLength = readUint32(body, TEXTBOX_INNER_LENGTH_OFFSET);
  const expectedLength =
    TEXTBOX_RECORD_PREFIX_LENGTH + innerLength + TEXTBOX_RECORD_TRAILER_LENGTH;
  if (body.byteLength !== expectedLength) {
    throw new Error(
      `Native text-box record length ${body.byteLength} disagrees with inner length ${innerLength}`,
    );
  }

  const innerEnd = TEXTBOX_RECORD_PREFIX_LENGTH + innerLength;
  const fields = asciiDecoder
    .decode(body.subarray(TEXTBOX_RECORD_PREFIX_LENGTH, innerEnd))
    .split(",");
  if (fields.length !== TEXTBOX_FIELD_COUNT || fields.at(-1) !== "") {
    throw new Error(
      `Native text-box record has unsupported ${fields.length}-field CSV layout`,
    );
  }

  return {
    prefix: body.slice(0, TEXTBOX_RECORD_PREFIX_LENGTH),
    fields,
    trailer: body.slice(innerEnd),
  };
};
