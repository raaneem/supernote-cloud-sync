import type { ExportFormat } from "../sync/manifest";
import type { ApiModelOption } from "../ocr/api-models";
import type {
  TranscriptionEngine,
  TranscriptionEngineOption,
} from "../ocr/configuration";

export interface TranscriptionAvailability {
  visible: boolean;
  enabled: boolean;
  hint: string;
  engine: TranscriptionEngine;
  model: string;
  engines: readonly TranscriptionEngineOption[];
  loadApiModels: () => Promise<readonly ApiModelOption[]>;
}

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  markdown: "Markdown",
  pdf: "PDF",
  images: "Images",
  "markdown-pdf": "Markdown + PDF",
  "markdown-images": "Markdown + images",
  "formatted-markdown": "Markdown (formatted transcription)",
  "formatted-markdown-pdf": "Markdown (formatted transcription) + PDF",
};

const BASE_EXPORT_FORMATS: readonly ExportFormat[] = [
  "markdown",
  "pdf",
  "images",
  "markdown-pdf",
  "markdown-images",
];

const FORMATTED_EXPORT_FORMATS: readonly ExportFormat[] = [
  "formatted-markdown",
  "formatted-markdown-pdf",
];

export const availableExportFormats = (
  availability: TranscriptionAvailability,
): readonly ExportFormat[] =>
  availability.visible && availability.enabled
    ? [...BASE_EXPORT_FORMATS, ...FORMATTED_EXPORT_FORMATS]
    : BASE_EXPORT_FORMATS;

export const coerceAvailableExportFormat = (
  format: ExportFormat,
  availability: TranscriptionAvailability,
): ExportFormat =>
  availableExportFormats(availability).includes(format)
    ? format
    : "markdown-images";

export const isDocumentExportFormat = (format: ExportFormat): boolean =>
  format === "formatted-markdown" || format === "formatted-markdown-pdf";
