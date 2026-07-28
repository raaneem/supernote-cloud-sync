import type { TranscriptionEngine } from "../ocr/configuration";
import type {
  DesktopAgentBinary,
  DesktopBinaryStatus,
} from "../shared/desktop-command";
import type { PerformanceDiagnosticRecord } from "./performance-diagnostics";
import type { SetupPrerequisite } from "./setup";

export type LastSyncOutcome = "never" | "succeeded" | "failed";

export interface DiagnosticsPaths {
  vault: string;
  transcriptionCommand: string;
  temporaryBatches: readonly string[];
}

export interface DiagnosticsReportInput {
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  architecture: string;
  mode: "desktop" | "mobile";
  engine: TranscriptionEngine;
  sessionActive: boolean;
  apiKeySet: boolean;
  agentStatuses: Record<DesktopAgentBinary, DesktopBinaryStatus>;
  prerequisites: readonly SetupPrerequisite[];
  mirroredFileCount: number;
  lastSyncOutcome: LastSyncOutcome;
  performance?: readonly PerformanceDiagnosticRecord[];
  homeDirectory: string | null;
  paths: DiagnosticsPaths;
}

const escapedRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const containsAbsolutePath = (value: string, platform: string): boolean =>
  platform === "win32"
    ? /(?:[A-Za-z]:[\\/]|\\\\)/.test(value)
    : /(^|[\s"'=])\//.test(value);

export const homeRelativePath = (
  value: string,
  homeDirectory: string | null,
  platform: string,
): string => {
  const home = homeDirectory?.replace(/[\\/]+$/g, "");
  if (!home) {
    return containsAbsolutePath(value, platform)
      ? "[absolute path omitted]"
      : value;
  }
  const replacement = platform === "win32" ? "%USERPROFILE%" : "~";
  const relative = value.replace(
    new RegExp(
      `${escapedRegExp(home)}(?=$|[\\\\/])`,
      platform === "win32" ? "gi" : "g",
    ),
    replacement,
  );
  return containsAbsolutePath(relative, platform)
    ? "[absolute path outside home omitted]"
    : relative;
};

const agentDiagnostics = (
  engine: DesktopAgentBinary,
  status: DesktopBinaryStatus,
  input: DiagnosticsReportInput,
): string[] => {
  if (status.state === "available") {
    return [
      `${engine}.resolution: available (${homeRelativePath(
        status.path,
        input.homeDirectory,
        input.platform,
      )})`,
      `${engine}.verification: passed`,
    ];
  }
  if (status.state === "unavailable") {
    return status.reason === "not-executable"
      ? [
          `${engine}.resolution: found but not executable`,
          `${engine}.verification: failed`,
        ]
      : [`${engine}.resolution: not found`, `${engine}.verification: not run`];
  }
  return [
    `${engine}.resolution: ${status.state}`,
    `${engine}.verification: not run`,
  ];
};

export const renderDiagnosticsReport = (
  input: DiagnosticsReportInput,
): string => {
  const prerequisiteLabel = (prerequisite: SetupPrerequisite): string =>
    prerequisite.id === "send-to-supernote" ? "pairedFolder" : prerequisite.id;
  const prerequisiteState = (prerequisite: SetupPrerequisite): string =>
    prerequisite.id === "send-to-supernote"
      ? prerequisite.state === "optional"
        ? "disabled"
        : prerequisite.state === "satisfied"
          ? "enabled-configured"
          : "enabled-unconfigured"
      : prerequisite.state;
  const lines = [
    "Supernote Cloud Sync diagnostics",
    `plugin: ${input.pluginVersion}`,
    `obsidian: ${input.obsidianVersion}`,
    `platform: ${input.platform} (${input.architecture}, ${input.mode})`,
    `engine: ${input.engine}`,
    `session: ${input.sessionActive ? "active" : "none"}`,
    `apiKey: ${input.apiKeySet ? "set" : "unset"}`,
    "",
    "prerequisites:",
    ...input.prerequisites.map(
      (prerequisite) =>
        `  ${prerequisiteLabel(prerequisite)}: ${prerequisiteState(prerequisite)}`,
    ),
    "",
    "agents:",
    ...agentDiagnostics("claude", input.agentStatuses.claude, input).map(
      (line) => `  ${line}`,
    ),
    ...agentDiagnostics("codex", input.agentStatuses.codex, input).map(
      (line) => `  ${line}`,
    ),
    "",
    `mirroredFiles: ${input.mirroredFileCount}`,
    `lastSync: ${input.lastSyncOutcome}`,
    "",
    "performance:",
    ...(input.performance?.length
      ? input.performance.map(
          (record) =>
            `  ${record.kind}: ${record.outcome}, duration=${record.durationMs}ms, peak=${record.peakTrackedBytes ?? "unknown"}, settled=${record.settledTrackedBytes ?? "unknown"}, cleanup=${record.cleanup}, failure=${record.failureCategory ?? "none"}`,
        )
      : ["  recent: none"]),
    "",
    "paths:",
    `  vault: ${homeRelativePath(
      input.paths.vault,
      input.homeDirectory,
      input.platform,
    )}`,
    `  transcriptionCommand: ${
      input.paths.transcriptionCommand
        ? homeRelativePath(
            input.paths.transcriptionCommand,
            input.homeDirectory,
            input.platform,
          )
        : "not configured"
    }`,
    ...(input.paths.temporaryBatches.length > 0
      ? input.paths.temporaryBatches.map(
          (path, index) =>
            `  temporaryBatch${index + 1}: ${homeRelativePath(
              path,
              input.homeDirectory,
              input.platform,
            )}`,
        )
      : ["  temporaryBatches: none"]),
  ];
  return `${lines.join("\n")}\n`;
};
