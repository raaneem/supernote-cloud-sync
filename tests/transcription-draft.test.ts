import { describe, expect, it } from "vitest";

import {
  createTranscriptionDraft,
  materializeTranscriptionDraft,
  validateTranscriptionDraft,
} from "../src/settings-ux/transcription-draft";
import type { SupernoteSyncSettings } from "../src/main";

const settings = (
  update: Partial<SupernoteSyncSettings> = {},
): SupernoteSyncSettings => ({
  targetFolder: "supernote",
  pushFolder: "Document/Obsidian",
  autoSyncMinutes: 0,
  watchHooks: [],
  transcriptionEngine: "api",
  transcriptionClaudeModel: "",
  transcriptionClaudeMaxBudgetUsd: 2,
  transcriptionClaudePath: "",
  transcriptionCodexModel: "",
  transcriptionCodexPath: "",
  transcriptionCommand: "",
  transcriptionTimeoutMinutes: 10,
  transcriptionApiBaseUrl: "https://openrouter.ai/api/v1",
  transcriptionApiKey: "SECRET_SENTINEL",
  transcriptionApiModel: "openai/gpt-4.1-mini",
  transcriptionExtraInstructions: "",
  ...update,
});

describe("Transcription draft", () => {
  it("represents a saved API key as state without copying its value", () => {
    const draft = createTranscriptionDraft(settings());

    expect(draft.apiKey).toEqual({
      state: "preserve",
      replacement: "",
      currentlySet: true,
    });
    expect(JSON.stringify(draft)).not.toContain("SECRET_SENTINEL");
  });

  it("preserves, replaces, or clears the saved API key explicitly", () => {
    const current = settings();
    const draft = createTranscriptionDraft(current);

    expect(
      materializeTranscriptionDraft(draft, current).transcriptionApiKey,
    ).toBe("SECRET_SENTINEL");
    expect(
      materializeTranscriptionDraft(
        {
          ...draft,
          apiKey: {
            ...draft.apiKey,
            state: "replace",
            replacement: " NEW_KEY ",
          },
        },
        current,
      ).transcriptionApiKey,
    ).toBe("NEW_KEY");
    expect(
      materializeTranscriptionDraft(
        {
          ...draft,
          apiKey: {
            ...draft.apiKey,
            state: "replace",
            replacement: "",
          },
        },
        current,
      ).transcriptionApiKey,
    ).toBe("SECRET_SENTINEL");
    expect(
      materializeTranscriptionDraft(
        {
          ...draft,
          apiKey: {
            ...draft.apiKey,
            state: "clear",
          },
        },
        current,
      ).transcriptionApiKey,
    ).toBe("");
  });

  it("validates only fields required by the selected engine", () => {
    const current = settings({ transcriptionApiKey: "" });
    const api = createTranscriptionDraft(current);
    const command = {
      ...api,
      engine: "command" as const,
      command: "",
    };

    expect(validateTranscriptionDraft(api, false)).toEqual({
      apiKey: "Add an API key for the selected engine.",
    });
    expect(validateTranscriptionDraft(command, true)).toEqual({
      command: "Add the transcription command.",
    });
    expect(
      validateTranscriptionDraft(
        { ...command, command: "transcribe {{folder}}" },
        true,
      ),
    ).toEqual({});
  });
});
