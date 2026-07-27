import {
  getWatchHookConfigurationWarning,
  getWatchHookRetentionWarning,
  type WatchHookDefinition,
} from "../sync/watch-hooks";
import { normalizeOptionalRelativePath } from "../shared/path";

export interface AutomationDraftErrors {
  name?: string;
  sourceNote?: string;
  action?: string;
  keepFolder?: string;
}

export const automationDraftErrors = (
  draft: WatchHookDefinition,
  automations: readonly WatchHookDefinition[],
  targetFolder = "",
): AutomationDraftErrors => {
  const errors: AutomationDraftErrors = {};
  const name = draft.name.trim();
  if (!name) {
    errors.name = "Add an Automation name.";
  } else if (
    automations.some(
      (automation) =>
        automation.id !== draft.id &&
        automation.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    errors.name = "Another Automation already uses this name.";
  }
  if (!draft.sourceNote.trim()) {
    errors.sourceNote = "Choose a source notebook.";
  } else {
    try {
      normalizeOptionalRelativePath(draft.sourceNote);
    } catch {
      errors.sourceNote = "Choose a notebook inside the Mirror.";
    }
  }
  const actionWarning = getWatchHookConfigurationWarning(draft);
  if (actionWarning) {
    errors.action = actionWarning;
  }
  try {
    normalizeOptionalRelativePath(draft.keepFolder);
    const retentionWarning = getWatchHookRetentionWarning(draft, targetFolder);
    if (retentionWarning) {
      errors.keepFolder = retentionWarning;
    }
  } catch {
    errors.keepFolder = "Choose a folder inside the vault.";
  }
  return errors;
};

const normalizeAutomationDraft = (
  draft: WatchHookDefinition,
): WatchHookDefinition => {
  const action = draft.action ?? "command";
  return {
    ...draft,
    name: draft.name.trim(),
    sourceNote: normalizeOptionalRelativePath(draft.sourceNote),
    format: action === "command" ? draft.format : "images",
    action,
    command: action === "command" ? draft.command.trim() : "",
    prompt: draft.prompt.trim(),
    model: draft.model.trim(),
    claudeAllowedTools: draft.claudeAllowedTools.trim(),
    keepFolder: normalizeOptionalRelativePath(draft.keepFolder),
  };
};

export const upsertAutomationDraft = (
  automations: readonly WatchHookDefinition[],
  draft: WatchHookDefinition,
): WatchHookDefinition[] => {
  const normalized = normalizeAutomationDraft(draft);
  const existingIndex = automations.findIndex(
    (automation) => automation.id === draft.id,
  );
  if (existingIndex < 0) {
    return [...automations, normalized];
  }
  return automations.map((automation, index) =>
    index === existingIndex ? normalized : automation,
  );
};

export interface AutomationListItem {
  automation: WatchHookDefinition;
  blockingReason: string | null;
}

export const sortAutomationList = (
  automations: readonly WatchHookDefinition[],
  blockingReason: (automation: WatchHookDefinition) => string | null,
): AutomationListItem[] =>
  automations
    .map((automation) => ({
      automation,
      blockingReason: blockingReason(automation),
    }))
    .sort((left, right) => {
      const blocked =
        Number(Boolean(right.blockingReason)) -
        Number(Boolean(left.blockingReason));
      return (
        blocked ||
        left.automation.name
          .trim()
          .localeCompare(right.automation.name.trim(), undefined, {
            sensitivity: "base",
          })
      );
    });
