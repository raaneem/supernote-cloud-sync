import { describe, expect, it } from "vitest";

import { ClaudeStreamRenderer } from "../src/run/claude-stream";

describe("ClaudeStreamRenderer", () => {
  it("renders init, tool use, text, and result events defensively", () => {
    const renderer = new ClaudeStreamRenderer();
    const chunk = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-4-5",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/tmp/page-01.png" },
            },
            { type: "text", text: "Page read." },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        duration_ms: 1_250,
        total_cost_usd: 0.012345,
      }),
      JSON.stringify({ type: "future_event", value: 7 }),
      "not-json",
      "",
    ].join("\n");

    expect(renderer.push(chunk)).toEqual([
      "session started (claude-sonnet-4-5)",
      '→ Read({"file_path":"/tmp/page-01.png"})',
      "Page read.",
      "completed in 1.3s · $0.0123",
      '{"type":"future_event","value":7}',
      "not-json",
    ]);
  });

  it("buffers split lines and flushes an incomplete final event", () => {
    const renderer = new ClaudeStreamRenderer();

    expect(renderer.push('{"type":"system","subtype":"in')).toEqual([]);
    expect(renderer.push('it","model":"opus"}\nplain')).toEqual([
      "session started (opus)",
    ]);
    expect(renderer.flush()).toEqual(["plain"]);
  });
});
