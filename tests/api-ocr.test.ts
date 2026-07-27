import { describe, expect, it, vi } from "vitest";

import { ApiOcrService, type ChatCompletionRequest } from "../src/ocr/api-ocr";
import { TRANSCRIPTION_PROMPT } from "../src/ocr/prompt";
import { RunRegistry } from "../src/run/run-registry";
import { fixedOcrPageSource } from "./ocr-page-source";

const image = (value: number): Uint8Array => new Uint8Array([value]);

describe("ApiOcrService", () => {
  it("omits model when Default is selected", async () => {
    const request = vi.fn(async (_input: ChatCompletionRequest) => ({
      status: 200,
      json: { choices: [{ message: { content: "text" } }] },
    }));
    const service = new ApiOcrService({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "",
      extraInstructions: "",
      request,
    });

    await service.transcribe({
      mode: "page",
      note: "Scratch.note",
      pages: fixedOcrPageSource([{ pageNumber: 1, image: image(1) }]),
    });

    const body = JSON.parse(request.mock.calls[0]![0].body) as {
      model?: string;
    };
    expect(body).not.toHaveProperty("model");
  });

  it("transcribes page mode with one isolated request per page", async () => {
    let active = 0;
    let peak = 0;
    let activeRenders = 0;
    let peakRenders = 0;
    const render = vi.fn(async (pageNumber: number) => {
      activeRenders += 1;
      peakRenders = Math.max(peakRenders, activeRenders);
      await Promise.resolve();
      activeRenders -= 1;
      return image(pageNumber);
    });
    const request = vi.fn(async (input: ChatCompletionRequest) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      const body = JSON.parse(input.body) as {
        messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
      };
      const url = body.messages[0]!.content.find((part) => part.image_url)!
        .image_url!.url;
      return {
        status: 200,
        json: {
          choices: [{ message: { content: `text:${url.slice(-4)}` } }],
        },
      };
    });
    const service = new ApiOcrService({
      baseUrl: "https://openrouter.ai/api/v1/",
      apiKey: "secret",
      model: "vision/model",
      extraInstructions: "Keep margin notes.",
      request,
      concurrency: 2,
    });

    const result = await service.transcribe({
      mode: "page",
      note: "Scratch.note",
      customPrompt: "Summarize these pages.",
      pages: { pageNumbers: [1, 2, 3], render },
    });

    expect(result.pageText.size).toBe(3);
    expect(request).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalledTimes(3);
    expect(peakRenders).toBeLessThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(request.mock.calls[0]![0].url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(request.mock.calls[0]![0].headers.Authorization).toBe(
      "Bearer secret",
    );
    const sent = JSON.parse(request.mock.calls[0]![0].body) as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(sent.messages[0]!.content[0]!.text).toContain(TRANSCRIPTION_PROMPT);
    expect(sent.messages[0]!.content[0]!.text).toContain("Keep margin notes.");
    expect(sent.messages[0]!.content[0]!.text).not.toContain(
      "Summarize these pages.",
    );
  });

  it("prepares only one bounded page-mode request batch", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: { choices: [{ message: { content: "text" } }] },
    }));
    const render = vi.fn(async (pageNumber: number) => image(pageNumber));
    const service = new ApiOcrService({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "",
      extraInstructions: "",
      request,
      concurrency: 2,
    });

    const prepared = await service.prepare({
      mode: "page",
      note: "Scratch.note",
      pages: { pageNumbers: [1, 2, 3, 4, 5], render },
    });

    expect(render.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
    expect(prepared.remainingPageNumbers).toEqual([3, 4, 5]);
    expect(request).not.toHaveBeenCalled();
    await prepared.transcribe();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("sends document mode as one request containing every selected image", async () => {
    const request = vi.fn(async (input: ChatCompletionRequest) => {
      const body = JSON.parse(input.body) as {
        messages: Array<{ content: unknown[] }>;
      };
      expect(body.messages[0]!.content).toHaveLength(4);
      return {
        status: 200,
        json: {
          choices: [
            {
              message: {
                content: "# Heading\n\n- one\n- two",
              },
            },
          ],
        },
      };
    });
    const service = new ApiOcrService({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      model: "vision/model",
      extraInstructions: "",
      request,
    });

    const result = await service.transcribe({
      mode: "document",
      note: "Journal.note",
      pages: fixedOcrPageSource([
        { pageNumber: 3, image: image(3) },
        { pageNumber: 4, image: image(4) },
        { pageNumber: 5, image: image(5) },
      ]),
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.documentText).toBe("# Heading\n\n- one\n- two");
  });

  it("rejects an oversized document before constructing or sending its body", async () => {
    const request = vi.fn();
    const render = vi.fn(async () => new Uint8Array(100_000));
    const service = new ApiOcrService({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      model: "vision/model",
      extraInstructions: "",
      request,
      documentRequestByteLimit: 1_000,
    });

    const result = await service.transcribe({
      mode: "document",
      note: "Journal.note",
      pages: {
        pageNumbers: [1, 2],
        render,
      },
    });

    expect(render).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(result.failedPages).toEqual([1, 2]);
    expect(result.errors[0]).toContain("page mode");
    expect(result.errors[0]).toContain("fewer pages");
  });

  it("encodes multi-chunk image bytes without changing the request payload", async () => {
    const bytes = Uint8Array.from(
      { length: 65_539 },
      (_, index) => index % 251,
    );
    const request = vi.fn(async (input: ChatCompletionRequest) => {
      const body = JSON.parse(input.body) as {
        messages: Array<{
          content: Array<{ image_url?: { url: string } }>;
        }>;
      };
      const url = body.messages[0]!.content.find((part) => part.image_url)!
        .image_url!.url;
      expect(url).toBe(
        `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      );
      return {
        status: 200,
        json: { choices: [{ message: { content: "text" } }] },
      };
    });
    const service = new ApiOcrService({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "",
      extraInstructions: "",
      request,
    });

    await service.transcribe({
      mode: "page",
      note: "Scratch.note",
      pages: fixedOcrPageSource([{ pageNumber: 1, image: bytes }]),
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("uses one-off document instructions instead of transcription defaults", async () => {
    const request = vi.fn(async (_input: ChatCompletionRequest) => ({
      status: 200,
      json: {
        choices: [{ message: { content: "# Summary\n\nOrganized notes" } }],
      },
    }));
    const service = new ApiOcrService({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      model: "vision/model",
      extraInstructions: "Keep margin notes.",
      request,
    });

    await service.transcribe({
      mode: "document",
      note: "Journal.note",
      customPrompt: "Organize these notes and add a summary.",
      pages: fixedOcrPageSource([{ pageNumber: 1, image: image(1) }]),
    });

    const body = JSON.parse(request.mock.calls[0]![0].body) as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    const instructions = body.messages[0]!.content[0]!.text!;
    expect(instructions).toContain("Organize these notes and add a summary.");
    expect(instructions).toContain("Produce only the final Markdown document.");
    expect(instructions).not.toContain(TRANSCRIPTION_PROMPT);
    expect(instructions).not.toContain("Keep margin notes.");
  });

  it("isolates page failures instead of rejecting the batch", async () => {
    const runs = new RunRegistry({ id: () => "api-run" });
    const service = new ApiOcrService({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      model: "vision/model",
      extraInstructions: "",
      runs,
      request: async (input) =>
        input.body.includes("AQ==")
          ? { status: 429, json: { error: { message: "rate limited" } } }
          : {
              status: 200,
              json: { choices: [{ message: { content: "ok" } }] },
            },
    });

    const result = await service.transcribe({
      mode: "page",
      note: "Scratch.note",
      pages: fixedOcrPageSource([
        { pageNumber: 1, image: image(1) },
        { pageNumber: 2, image: image(2) },
      ]),
    });

    expect(result.pageText).toEqual(new Map([[2, "ok"]]));
    expect(result.failedPages).toEqual([1]);
    expect(result.errors[0]).toContain("rate limited");
    expect(runs.records()[0]).toMatchObject({
      id: "api-run",
      kind: "transcription",
      engine: "api",
      status: "failed",
      cancellable: false,
    });
    expect(runs.logText("api-run")).toContain("rate limited");
  });

  it("isolates page render failures and continues later batches", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: { choices: [{ message: { content: "ok" } }] },
    }));
    const service = new ApiOcrService({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "",
      extraInstructions: "",
      concurrency: 2,
      request,
    });

    const result = await service.transcribe({
      mode: "page",
      note: "Scratch.note",
      pages: {
        pageNumbers: [1, 2, 3, 4],
        render: async (pageNumber) => {
          if (pageNumber === 2) {
            throw new Error("page cannot render");
          }
          return image(pageNumber);
        },
      },
    });

    expect(result.pageText).toEqual(
      new Map([
        [1, "ok"],
        [3, "ok"],
        [4, "ok"],
      ]),
    );
    expect(result.failedPages).toEqual([2]);
    expect(result.errors[0]).toContain("page cannot render");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
