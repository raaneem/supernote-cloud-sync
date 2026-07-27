import type { PairBaseline } from "./pair-sync-service";

interface DeviceLocalStorage {
  loadLocalStorage(key: string): unknown | null;
  saveLocalStorage(key: string, value: unknown | null): void;
}

export interface SendDestination {
  directoryId: string;
  remotePath: string;
}

export interface MirrorDirectoryState {
  remotePath: string;
  vaultPath: string;
}

export interface InstanceState {
  version: 1;
  sessionToken: string | null;
  autoSyncMinutes: number;
  runAutomationsOnThisDevice: boolean;
  lastFullSyncAt: string | null;
  pairBaselines: Record<string, PairBaseline>;
  mirrorDirectories: Record<string, MirrorDirectoryState>;
  lastSendDestination: SendDestination | null;
}

export interface LegacyInstanceState {
  sessionToken?: unknown;
  autoSyncMinutes?: unknown;
}

const STORAGE_KEY = "supernote-cloud-sync:instance-state";

export const emptyInstanceState = (): InstanceState => ({
  version: 1,
  sessionToken: null,
  autoSyncMinutes: 0,
  runAutomationsOnThisDevice: false,
  lastFullSyncAt: null,
  pairBaselines: {},
  mirrorDirectories: {},
  lastSendDestination: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasStringFields = (
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean => fields.every((field) => typeof value[field] === "string");

const validPairBaseline = (value: unknown): value is PairBaseline =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.initialized === "boolean" &&
  isRecord(value.entries) &&
  Object.values(value.entries).every(
    (entry) =>
      isRecord(entry) &&
      hasStringFields(entry, [
        "localRelativePath",
        "remoteRelativePath",
        "remoteId",
        "directoryId",
        "fileName",
        "checksum",
      ]),
  ) &&
  (value.directories === undefined || isRecord(value.directories)) &&
  Object.values(value.directories ?? {}).every(
    (directory) =>
      isRecord(directory) &&
      hasStringFields(directory, [
        "localRelativePath",
        "remoteRelativePath",
        "remoteId",
        "directoryId",
        "fileName",
      ]),
  ) &&
  isRecord(value.conflicts) &&
  Object.values(value.conflicts).every(
    (conflict) =>
      isRecord(conflict) &&
      hasStringFields(conflict, [
        "id",
        "kind",
        "localRelativePath",
        "remoteRelativePath",
      ]) &&
      (conflict.localChecksum === null ||
        typeof conflict.localChecksum === "string") &&
      (conflict.remoteChecksum === null ||
        typeof conflict.remoteChecksum === "string"),
  );

const validMirrorDirectory = (value: unknown): value is MirrorDirectoryState =>
  isRecord(value) &&
  typeof value.remotePath === "string" &&
  typeof value.vaultPath === "string";

const parseInstanceState = (value: unknown): InstanceState | null => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.sessionToken !== null && typeof value.sessionToken !== "string") ||
    typeof value.autoSyncMinutes !== "number" ||
    !Number.isFinite(value.autoSyncMinutes) ||
    value.autoSyncMinutes < 0 ||
    typeof value.runAutomationsOnThisDevice !== "boolean" ||
    (value.lastFullSyncAt !== undefined &&
      value.lastFullSyncAt !== null &&
      typeof value.lastFullSyncAt !== "string") ||
    !isRecord(value.pairBaselines) ||
    !Object.values(value.pairBaselines).every(validPairBaseline) ||
    (value.mirrorDirectories !== undefined &&
      (!isRecord(value.mirrorDirectories) ||
        !Object.values(value.mirrorDirectories).every(validMirrorDirectory)))
  ) {
    return null;
  }
  const destination = value.lastSendDestination;
  if (
    destination !== null &&
    (!isRecord(destination) ||
      typeof destination.directoryId !== "string" ||
      typeof destination.remotePath !== "string")
  ) {
    return null;
  }
  const state = JSON.parse(JSON.stringify(value)) as InstanceState;
  state.lastFullSyncAt ??= null;
  state.mirrorDirectories ??= {};
  for (const baseline of Object.values(state.pairBaselines)) {
    baseline.directories ??= {};
  }
  return state;
};

export class InstanceStateStore {
  constructor(
    private readonly storage: DeviceLocalStorage,
    private readonly key = STORAGE_KEY,
  ) {}

  load(legacy: LegacyInstanceState = {}): InstanceState {
    const stored = this.storage.loadLocalStorage(this.key);
    if (stored !== null) {
      return parseInstanceState(stored) ?? emptyInstanceState();
    }

    const state = emptyInstanceState();
    let migrated = false;
    if (typeof legacy.sessionToken === "string" && legacy.sessionToken) {
      state.sessionToken = legacy.sessionToken;
      migrated = true;
    }
    if (
      typeof legacy.autoSyncMinutes === "number" &&
      Number.isFinite(legacy.autoSyncMinutes) &&
      legacy.autoSyncMinutes >= 0
    ) {
      state.autoSyncMinutes = legacy.autoSyncMinutes;
      migrated = true;
    }
    if (migrated) {
      this.save(state);
    }
    return state;
  }

  save(state: InstanceState): void {
    const parsed = parseInstanceState(state);
    if (!parsed) {
      throw new Error("Refusing to save invalid Supernote Instance state");
    }
    this.storage.saveLocalStorage(this.key, parsed);
  }
}
