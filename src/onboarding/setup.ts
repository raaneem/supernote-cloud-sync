import type { TranscriptionEngine } from "../ocr/configuration";
import type {
  DesktopAgentBinary,
  DesktopBinaryStatus,
} from "../shared/desktop-command";

export type SetupPrerequisiteId =
  | "account"
  | "mirror"
  | "send-to-supernote"
  | "transcription";

export type SetupPrerequisiteState = "satisfied" | "missing" | "optional";

export interface SetupPrerequisite {
  id: SetupPrerequisiteId;
  state: SetupPrerequisiteState;
  detail: string;
}

export interface SetupSnapshot {
  sessionActive: boolean;
  mirrorFolder: string;
  mirrorFolderWritable: boolean;
  sendToSupernote: {
    enabled: boolean;
    folder: string;
  };
  engine: TranscriptionEngine;
  apiKeySet: boolean;
  commandConfigured: boolean;
  isDesktop: boolean;
  agentStatuses: Record<DesktopAgentBinary, DesktopBinaryStatus>;
}

export interface WritableFolderProbe {
  writeText(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export const verifyWritableFolder = async (
  vault: WritableFolderProbe,
  folder: string,
  markerName: string,
): Promise<void> => {
  const markerPath = `${folder}/${markerName}`;
  try {
    await vault.writeText(markerPath, "");
    await vault.delete(markerPath);
  } catch (error) {
    await vault.delete(markerPath).catch(() => undefined);
    throw error;
  }
};

const agentLabel = (engine: DesktopAgentBinary): string =>
  engine === "claude" ? "Claude Code" : "Codex CLI";

export const agentSetupDetail = (
  engine: DesktopAgentBinary,
  status: DesktopBinaryStatus,
): string => {
  const label = agentLabel(engine);
  if (status.state === "available") {
    return `${label} verified at ${status.path}.`;
  }
  if (status.state === "checking") {
    return `Checking ${label} availability…`;
  }
  if (status.state === "unavailable") {
    return status.reason === "not-executable"
      ? `${label} was found but could not execute --version.`
      : `${label} is not on PATH and no usable path override is set.`;
  }
  return `${label} has not been detected yet.`;
};

export const agentTestResultDetail = (
  engine: DesktopAgentBinary,
  status: DesktopBinaryStatus,
): string =>
  status.state === "available"
    ? `${agentLabel(engine)} passed the --version test.`
    : status.state === "unavailable" && status.reason === "not-executable"
      ? `${agentLabel(engine)} was found but could not execute --version.`
      : status.state === "unavailable"
        ? `${agentLabel(engine)} was not found at the draft path or on PATH.`
        : `${agentLabel(engine)} could not be tested yet.`;

const transcriptionPrerequisite = (
  snapshot: SetupSnapshot,
): SetupPrerequisite => {
  if (snapshot.engine === "api") {
    return snapshot.apiKeySet
      ? {
          id: "transcription",
          state: "satisfied",
          detail: "OpenAI-compatible API key is configured.",
        }
      : {
          id: "transcription",
          state: "missing",
          detail: "Add an API key for the selected transcription engine.",
        };
  }
  if (snapshot.engine === "command") {
    return snapshot.isDesktop && snapshot.commandConfigured
      ? {
          id: "transcription",
          state: "satisfied",
          detail: "Custom transcription command is configured.",
        }
      : {
          id: "transcription",
          state: "missing",
          detail: "Add a command for the selected transcription engine.",
        };
  }
  const status = snapshot.agentStatuses[snapshot.engine];
  return status.state === "available"
    ? {
        id: "transcription",
        state: "satisfied",
        detail: `${agentLabel(snapshot.engine)} is ready.`,
      }
    : {
        id: "transcription",
        state: "missing",
        detail: `${agentLabel(snapshot.engine)} is selected but its CLI is not verified.`,
      };
};

export const setupPrerequisites = (
  snapshot: SetupSnapshot,
): SetupPrerequisite[] => {
  return [
    snapshot.sessionActive
      ? {
          id: "account",
          state: "satisfied",
          detail: "Supernote Cloud session is active.",
        }
      : {
          id: "account",
          state: "missing",
          detail: "Sign in to Supernote Cloud.",
        },
    snapshot.mirrorFolder.trim() && snapshot.mirrorFolderWritable
      ? {
          id: "mirror",
          state: "satisfied",
          detail: `Mirror folder: ${snapshot.mirrorFolder}.`,
        }
      : {
          id: "mirror",
          state: "missing",
          detail: "Choose an existing vault folder Obsidian can update.",
        },
    !snapshot.sendToSupernote.enabled
      ? {
          id: "send-to-supernote",
          state: "optional",
          detail: "Optional — Paired folder is disabled.",
        }
      : snapshot.sendToSupernote.folder.trim()
        ? {
            id: "send-to-supernote",
            state: "satisfied",
            detail: `Paired folder: ${snapshot.sendToSupernote.folder}.`,
          }
        : {
            id: "send-to-supernote",
            state: "missing",
            detail: "Choose the Paired folder.",
          },
    transcriptionPrerequisite(snapshot),
  ];
};

export interface SetupReadiness {
  ready: boolean;
  missingCount: number;
  firstBlocker: SetupPrerequisite | null;
}

export const setupReadiness = (
  prerequisites: readonly SetupPrerequisite[],
): SetupReadiness => {
  const missing = prerequisites.filter(
    (prerequisite) => prerequisite.state === "missing",
  );
  return {
    ready: missing.length === 0,
    missingCount: missing.length,
    firstBlocker: missing[0] ?? null,
  };
};

export const shouldShowSetupNotice = ({
  sessionActive,
  noticeShown,
}: {
  sessionActive: boolean;
  noticeShown: boolean;
}): boolean => !sessionActive && !noticeShown;
