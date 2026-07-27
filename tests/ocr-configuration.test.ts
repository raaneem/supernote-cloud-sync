import { describe, expect, it } from "vitest";

import {
  defaultModelForEngine,
  effectiveTranscriptionEngine,
  effectiveTranscriptionSelection,
} from "../src/ocr/configuration";

describe("effectiveTranscriptionEngine", () => {
  it("keeps every selected engine on desktop", () => {
    expect(effectiveTranscriptionEngine("claude", true)).toBe("claude");
    expect(effectiveTranscriptionEngine("codex", true)).toBe("codex");
    expect(effectiveTranscriptionEngine("command", true)).toBe("command");
    expect(effectiveTranscriptionEngine("api", true)).toBe("api");
  });

  it("uses the mobile-capable API for every desktop engine off desktop", () => {
    expect(effectiveTranscriptionEngine("claude", false)).toBe("api");
    expect(effectiveTranscriptionEngine("codex", false)).toBe("api");
    expect(effectiveTranscriptionEngine("command", false)).toBe("api");
  });

  it("selects the engine-specific configured model", () => {
    const models = {
      claude: "sonnet",
      codex: "gpt-5",
      api: "openai/gpt-4.1",
    };
    expect(defaultModelForEngine("claude", models)).toBe("sonnet");
    expect(defaultModelForEngine("codex", models)).toBe("gpt-5");
    expect(defaultModelForEngine("api", models)).toBe("openai/gpt-4.1");
    expect(defaultModelForEngine("command", models)).toBe("");
  });

  it("keeps one-off choices separate and coerces mobile to the API model", () => {
    const configured = { engine: "claude", model: "sonnet" } as const;
    const models = {
      claude: "sonnet",
      codex: "",
      api: "vision/model",
    };

    expect(
      effectiveTranscriptionSelection(
        { engine: "codex", model: "gpt-5" },
        true,
        models,
      ),
    ).toEqual({ engine: "codex", model: "gpt-5" });
    expect(configured).toEqual({
      engine: "claude",
      model: "sonnet",
    });
    expect(effectiveTranscriptionSelection(configured, false, models)).toEqual({
      engine: "api",
      model: "vision/model",
    });
  });
});
