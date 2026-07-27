import { describe, expect, it } from "vitest";

import { vaultSafeName } from "../src/shared/path";

describe("vault-safe names", () => {
  it.each([
    ['draft<>:"|?*.note', "draft_______.note"],
    ["control\u0001name.note", "control_name.note"],
    ["trailing.note.", "trailing.note_"],
    ["trailing.note ", "trailing.note_"],
    ["CON.note", "_CON.note"],
    ["lpt9", "_lpt9"],
    ["folder\\child.note", "folder_child.note"],
    [".hidden.note", "_.hidden.note"],
  ])("maps %j to %j", (remoteName, vaultName) => {
    expect(vaultSafeName(remoteName)).toBe(vaultName);
  });
});
