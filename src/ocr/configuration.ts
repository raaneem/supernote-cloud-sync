export type TranscriptionEngine = "claude" | "codex" | "api" | "command";

export interface TranscriptionSelection {
  engine: TranscriptionEngine;
  model: string;
}

export interface TranscriptionEngineOption {
  engine: TranscriptionEngine;
  label: string;
  model: string;
}

export const effectiveTranscriptionEngine = (
  configured: TranscriptionEngine,
  isDesktop: boolean,
): TranscriptionEngine => (isDesktop ? configured : "api");

export const defaultModelForEngine = (
  engine: TranscriptionEngine,
  models: {
    claude: string;
    codex: string;
    api: string;
  },
): string =>
  engine === "claude"
    ? models.claude
    : engine === "codex"
      ? models.codex
      : engine === "api"
        ? models.api
        : "";

export const effectiveTranscriptionSelection = (
  requested: TranscriptionSelection,
  isDesktop: boolean,
  models: {
    claude: string;
    codex: string;
    api: string;
  },
): TranscriptionSelection => {
  const engine = effectiveTranscriptionEngine(requested.engine, isDesktop);
  return {
    engine,
    model:
      engine === requested.engine
        ? requested.model
        : defaultModelForEngine(engine, models),
  };
};
