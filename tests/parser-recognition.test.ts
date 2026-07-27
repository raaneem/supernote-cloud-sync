import { describe, expect, it } from "vitest";

import { recognitionSpansForElements } from "../src/note/recognition";

describe("recognitionSpansForElements", () => {
  it("uses every word box for positioned PDF text", () => {
    expect(
      recognitionSpansForElements([
        {
          type: "Text",
          label: "Hello world",
          words: [
            {
              label: "Hello",
              "bounding-box": { x: 10, y: 20, width: 40, height: 12 },
            },
            {
              label: "world",
              "bounding-box": { x: 55, y: 20, width: 45, height: 12 },
            },
          ],
        },
      ]),
    ).toEqual([
      { text: "Hello", rect: [10, 20, 40, 12] },
      { text: "world", rect: [55, 20, 45, 12] },
    ]);
  });

  it("falls back to page-level text when any recognition box is absent", () => {
    expect(
      recognitionSpansForElements([
        {
          type: "Text",
          label: "No coordinates",
        },
      ]),
    ).toEqual([]);
  });
});
