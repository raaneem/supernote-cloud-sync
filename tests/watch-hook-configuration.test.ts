import { describe, expect, it, vi } from "vitest";

import {
  automationResultNotice,
  createWatchHook,
  normalizeWatchHooks,
  refreshAutomationCommands,
} from "../src/sync/watch-hook-configuration";
import type { WatchHookDefinition } from "../src/sync/watch-hooks";

const hook = (
  update: Partial<WatchHookDefinition> = {},
): WatchHookDefinition => ({
  id: "journal",
  name: "Journal dispatch",
  sourceNote: "supernote/Note/Journal.note",
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

describe("Automation commands", () => {
  it("creates a custom-command action with safe agent defaults", () => {
    expect(
      createWatchHook([], "supernote/Note/Journal.note", "journal"),
    ).toEqual(hook({ name: "Automation 1", command: "" }));
  });

  it("loads existing command-only hooks as custom-command actions", () => {
    expect(
      normalizeWatchHooks([
        {
          id: "journal",
          name: "Journal dispatch",
          sourceNote: "supernote/Note/Journal.note",
          format: "images",
          command: "dispatch {{folder}}",
          keepFolder: "",
        },
      ]),
    ).toEqual([hook()]);
  });

  it("reshapes agent hooks to image batches without a command", () => {
    expect(
      normalizeWatchHooks([
        {
          ...hook(),
          action: "codex",
          format: "markdown",
          command: "stale command",
          prompt: "/supernote-dispatch",
        },
      ]),
    ).toEqual([
      hook({
        action: "codex",
        format: "images",
        command: "",
        prompt: "/supernote-dispatch",
      }),
    ]);
  });

  it("reports an unchanged manual run without delivering pages", () => {
    expect(
      automationResultNotice(hook(), { status: "unchanged", pages: [] }, true),
    ).toBe('Automation "Journal dispatch": no new or changed pages.');
  });

  it("does not register an ephemeral Automation without a command as runnable", () => {
    const run = vi.fn();
    const registered: Array<{
      checkCallback(checking: boolean): boolean;
    }> = [];

    refreshAutomationCommands({
      commandIds: [],
      getHooks: () => [hook({ command: "", keepFolder: "" })],
      isLoggedIn: () => true,
      isRunning: () => false,
      isActionAvailable: () => true,
      register: (command) => registered.push(command),
      remove: vi.fn(),
      run,
    });

    expect(registered[0]?.checkCallback(false)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not register a missing agent action as runnable", () => {
    const registered: Array<{
      checkCallback(checking: boolean): boolean;
    }> = [];

    refreshAutomationCommands({
      commandIds: [],
      getHooks: () => [
        hook({
          action: "claude",
          command: "",
          prompt: "/supernote-dispatch",
        }),
      ],
      isLoggedIn: () => true,
      isRunning: () => false,
      isActionAvailable: () => false,
      register: (command) => registered.push(command),
      remove: vi.fn(),
      run: vi.fn(),
    });

    expect(registered[0]?.checkCallback(true)).toBe(false);
  });
});
