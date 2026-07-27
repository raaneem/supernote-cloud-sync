import { describe, expect, it } from "vitest";

import { BoundedTextBuffer } from "../src/shared/bounded-text-buffer";

describe("BoundedTextBuffer", () => {
  it("retains an exact tail across chunk boundaries", () => {
    const buffer = new BoundedTextBuffer(64);

    buffer.append("a".repeat(40));
    expect(buffer.append("b".repeat(40))).toBe(true);

    expect(buffer.byteLength).toBe(64);
    expect(buffer.text()).toBe(`${"a".repeat(24)}${"b".repeat(40)}`);
  });

  it("never splits a UTF-8 code point at the byte boundary", () => {
    const buffer = new BoundedTextBuffer(7);

    buffer.append("start");
    buffer.append("🙂end");
    const retained = buffer.text();

    expect(new TextEncoder().encode(retained).byteLength).toBeLessThanOrEqual(
      7,
    );
    expect(retained).not.toContain("�");
    expect(retained.endsWith("end")).toBe(true);
  });
});
