import type { TextBox } from "../note/textboxes";

export interface ExportedPage {
  pageNumber: number;
  imageVaultPath: string | null;
  recognitionText: string | null;
  recognitionSource?: "device" | "ocr";
  deviceRecognitionText?: string | null;
  transcriptionUnavailable?: boolean;
  textBoxes: readonly TextBox[];
}

export interface ExportMarkdownInput {
  title: string;
  sourceNotePath: string;
  remotePath: string;
  exportedAt: string;
  pdfVaultPath?: string;
  formattedTranscription?: string;
  usesCustomDocumentInstructions?: boolean;
  pages: readonly ExportedPage[];
}

const quoteMarkdown = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

export const buildExportMarkdown = ({
  title,
  sourceNotePath,
  remotePath,
  exportedAt,
  pdfVaultPath,
  formattedTranscription,
  usesCustomDocumentInstructions,
  pages,
}: ExportMarkdownInput): string => {
  const lines = [
    "---",
    `supernote-note: ${JSON.stringify(sourceNotePath)}`,
    `supernote-pages: [${pages.map((page) => page.pageNumber).join(", ")}]`,
    "cssclasses: [supernote-generated-preview]",
    ...(usesCustomDocumentInstructions
      ? ["supernote-transcription: custom"]
      : []),
    "---",
    "",
  ];
  if (formattedTranscription !== undefined) {
    lines.push(
      formattedTranscription.trimEnd() || "*Transcription failed.*",
      "",
    );
    const devicePages = pages.filter((page) =>
      page.deviceRecognitionText?.trim(),
    );
    if (devicePages.length > 0) {
      lines.push("> [!quote]- On-device recognition");
      for (const page of devicePages) {
        lines.push(
          `> ### Page ${page.pageNumber}`,
          ...quoteMarkdown(page.deviceRecognitionText!.trimEnd()).split("\n"),
          ">",
        );
      }
      lines.push("");
    }
    if (pdfVaultPath) {
      lines.push(`![[${pdfVaultPath}]]`, "");
    }
    return lines.join("\n");
  }
  lines.push(
    `# ${title}`,
    "",
    `> [!info]- Exported from Supernote \`${remotePath}\` at ${exportedAt}.`,
    "",
  );
  if (pdfVaultPath) {
    lines.push(`![[${pdfVaultPath}]]`, "");
  }
  for (const page of pages) {
    lines.push(`### Page ${page.pageNumber}`, "");
    if (page.imageVaultPath) {
      lines.push(`![[${page.imageVaultPath}]]`, "");
    }
    for (const box of page.textBoxes) {
      lines.push(quoteMarkdown(box.text), "");
    }
    if (page.recognitionText?.trim()) {
      lines.push(page.recognitionText.trimEnd(), "");
    }
    if (page.transcriptionUnavailable) {
      lines.push("*Transcription unavailable.*", "");
    }
    if (page.deviceRecognitionText?.trim()) {
      lines.push(
        "> [!quote]- On-device recognition",
        quoteMarkdown(page.deviceRecognitionText.trimEnd()),
        "",
      );
    }
  }
  return lines.join("\n");
};
