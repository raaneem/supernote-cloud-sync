export interface TextBox {
  pageNumber: number;
  text: string;
  rect: readonly [number, number, number, number];
  fontSize: number;
  fontPath: string;
  id: string;
}

const TAG_PATTERN = /<([A-Z_0-9]+):([^<>]*)>/g;
const BASE64_CSV_PATTERN = /[A-Za-z0-9+/=]+(?:,[A-Za-z0-9+/=]*){15,}/g;

const FIELD_ID = 3;
const FIELD_RECT = 4;
const FIELD_FONT_SIZE = 10;
const FIELD_FONT_PATH = 11;
const FIELD_TEXT = 12;
const MIN_FIELDS = 13;

const asciiDecoder = new TextDecoder("windows-1252");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const readUint32 = (bytes: Uint8Array, offset: number): number | null => {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    return null;
  }

  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    true,
  );
};

const readBlock = (bytes: Uint8Array, address: number): Uint8Array => {
  const length = readUint32(bytes, address);
  if (address <= 0 || length === null) {
    return new Uint8Array();
  }

  const start = address + 4;
  const end = start + length;
  return end <= bytes.byteLength
    ? bytes.subarray(start, end)
    : new Uint8Array();
};

const tags = (block: Uint8Array): Map<string, string> => {
  const result = new Map<string, string>();
  const content = asciiDecoder.decode(block);

  for (const match of content.matchAll(TAG_PATTERN)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      result.set(name, value);
    }
  }

  return result;
};

const decodeField = (fields: readonly string[], index: number): string => {
  const encoded = fields[index];
  if (
    encoded === undefined ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return "";
  }

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return utf8Decoder.decode(bytes);
  } catch {
    return "";
  }
};

const parseRect = (
  value: string,
): readonly [number, number, number, number] => {
  const parts = value.split(",");
  if (parts.length !== 4) {
    return [0, 0, 0, 0];
  }

  const values = parts.map((part) => Math.trunc(Number(part)));
  if (values.some((value) => !Number.isFinite(value))) {
    return [0, 0, 0, 0];
  }

  return [values[0]!, values[1]!, values[2]!, values[3]!];
};

const rectKey = (rect: readonly [number, number, number, number]): string =>
  rect.join(",");

const parseLiveRects = (disable: string): Set<string> => {
  const result = new Set<string>();
  for (const value of disable.split("|")) {
    if (value.split(",").length === 4) {
      result.add(rectKey(parseRect(value)));
    }
  }
  return result;
};

const boxesInTotalPath = (
  totalPath: Uint8Array,
  pageNumber: number,
  liveRects: ReadonlySet<string>,
): TextBox[] => {
  const boxes: TextBox[] = [];
  const content = asciiDecoder.decode(totalPath);

  for (const match of content.matchAll(BASE64_CSV_PATTERN)) {
    const fields = match[0].split(",");
    if (fields.length < MIN_FIELDS) {
      continue;
    }

    const text = decodeField(fields, FIELD_TEXT);
    const id = decodeField(fields, FIELD_ID);
    if (!text || !/^\d+$/.test(id)) {
      continue;
    }

    const rect = parseRect(decodeField(fields, FIELD_RECT));
    if (liveRects.size > 0 && !liveRects.has(rectKey(rect))) {
      continue;
    }

    const parsedFontSize = Number(decodeField(fields, FIELD_FONT_SIZE));
    boxes.push({
      pageNumber,
      text,
      rect,
      fontSize: Number.isFinite(parsedFontSize) ? parsedFontSize : 0,
      fontPath: decodeField(fields, FIELD_FONT_PATH),
      id,
    });
  }

  return boxes;
};

export const extractTextBoxes = (bytes: Uint8Array): TextBox[] => {
  if (
    bytes.byteLength < 8 ||
    asciiDecoder.decode(bytes.subarray(0, 4)) !== "note"
  ) {
    return [];
  }

  const footerAddress = readUint32(bytes, bytes.byteLength - 4);
  if (footerAddress === null) {
    return [];
  }

  const footer = tags(readBlock(bytes, footerAddress));
  const boxes: TextBox[] = [];

  for (const [name, pageAddressValue] of footer) {
    const pageMatch = /^PAGE(\d+)$/.exec(name);
    if (!pageMatch) {
      continue;
    }

    const pageNumber = Number(pageMatch[1]);
    const pageAddress = Number(pageAddressValue);
    if (!Number.isInteger(pageNumber) || !Number.isInteger(pageAddress)) {
      continue;
    }

    const page = tags(readBlock(bytes, pageAddress));
    if (page.get("PAGETEXTBOX") !== "1") {
      continue;
    }

    const totalPathAddress = Number(page.get("TOTALPATH") ?? "0");
    const liveRects = parseLiveRects(page.get("DISABLE") ?? "");
    boxes.push(
      ...boxesInTotalPath(
        readBlock(bytes, totalPathAddress),
        pageNumber,
        liveRects,
      ),
    );
  }

  boxes.sort(
    (left, right) =>
      left.pageNumber - right.pageNumber ||
      left.rect[1] - right.rect[1] ||
      left.rect[0] - right.rect[0],
  );
  return boxes;
};
