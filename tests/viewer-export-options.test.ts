import { describe, expect, it } from "vitest";

import {
  availableExportFormats,
  coerceAvailableExportFormat,
  type TranscriptionAvailability,
} from "../src/viewer/export-options";

const availability = (
  update: Partial<TranscriptionAvailability> = {},
): TranscriptionAvailability => ({
  visible: true,
  enabled: true,
  hint: "Ready",
  engine: "api",
  model: "",
  engines: [{ engine: "api", label: "API", model: "" }],
  loadApiModels: async () => [],
  ...update,
});

describe("viewer export format availability", () => {
  it("includes formatted formats only when transcription can run", () => {
    expect(availableExportFormats(availability())).toContain(
      "formatted-markdown-pdf",
    );
    expect(
      availableExportFormats(availability({ enabled: false })),
    ).not.toContain("formatted-markdown-pdf");
  });

  it("coerces a stale formatted default when transcription is unavailable", () => {
    expect(
      coerceAvailableExportFormat(
        "formatted-markdown-pdf",
        availability({ enabled: false }),
      ),
    ).toBe("markdown-images");
    expect(
      coerceAvailableExportFormat("formatted-markdown-pdf", availability()),
    ).toBe("formatted-markdown-pdf");
  });
});
