import {
  getWatchHookConfigurationWarning,
  type WatchHookDefinition,
  type WatchHookRunResult,
} from "./watch-hooks";

export const DEFAULT_CLAUDE_AUTOMATION_TOOLS = "Read,Write,Glob,Bash";

interface AutomationCommand {
  id: string;
  name: string;
  checkCallback(checking: boolean): boolean;
}

interface RefreshAutomationCommandsOptions {
  commandIds: readonly string[];
  getHooks: () => readonly WatchHookDefinition[];
  targetFolder?: () => string;
  isLoggedIn: () => boolean;
  isRunning: () => boolean;
  isActionAvailable: (hook: WatchHookDefinition) => boolean;
  register: (command: AutomationCommand) => void;
  remove: (commandId: string) => void;
  run: (hookId: string) => void;
}

export const createWatchHook = (
  hooks: readonly WatchHookDefinition[],
  sourceNote: string,
  id: string,
): WatchHookDefinition => ({
  id,
  name: `Automation ${hooks.length + 1}`,
  sourceNote,
  format: "images",
  action: "command",
  command: "",
  prompt: "",
  model: "",
  claudeAllowedTools: DEFAULT_CLAUDE_AUTOMATION_TOOLS,
  codexSandbox: "workspace-write",
  keepFolder: "",
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringField = (value: Record<string, unknown>, field: string): string =>
  typeof value[field] === "string" ? value[field] : "";

export const normalizeWatchHooks = (value: unknown): WatchHookDefinition[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const hook = asRecord(entry);
    if (!hook) {
      return [];
    }
    const id = stringField(hook, "id");
    if (!id) {
      return [];
    }
    const action =
      hook.action === "claude" || hook.action === "codex"
        ? hook.action
        : "command";
    const codexSandbox =
      hook.codexSandbox === "read-only" ||
      hook.codexSandbox === "danger-full-access"
        ? hook.codexSandbox
        : "workspace-write";
    return [
      {
        id,
        name: stringField(hook, "name"),
        sourceNote: stringField(hook, "sourceNote"),
        format:
          action === "command" && hook.format === "markdown"
            ? "markdown"
            : "images",
        action,
        command: action === "command" ? stringField(hook, "command") : "",
        prompt: stringField(hook, "prompt"),
        model: stringField(hook, "model"),
        claudeAllowedTools:
          typeof hook.claudeAllowedTools === "string"
            ? hook.claudeAllowedTools
            : DEFAULT_CLAUDE_AUTOMATION_TOOLS,
        codexSandbox,
        keepFolder: stringField(hook, "keepFolder"),
      },
    ];
  });
};

export const updateWatchHooks = (
  hooks: readonly WatchHookDefinition[],
  id: string,
  update: Partial<Omit<WatchHookDefinition, "id">>,
): WatchHookDefinition[] =>
  hooks.map((hook) =>
    hook.id === id
      ? update.action && update.action !== "command"
        ? {
            ...hook,
            ...update,
            format: "images",
            command: "",
          }
        : { ...hook, ...update }
      : hook,
  );

export const removeWatchHook = (
  hooks: readonly WatchHookDefinition[],
  id: string,
): WatchHookDefinition[] => hooks.filter((hook) => hook.id !== id);

export const automationResultNotice = (
  hook: Pick<WatchHookDefinition, "name">,
  result: WatchHookRunResult,
  manual: boolean,
): string | null => {
  if (result.status === "delivered") {
    return `Automation "${hook.name}" delivered ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}.`;
  }
  if (result.status === "persisted") {
    return `Automation "${hook.name}" saved ${result.pages.length} page${result.pages.length === 1 ? "" : "s"} to ${result.batchPath}.`;
  }
  if (manual && result.status === "unchanged") {
    return `Automation "${hook.name}": no new or changed pages.`;
  }
  return null;
};

export const refreshAutomationCommands = (
  options: RefreshAutomationCommandsOptions,
): string[] => {
  for (const commandId of options.commandIds) {
    options.remove(commandId);
  }

  return options.getHooks().map((hook) => {
    const commandId = `run-watch-hook-${hook.id}`;
    options.register({
      id: commandId,
      name: `Run automation: ${hook.name}`,
      checkCallback: (checking) => {
        const current = options
          .getHooks()
          .find((candidate) => candidate.id === hook.id);
        if (
          !current ||
          !options.isLoggedIn() ||
          options.isRunning() ||
          !options.isActionAvailable(current) ||
          getWatchHookConfigurationWarning(current, options.targetFolder?.())
        ) {
          return false;
        }
        if (!checking) {
          options.run(current.id);
        }
        return true;
      },
    });
    return commandId;
  });
};
