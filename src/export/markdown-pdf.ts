import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { Lexer, type Token, type Tokens } from "marked";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PAGE_MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

interface InlineRun {
  text: string;
  bold: boolean;
}

interface TextBlock {
  type: "text";
  runs: InlineRun[];
  size: number;
  indent: number;
  spaceBefore: number;
  spaceAfter: number;
}

interface RuleBlock {
  type: "rule";
  spaceBefore: number;
  spaceAfter: number;
}

type PdfBlock = TextBlock | RuleBlock;

interface WrappedLine {
  runs: InlineRun[];
  width: number;
}

const stripFrontmatter = (markdown: string): string =>
  markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

const mergeRuns = (runs: InlineRun[]): InlineRun[] => {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) {
      continue;
    }
    const previous = merged.at(-1);
    if (previous?.bold === run.bold) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
};

const inlineRuns = (
  tokens: readonly Token[] | undefined,
  bold = false,
): InlineRun[] => {
  if (!tokens) {
    return [];
  }
  const runs: InlineRun[] = [];
  for (const token of tokens) {
    if (token.type === "br") {
      runs.push({ text: "\n", bold });
    } else if (token.type === "strong") {
      runs.push(...inlineRuns(token.tokens, true));
    } else if (
      token.type === "em" ||
      token.type === "del" ||
      token.type === "link"
    ) {
      runs.push(...inlineRuns(token.tokens, bold));
    } else if (token.type === "image") {
      runs.push({
        text: token.text || token.title || token.href,
        bold,
      });
    } else if (token.type === "checkbox") {
      runs.push({ text: token.checked ? "[x] " : "[ ] ", bold });
    } else if ("tokens" in token && token.tokens) {
      runs.push(...inlineRuns(token.tokens, bold));
    } else if ("text" in token && typeof token.text === "string") {
      runs.push({
        text:
          token.type === "html"
            ? token.text.replace(/<[^>]+>/g, "")
            : token.text,
        bold,
      });
    }
  }
  return mergeRuns(runs);
};

const textBlock = (
  runs: InlineRun[],
  options: Partial<
    Pick<TextBlock, "size" | "indent" | "spaceBefore" | "spaceAfter">
  > = {},
): TextBlock => ({
  type: "text",
  runs,
  size: options.size ?? 11,
  indent: options.indent ?? 0,
  spaceBefore: options.spaceBefore ?? 0,
  spaceAfter: options.spaceAfter ?? 8,
});

const blocksFromTokens = (tokens: readonly Token[], indent = 0): PdfBlock[] => {
  const blocks: PdfBlock[] = [];
  for (const token of tokens) {
    if (token.type === "space" || token.type === "def") {
      continue;
    }
    if (token.type === "heading") {
      const sizes = [24, 20, 17, 15, 13, 12];
      blocks.push(
        textBlock(
          inlineRuns(token.tokens).map((run) => ({
            ...run,
            bold: true,
          })),
          {
            size: sizes[token.depth - 1] ?? 12,
            indent,
            spaceBefore: token.depth === 1 ? 2 : 6,
            spaceAfter: token.depth <= 2 ? 10 : 6,
          },
        ),
      );
    } else if (token.type === "paragraph" || token.type === "text") {
      blocks.push(
        textBlock(inlineRuns(token.tokens), {
          indent,
          spaceAfter: 9,
        }),
      );
    } else if (token.type === "code") {
      blocks.push(
        textBlock([{ text: token.text, bold: false }], {
          size: 9,
          indent: indent + 12,
          spaceBefore: 3,
          spaceAfter: 10,
        }),
      );
    } else if (token.type === "blockquote") {
      const quoteBlocks = blocksFromTokens(token.tokens ?? [], indent + 10);
      for (const quoteBlock of quoteBlocks) {
        if (quoteBlock.type === "text") {
          quoteBlock.runs = [{ text: "| ", bold: true }, ...quoteBlock.runs];
        }
      }
      blocks.push(...quoteBlocks);
    } else if (token.type === "list") {
      const list = token as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      list.items.forEach((item: Tokens.ListItem, index: number) => {
        const marker = list.ordered ? `${start + index}. ` : "• ";
        const itemBlocks = blocksFromTokens(
          item.tokens.filter((itemToken) => itemToken.type !== "checkbox"),
          indent + 14,
        );
        const firstText = itemBlocks.find(
          (itemBlock): itemBlock is TextBlock => itemBlock.type === "text",
        );
        const taskMarker = item.task
          ? item.checked
            ? "[x] "
            : "[ ] "
          : marker;
        if (firstText) {
          firstText.runs = [
            { text: taskMarker, bold: true },
            ...firstText.runs,
          ];
        } else {
          itemBlocks.unshift(
            textBlock([{ text: taskMarker.trimEnd(), bold: true }], {
              indent: indent + 14,
            }),
          );
        }
        blocks.push(...itemBlocks);
      });
      if (blocks.at(-1)?.type === "text") {
        blocks.at(-1)!.spaceAfter = 9;
      }
    } else if (token.type === "table") {
      const table = token as Tokens.Table;
      const rows = [table.header, ...table.rows];
      rows.forEach((row, index) => {
        const runs = row.flatMap(
          (cell: Tokens.TableCell, cellIndex: number) => [
            ...(cellIndex > 0 ? [{ text: "  |  ", bold: false }] : []),
            ...inlineRuns(cell.tokens).map((run) => ({
              ...run,
              bold: index === 0 || run.bold,
            })),
          ],
        );
        blocks.push(
          textBlock(runs, {
            size: 10,
            indent,
            spaceAfter: index === rows.length - 1 ? 9 : 3,
          }),
        );
      });
    } else if (token.type === "hr") {
      blocks.push({
        type: "rule",
        spaceBefore: 5,
        spaceAfter: 10,
      });
    } else if (token.type === "html") {
      const text = token.text.replace(/<[^>]+>/g, "").trim();
      if (text) {
        blocks.push(
          textBlock([{ text, bold: false }], {
            indent,
          }),
        );
      }
    }
  }
  return blocks;
};

const fontFor = (run: InlineRun, regular: PDFFont, bold: PDFFont): PDFFont =>
  run.bold ? bold : regular;

const splitToWidth = (
  text: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] => {
  if (font.widthOfTextAtSize(text, size) <= width) {
    return [text];
  }
  const chunks: string[] = [];
  let chunk = "";
  let chunkWidth = 0;
  for (const character of Array.from(text)) {
    const characterWidth = font.widthOfTextAtSize(character, size);
    if (chunk && chunkWidth + characterWidth > width) {
      chunks.push(chunk);
      chunk = "";
      chunkWidth = 0;
    }
    chunk += character;
    chunkWidth += characterWidth;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
};

const wrapRuns = (
  runs: readonly InlineRun[],
  size: number,
  width: number,
  regular: PDFFont,
  bold: PDFFont,
): WrappedLine[] => {
  const lines: WrappedLine[] = [{ runs: [], width: 0 }];
  for (const run of runs) {
    for (const segment of run.text.split(/(\s+)/)) {
      if (!segment) {
        continue;
      }
      if (segment.includes("\n")) {
        const parts = segment.split("\n");
        parts.forEach((part, index) => {
          if (part) {
            const line = lines.at(-1)!;
            const text = /^\s+$/.test(part) ? " " : part;
            const segmentWidth = fontFor(run, regular, bold).widthOfTextAtSize(
              text,
              size,
            );
            line.runs.push({ ...run, text });
            line.width += segmentWidth;
          }
          if (index < parts.length - 1) {
            lines.push({ runs: [], width: 0 });
          }
        });
        continue;
      }

      const text = /^\s+$/.test(segment) ? " " : segment;
      const font = fontFor(run, regular, bold);
      const pieces = splitToWidth(text, font, size, width);
      pieces.forEach((piece, pieceIndex) => {
        if (pieceIndex > 0) {
          lines.push({ runs: [], width: 0 });
        }
        const pieceWidth = font.widthOfTextAtSize(piece, size);
        let line = lines.at(-1)!;
        if (
          piece !== " " &&
          line.runs.length > 0 &&
          line.width + pieceWidth > width
        ) {
          lines.push({ runs: [], width: 0 });
          line = lines.at(-1)!;
        }
        if (piece === " " && line.runs.length === 0) {
          return;
        }
        line.runs.push({ ...run, text: piece });
        line.width += pieceWidth;
      });
    }
  }
  return lines;
};

export class MarkdownPdfRenderer {
  constructor(
    private readonly regularFontBytes: Uint8Array,
    private readonly boldFontBytes: Uint8Array = regularFontBytes,
  ) {}

  async render(markdown: string): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const regular = await pdf.embedFont(this.regularFontBytes);
    const bold = await pdf.embedFont(this.boldFontBytes);
    const tokens = Lexer.lex(stripFrontmatter(markdown), {
      gfm: true,
    });
    const blocks = blocksFromTokens(tokens);
    let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - PAGE_MARGIN;

    const nextPage = (): PDFPage => {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - PAGE_MARGIN;
      return page;
    };
    const ensureSpace = (height: number): void => {
      if (y - height < PAGE_MARGIN) {
        nextPage();
      }
    };

    for (const block of blocks) {
      if (block.type === "rule") {
        ensureSpace(block.spaceBefore + block.spaceAfter + 1);
        y -= block.spaceBefore;
        page.drawLine({
          start: { x: PAGE_MARGIN, y },
          end: { x: PAGE_WIDTH - PAGE_MARGIN, y },
          thickness: 0.75,
          color: rgb(0.65, 0.65, 0.65),
        });
        y -= block.spaceAfter;
        continue;
      }

      const lineHeight = block.size * 1.4;
      const lines = wrapRuns(
        block.runs,
        block.size,
        CONTENT_WIDTH - block.indent,
        regular,
        bold,
      );
      ensureSpace(block.spaceBefore + lineHeight);
      y -= block.spaceBefore;
      for (const line of lines) {
        ensureSpace(lineHeight);
        let x = PAGE_MARGIN + block.indent;
        for (const run of line.runs) {
          const font = fontFor(run, regular, bold);
          page.drawText(run.text, {
            x,
            y: y - block.size,
            size: block.size,
            font,
            color: rgb(0.12, 0.12, 0.12),
          });
          x += font.widthOfTextAtSize(run.text, block.size);
        }
        y -= lineHeight;
      }
      y -= block.spaceAfter;
    }

    return pdf.save();
  }
}
