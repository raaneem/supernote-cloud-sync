import { describe, expect, it, vi } from "vitest";

import { ApiModelCatalog, parseApiModels } from "../src/ocr/api-models";

describe("parseApiModels", () => {
  it("keeps image-capable models and models without modality metadata", () => {
    expect(
      parseApiModels({
        data: [
          {
            id: "text-only",
            name: "Text only",
            architecture: { input_modalities: ["text"] },
          },
          {
            id: "vision",
            name: "Vision",
            architecture: { input_modalities: ["text", "image"] },
          },
          { id: "compatible-server-model" },
        ],
      }),
    ).toEqual([
      {
        id: "compatible-server-model",
        name: "compatible-server-model",
      },
      { id: "vision", name: "Vision" },
    ]);
  });

  it("ignores malformed entries", () => {
    expect(parseApiModels({ data: [null, {}, { id: "" }] })).toEqual([]);
  });

  it("caches each base URL for the session", async () => {
    const catalog = new ApiModelCatalog();
    const fetchModels = vi.fn(async () => ({
      data: [{ id: "vision" }],
    }));

    await expect(
      catalog.load("https://example.test/v1", fetchModels),
    ).resolves.toEqual([{ id: "vision", name: "vision" }]);
    await catalog.load("https://example.test/v1", fetchModels);

    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it("degrades a failed fetch to an empty picker", async () => {
    const catalog = new ApiModelCatalog();
    await expect(
      catalog.load("https://example.test/v1", async () => {
        throw new Error("offline");
      }),
    ).resolves.toEqual([]);
  });
});
