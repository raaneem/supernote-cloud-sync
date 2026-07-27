import {
  PDFDocument,
  type PDFImage,
  TextRenderingMode,
  setTextRenderingMode,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export interface PdfExportPage {
  pageNumber: number;
  png: Uint8Array;
  width: number;
  height: number;
  pageText: string | null;
  positionedText: readonly {
    text: string;
    rect: readonly [number, number, number, number];
  }[];
}

export interface PdfExporter {
  export(
    pages: AsyncIterable<PdfExportPage> | Iterable<PdfExportPage>,
  ): Promise<Uint8Array>;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const placeholderPng = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  218, 99, 252, 207, 192, 80, 15, 0, 5, 131, 2, 127, 151, 196, 180, 89, 0, 0, 0,
  0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

interface DirectPng {
  compressed: Uint8Array;
  height: number;
  width: number;
}

const directRgbPng = (png: Uint8Array): DirectPng | null => {
  // This deliberately narrow parser accepts only the non-interlaced, 8-bit
  // direct-RGB PNG contract produced by encodeOpaqueNotebookPng. It is not a
  // general parser for user-supplied PNGs.
  if (
    png.byteLength < pngSignature.length ||
    pngSignature.some((byte, index) => png[index] !== byte)
  ) {
    return null;
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idatChunks: Uint8Array[] = [];
  let height = 0;
  let width = 0;
  let offset: number = pngSignature.length;
  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (next > png.byteLength) {
      return null;
    }
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    );
    if (type === "IHDR") {
      if (
        length !== 13 ||
        png[dataStart + 8] !== 8 ||
        png[dataStart + 9] !== 2 ||
        png[dataStart + 10] !== 0 ||
        png[dataStart + 11] !== 0 ||
        png[dataStart + 12] !== 0
      ) {
        return null;
      }
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
    } else if (type === "IDAT") {
      idatChunks.push(png.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = next;
  }
  if (width <= 0 || height <= 0 || idatChunks.length === 0) {
    return null;
  }
  const compressedBytes = idatChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const compressed = new Uint8Array(compressedBytes);
  let destination = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, destination);
    destination += chunk.byteLength;
  }
  return { compressed, height, width };
};

const embedDirectRgbPng = async (
  pdf: PDFDocument,
  png: Uint8Array,
): Promise<PDFImage | null> => {
  const direct = directRgbPng(png);
  if (!direct) {
    return null;
  }
  const image = await pdf.embedPng(placeholderPng);
  await image.embed();
  pdf.context.assign(
    image.ref,
    pdf.context.stream(direct.compressed, {
      Type: "XObject",
      Subtype: "Image",
      BitsPerComponent: 8,
      Width: direct.width,
      Height: direct.height,
      ColorSpace: "DeviceRGB",
      Filter: "FlateDecode",
      DecodeParms: {
        Predictor: 15,
        Colors: 3,
        BitsPerComponent: 8,
        Columns: direct.width,
      },
    }),
  );
  return image;
};

export class PdfLibExporter implements PdfExporter {
  constructor(private readonly fontBytes: Uint8Array) {}

  async export(
    pages: AsyncIterable<PdfExportPage> | Iterable<PdfExportPage>,
  ): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(this.fontBytes, { subset: true });
    await yieldToEventLoop();
    let pageCount = 0;
    for await (const input of pages) {
      pageCount += 1;
      const directImage = await embedDirectRgbPng(pdf, input.png);
      const image = directImage ?? (await pdf.embedPng(input.png));
      if (!directImage) {
        await yieldToEventLoop();
      }
      const page = pdf.addPage([input.width, input.height]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: input.width,
        height: input.height,
      });
      if (input.positionedText.length > 0 || input.pageText?.trim()) {
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
        for (const span of input.positionedText) {
          const [x, y, width, height] = span.rect;
          if (
            !span.text.trim() ||
            x < 0 ||
            y < 0 ||
            width <= 0 ||
            height <= 0 ||
            x + width > input.width ||
            y + height > input.height
          ) {
            continue;
          }
          const heightSize = Math.max(1, height * 0.8);
          const naturalWidth = font.widthOfTextAtSize(span.text, heightSize);
          const size =
            naturalWidth > width
              ? Math.max(1, heightSize * (width / naturalWidth))
              : heightSize;
          page.drawText(span.text, {
            x,
            y: input.height - y - height,
            size,
            font,
          });
        }
        input.pageText?.split(/\r?\n/).forEach((line, index) => {
          if (!line) {
            return;
          }
          page.drawText(line, {
            x: 24,
            y: input.height - 36 - index * 18,
            size: 12,
            font,
          });
        });
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
      }
      if (!directImage) {
        await image.embed();
      }
      await yieldToEventLoop();
    }
    if (pageCount === 0) {
      throw new Error("Select at least one page for PDF export");
    }
    return pdf.save();
  }
}
