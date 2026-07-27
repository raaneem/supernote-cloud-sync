import { describe, expect, it } from "vitest";

import {
  EmbeddedPageActivation,
  embeddedPageActivationKey,
} from "../src/viewer/embed-reading-dom";

describe("embedded page activation", () => {
  it("opens for pointer clicks and Enter or Space only", () => {
    const activation = new EmbeddedPageActivation();

    expect(activation.shouldActivateClick()).toBe(true);
    expect(embeddedPageActivationKey("Enter")).toBe(true);
    expect(embeddedPageActivationKey(" ")).toBe(true);
    expect(embeddedPageActivationKey("ArrowRight")).toBe(false);
  });

  it("consumes the synthetic click after completed page navigation", () => {
    let now = 100;
    const activation = new EmbeddedPageActivation(() => now);

    activation.completedGesture("next");
    expect(activation.shouldActivateClick()).toBe(false);
    expect(activation.shouldActivateClick()).toBe(false);

    now = 601;
    expect(activation.shouldActivateClick()).toBe(true);
    activation.completedGesture("snap-back");
    expect(activation.shouldActivateClick()).toBe(true);
  });
});
