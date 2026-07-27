import type { SupernoteSyncSettings } from "../main";
import type { TranscriptionEngine } from "../ocr/configuration";

export interface TranscriptionDraft {
  engine: TranscriptionEngine;
  claudeModel: string;
  claudeMaxBudgetUsd: number;
  claudePath: string;
  codexModel: string;
  codexPath: string;
  command: string;
  timeoutMinutes: number;
  apiBaseUrl: string;
  apiKey: {
    state: "preserve" | "replace" | "clear";
    replacement: string;
    currentlySet: boolean;
  };
  apiModel: string;
  extraInstructions: string;
}

export type TranscriptionDraftErrors = Partial<
  Record<
    | "engine"
    | "command"
    | "apiBaseUrl"
    | "apiKey"
    | "timeoutMinutes"
    | "claudeMaxBudgetUsd"
    | "save",
    string
  >
>;

export const createTranscriptionDraft = (
  settings: Readonly<SupernoteSyncSettings>,
): TranscriptionDraft => ({
  engine: settings.transcriptionEngine,
  claudeModel: settings.transcriptionClaudeModel,
  claudeMaxBudgetUsd: settings.transcriptionClaudeMaxBudgetUsd,
  claudePath: settings.transcriptionClaudePath,
  codexModel: settings.transcriptionCodexModel,
  codexPath: settings.transcriptionCodexPath,
  command: settings.transcriptionCommand,
  timeoutMinutes: settings.transcriptionTimeoutMinutes,
  apiBaseUrl: settings.transcriptionApiBaseUrl,
  apiKey: {
    state: "preserve",
    replacement: "",
    currentlySet: Boolean(settings.transcriptionApiKey.trim()),
  },
  apiModel: settings.transcriptionApiModel,
  extraInstructions: settings.transcriptionExtraInstructions,
});

const materializedApiKey = (
  draft: TranscriptionDraft,
  current: Readonly<SupernoteSyncSettings>,
): string =>
  draft.apiKey.state === "clear"
    ? ""
    : draft.apiKey.state === "replace"
      ? draft.apiKey.replacement.trim() || current.transcriptionApiKey
      : current.transcriptionApiKey;

export const materializeTranscriptionDraft = (
  draft: TranscriptionDraft,
  current: Readonly<SupernoteSyncSettings>,
): SupernoteSyncSettings => ({
  ...current,
  transcriptionEngine: draft.engine,
  transcriptionClaudeModel: draft.claudeModel.trim(),
  transcriptionClaudeMaxBudgetUsd: draft.claudeMaxBudgetUsd,
  transcriptionClaudePath: draft.claudePath.trim(),
  transcriptionCodexModel: draft.codexModel.trim(),
  transcriptionCodexPath: draft.codexPath.trim(),
  transcriptionCommand: draft.command,
  transcriptionTimeoutMinutes: draft.timeoutMinutes,
  transcriptionApiBaseUrl: draft.apiBaseUrl.trim().replace(/\/+$/, ""),
  transcriptionApiKey: materializedApiKey(draft, current),
  transcriptionApiModel: draft.apiModel.trim(),
  transcriptionExtraInstructions: draft.extraInstructions,
});

export const validateTranscriptionDraft = (
  draft: TranscriptionDraft,
  isDesktop: boolean,
): TranscriptionDraftErrors => {
  const errors: TranscriptionDraftErrors = {};
  if (!isDesktop && draft.engine !== "api") {
    errors.engine = "The OpenAI-compatible API is the only mobile engine.";
  }
  if (draft.engine === "api") {
    if (!draft.apiBaseUrl.trim()) {
      errors.apiBaseUrl = "Add the API base URL.";
    }
    const apiKeyAvailable =
      draft.apiKey.state === "preserve"
        ? draft.apiKey.currentlySet
        : draft.apiKey.state === "replace"
          ? Boolean(
              draft.apiKey.replacement.trim() || draft.apiKey.currentlySet,
            )
          : false;
    if (!apiKeyAvailable) {
      errors.apiKey = "Add an API key for the selected engine.";
    }
  }
  if (draft.engine === "command" && !draft.command.trim()) {
    errors.command = "Add the transcription command.";
  }
  if (
    draft.engine !== "api" &&
    (!Number.isFinite(draft.timeoutMinutes) || draft.timeoutMinutes < 1)
  ) {
    errors.timeoutMinutes = "Use a timeout of at least one minute.";
  }
  if (
    draft.engine === "claude" &&
    (!Number.isFinite(draft.claudeMaxBudgetUsd) || draft.claudeMaxBudgetUsd < 0)
  ) {
    errors.claudeMaxBudgetUsd = "Use a budget of zero or more.";
  }
  return errors;
};

export const transcriptionDraftChanged = (
  draft: TranscriptionDraft,
  current: Readonly<SupernoteSyncSettings>,
): boolean =>
  JSON.stringify(materializeTranscriptionDraft(draft, current)) !==
  JSON.stringify(current);
