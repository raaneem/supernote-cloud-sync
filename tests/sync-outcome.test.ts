import { describe, expect, it } from "vitest";

import { syncCompletionOutcome } from "../src/sync/sync-outcome";

describe("syncCompletionOutcome", () => {
  it("does not label a partial sync as succeeded", () => {
    expect(syncCompletionOutcome(0)).toBe("succeeded");
    expect(syncCompletionOutcome(1)).toBe("failed");
    expect(syncCompletionOutcome(3)).toBe("failed");
  });
});
