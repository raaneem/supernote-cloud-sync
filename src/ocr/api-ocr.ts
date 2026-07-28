import { customDocumentPrompt, TRANSCRIPTION_PROMPT } from "./prompt";
import { transcriptionRunLabel } from "../run/run-format";
import { RunRegistry } from "../run/run-registry";
import type {
  OcrPage,
  OcrPort,
  OcrRequest,
  OcrResult,
  PreparedOcr,
} from "./types";

export interface ChatCompletionRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface ChatCompletionResponse {
  status: number;
  json: unknown;
}

export type ChatCompletionExecutor = (
  request: ChatCompletionRequest,
) => Promise<ChatCompletionResponse>;

interface ApiOcrOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraInstructions: string;
  request: ChatCompletionExecutor;
  concurrency?: number;
  runs?: RunRegistry;
}

interface JsonObject {
  [key: string]: unknown;
}

type PreparedApiRequest =
  | { mode: "document"; body: string }
  | {
      mode: "page";
      pages: readonly OcrPage[];
      failedPages: readonly number[];
      errors: readonly string[];
    };

const asObject = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

export const BASE64_CHUNK_BYTES = 3 * 8192;
export const BASE64_ENCODED_CHUNK_BYTES = (BASE64_CHUNK_BYTES / 3) * 4;
const DATA_URL_PREFIX = "data:image/png;base64,";
const BASE64_PLACEHOLDER = "__SUPERNOTE_BASE64_PAYLOAD__";

const appendBase64 = (
  bytes: Uint8Array,
  append: (chunk: string) => void,
): void => {
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    append(
      btoa(
        String.fromCharCode(
          ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
        ),
      ),
    );
  }
};

const toBase64 = (bytes: Uint8Array): string => {
  let encoded = "";
  appendBase64(bytes, (chunk) => {
    encoded += chunk;
  });
  return encoded;
};

const imagePart = (base64: string): JsonObject => ({
  type: "image_url",
  image_url: {
    url: `${DATA_URL_PREFIX}${base64}`,
  },
});

const responseError = (response: ChatCompletionResponse): string => {
  const json = asObject(response.json);
  const error = asObject(json?.error);
  const detail = typeof error?.message === "string" ? `: ${error.message}` : "";
  return `Transcription API failed with HTTP ${response.status}${detail}`;
};

export class ApiOcrService implements OcrPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly instructions: string;
  private readonly request: ChatCompletionExecutor;
  private readonly concurrency: number;
  private readonly runs: RunRegistry | undefined;

  constructor(options: ApiOcrOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model.trim();
    this.instructions = [TRANSCRIPTION_PROMPT, options.extraInstructions.trim()]
      .filter(Boolean)
      .join("\n\nAdditional instructions:\n");
    this.request = options.request;
    this.runs = options.runs;
    this.concurrency = Math.max(
      1,
      Math.min(3, Math.trunc(options.concurrency ?? 3)),
    );
  }

  async prepare(request: OcrRequest): Promise<PreparedOcr> {
    const batchPageNumbers =
      request.mode === "page"
        ? request.pages.pageNumbers.slice(0, this.concurrency)
        : request.pages.pageNumbers;
    const prepared: PreparedApiRequest =
      request.mode === "document"
        ? {
            mode: "document",
            body: await this.documentBody(
              request,
              request.customPrompt?.trim()
                ? customDocumentPrompt(request.customPrompt)
                : this.instructions,
            ),
          }
        : {
            mode: "page",
            ...(await this.preparePages(request, batchPageNumbers)),
          };
    return {
      remainingPageNumbers:
        request.mode === "page"
          ? request.pages.pageNumbers.slice(batchPageNumbers.length)
          : [],
      transcribe: () => this.transcribePrepared(request, prepared),
    };
  }

  async transcribe(request: OcrRequest): Promise<OcrResult> {
    try {
      let remainingPageNumbers = request.pages.pageNumbers;
      const pageText = new Map<number, string>();
      const failedPages: number[] = [];
      const errors: string[] = [];
      do {
        const prepared = await this.prepare({
          ...request,
          pages: {
            ...request.pages,
            pageNumbers: remainingPageNumbers,
          },
        });
        const result = await prepared.transcribe();
        for (const [pageNumber, text] of result.pageText) {
          pageText.set(pageNumber, text);
        }
        failedPages.push(...result.failedPages);
        errors.push(...result.errors);
        if (request.mode === "document") {
          return result;
        }
        remainingPageNumbers = prepared.remainingPageNumbers;
      } while (remainingPageNumbers.length > 0);
      return {
        pageText,
        documentText: null,
        failedPages: failedPages.sort((left, right) => left - right),
        errors,
      };
    } catch (error) {
      if (request.mode !== "document") {
        throw error;
      }
      return this.failedDocumentResult(request, error);
    }
  }

  private async transcribePrepared(
    request: OcrRequest,
    prepared: PreparedApiRequest,
  ): Promise<OcrResult> {
    const pageCount = request.pages.pageNumbers.length;
    const run = this.runs?.start({
      kind: "transcription",
      label: transcriptionRunLabel(request.note, pageCount),
      engine: "api",
      model: this.model || "default",
    });
    run?.append(
      "stdout",
      `sending ${pageCount} page${pageCount === 1 ? "" : "s"} to the API\n`,
    );
    try {
      const result =
        prepared.mode === "document"
          ? await this.transcribeDocument(request, prepared.body)
          : await this.transcribePages(prepared);
      if (result.errors.length > 0) {
        run?.append("stderr", `${result.errors.join("\n")}\n`);
        run?.finish("failed");
      } else if (result.failedPages.length > 0) {
        run?.append(
          "stderr",
          `failed pages: ${result.failedPages.join(", ")}\n`,
        );
        run?.finish("failed");
      } else {
        run?.append("stdout", "API transcription completed\n");
        run?.finish("succeeded");
      }
      return result;
    } catch (error) {
      run?.append(
        "stderr",
        `${error instanceof Error ? error.message : "Unknown API error"}\n`,
      );
      run?.finish("failed");
      throw error;
    }
  }

  private async preparePages(
    request: OcrRequest,
    pageNumbers: readonly number[],
  ): Promise<{
    pages: readonly OcrPage[];
    failedPages: readonly number[];
    errors: readonly string[];
  }> {
    const pages: OcrPage[] = [];
    const failedPages: number[] = [];
    const errors: string[] = [];
    for (const pageNumber of pageNumbers) {
      try {
        pages.push({
          pageNumber,
          image: await request.pages.render(pageNumber),
        });
      } catch (error) {
        failedPages.push(pageNumber);
        errors.push(
          `Page ${pageNumber}: ${
            error instanceof Error ? error.message : "render failed"
          }`,
        );
      }
    }
    return { pages, failedPages, errors };
  }

  private async transcribePages(
    prepared: Extract<PreparedApiRequest, { mode: "page" }>,
  ): Promise<OcrResult> {
    const { pages } = prepared;
    const pageText = new Map<number, string>();
    const failedPages = [...prepared.failedPages];
    const errors = [...prepared.errors];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pages.length) {
        const page = pages[cursor++]!;
        const pageNumber = page.pageNumber;
        try {
          pageText.set(
            pageNumber,
            await this.completeBody(
              this.serializeBody(this.instructions, [toBase64(page.image)]),
            ),
          );
        } catch (error) {
          failedPages.push(pageNumber);
          errors.push(
            `Page ${pageNumber}: ${
              error instanceof Error ? error.message : "unknown API error"
            }`,
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(this.concurrency, pages.length),
        },
        () => worker(),
      ),
    );
    failedPages.sort((left, right) => left - right);
    return {
      pageText,
      documentText: null,
      failedPages,
      errors,
    };
  }

  private async transcribeDocument(
    request: OcrRequest,
    body: string,
  ): Promise<OcrResult> {
    try {
      return {
        pageText: new Map(),
        documentText: await this.completeBody(body),
        failedPages: [],
        errors: [],
      };
    } catch (error) {
      return this.failedDocumentResult(request, error);
    }
  }

  private failedDocumentResult(request: OcrRequest, error: unknown): OcrResult {
    return {
      pageText: new Map(),
      documentText: null,
      failedPages: request.pages.pageNumbers,
      errors: [
        `Document transcription failed; the selection remained one logical request and was not silently split. ${
          error instanceof Error ? error.message : "Unknown API error"
        }`,
      ],
    };
  }

  private async documentBody(
    request: OcrRequest,
    instructions: string,
  ): Promise<string> {
    const imageTemplate = JSON.stringify(imagePart(BASE64_PLACEHOLDER));
    const bodyTemplate = this.serializeBody(instructions, [BASE64_PLACEHOLDER]);
    const partIndex = bodyTemplate.indexOf(imageTemplate);
    const payloadIndex = imageTemplate.indexOf(BASE64_PLACEHOLDER);
    if (partIndex < 0 || payloadIndex < 0) {
      throw new Error("Cannot prepare transcription request envelope");
    }
    const bodyPrefix = bodyTemplate.slice(0, partIndex);
    const bodySuffix = bodyTemplate.slice(partIndex + imageTemplate.length);
    const imagePrefix = imageTemplate.slice(0, payloadIndex);
    const imageSuffix = imageTemplate.slice(
      payloadIndex + BASE64_PLACEHOLDER.length,
    );
    let body = bodyPrefix;
    let imageIndex = 0;
    for (const pageNumber of request.pages.pageNumbers) {
      const image = await request.pages.render(pageNumber);
      if (imageIndex > 0) {
        body += ",";
      }
      body += imagePrefix;
      appendBase64(image, (chunk) => {
        body += chunk;
      });
      body += imageSuffix;
      imageIndex += 1;
    }
    return `${body}${bodySuffix}`;
  }

  private serializeBody(
    instructions: string,
    images: readonly string[],
  ): string {
    return JSON.stringify({
      ...(this.model ? { model: this.model } : {}),
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instructions },
            ...images.map(imagePart),
          ],
        },
      ],
    });
  }

  private async completeBody(body: string): Promise<string> {
    const response = await this.request({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(responseError(response));
    }
    const json = asObject(response.json);
    const choices = Array.isArray(json?.choices) ? json.choices : [];
    const message = asObject(asObject(choices[0])?.message);
    if (typeof message?.content !== "string" || !message.content.trim()) {
      throw new Error("Transcription API response did not include text");
    }
    return message.content.trimEnd();
  }
}
