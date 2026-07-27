import { describe, expect, it } from "vitest";

import {
  displayCanvasBackingSize,
  displayCanvasBoxKey,
} from "../src/viewer/display-canvas-size";

describe("display canvas backing size", () => {
  it("uses display pixel density when native pixels and memory allow", () => {
    expect(
      displayCanvasBackingSize({
        sourceWidth: 1_920,
        sourceHeight: 2_560,
        displayWidth: 390,
        displayHeight: 520,
        devicePixelRatio: 3,
      }),
    ).toEqual({
      width: 1_170,
      height: 1_560,
      bytes: 7_300_800,
    });
  });

  it("never upscales beyond the native notebook page", () => {
    expect(
      displayCanvasBackingSize({
        sourceWidth: 1_920,
        sourceHeight: 2_560,
        displayWidth: 960,
        displayHeight: 1_280,
        devicePixelRatio: 3,
      }),
    ).toEqual({
      width: 1_920,
      height: 2_560,
      bytes: 19_660_800,
    });
  });

  it("falls back to one display pixel per CSS pixel for an invalid DPR", () => {
    expect(
      displayCanvasBackingSize({
        sourceWidth: 1_920,
        sourceHeight: 2_560,
        displayWidth: 300,
        displayHeight: 400,
        devicePixelRatio: Number.NaN,
      }),
    ).toEqual({
      width: 300,
      height: 400,
      bytes: 480_000,
    });
  });

  it("does not undersample an available fractional CSS pixel", () => {
    expect(
      displayCanvasBackingSize({
        sourceWidth: 473,
        sourceHeight: 631,
        displayWidth: 472.25,
        displayHeight: 630,
        devicePixelRatio: 1,
      }),
    ).toEqual({
      width: 473,
      height: 630,
      bytes: 1_191_960,
    });
  });

  it("keeps subpixel layout jitter in one backing-size bucket", () => {
    expect(
      displayCanvasBoxKey({
        width: 472.25,
        height: 630,
        devicePixelRatio: 1,
      }),
    ).toBe(
      displayCanvasBoxKey({
        width: 472.75,
        height: 630,
        devicePixelRatio: 1,
      }),
    );
  });
});
