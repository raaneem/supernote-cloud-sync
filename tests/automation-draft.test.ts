import { describe, expect, it } from "vitest";

import {
  automationDraftErrors,
  sortAutomationList,
  upsertAutomationDraft,
} from "../src/settings-ux/automation-draft";
import type { WatchHookDefinition } from "../src/sync/watch-hooks";

const automation = (
  update: Partial<WatchHookDefinition> = {},
): WatchHookDefinition => ({
  id: "daily",
  name: "Daily notes",
  sourceNote: "supernote/Note/Daily.note",
  format: "images",
  action: "command",
  command: "dispatch {{folder}}",
  prompt: "",
  model: "",
  claudeAllowedTools: "Read,Write,Glob,Bash",
  codexSandbox: "workspace-write",
  keepFolder: "",
  ...update,
});

describe("Automation draft", () => {
  it("requires a trimmed, case-insensitively unique name", () => {
    const existing = [automation()];

    expect(
      automationDraftErrors(
        automation({ id: "new", name: " daily NOTES " }),
        existing,
      ),
    ).toEqual({
      name: "Another Automation already uses this name.",
    });
    expect(
      automationDraftErrors(automation({ id: "new", name: "   " }), existing),
    ).toEqual({
      name: "Add an Automation name.",
    });
    expect(
      automationDraftErrors(
        automation({
          id: "new",
          name: "New",
          keepFolder: "../outside",
        }),
        existing,
      ),
    ).toEqual({
      keepFolder: "Choose a folder inside the vault.",
    });
    expect(
      automationDraftErrors(
        automation({
          id: "new",
          name: "New",
          keepFolder: "supernote/output",
        }),
        existing,
        "supernote",
      ),
    ).toEqual({
      keepFolder: "The Automation keep folder must be outside the Mirror.",
    });
  });

  it("atomically adds or replaces a normalized draft", () => {
    const existing = [automation()];
    const added = upsertAutomationDraft(
      existing,
      automation({
        id: "weekly",
        name: " Weekly notes ",
        action: "codex",
        format: "markdown",
        command: "stale",
        prompt: "Summarize",
      }),
    );

    expect(existing).toEqual([automation()]);
    expect(added).toEqual([
      automation(),
      automation({
        id: "weekly",
        name: "Weekly notes",
        action: "codex",
        format: "images",
        command: "",
        prompt: "Summarize",
      }),
    ]);

    expect(
      upsertAutomationDraft(added, automation({ name: "Renamed" })).map(
        ({ id, name }) => ({ id, name }),
      ),
    ).toEqual([
      { id: "daily", name: "Renamed" },
      { id: "weekly", name: "Weekly notes" },
    ]);
  });

  it("sorts blocked Automations first, then alphabetically", () => {
    const hooks = [
      automation({ id: "zulu", name: "Zulu" }),
      automation({ id: "alpha", name: "alpha" }),
      automation({ id: "broken", name: "Broken" }),
    ];

    const sorted = sortAutomationList(hooks, (hook) =>
      hook.id === "broken" ? "Source notebook is missing." : null,
    );

    expect(
      sorted.map(({ automation, blockingReason }) => ({
        id: automation.id,
        blockingReason,
      })),
    ).toEqual([
      {
        id: "broken",
        blockingReason: "Source notebook is missing.",
      },
      { id: "alpha", blockingReason: null },
      { id: "zulu", blockingReason: null },
    ]);
    expect(sorted[0]?.automation).toBe(hooks[2]);
    expect(sorted[0]?.automation).not.toHaveProperty("blockingReason");
  });
});
