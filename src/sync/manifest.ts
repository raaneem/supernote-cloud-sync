import type { VaultStore } from "./vault-store";

export type ExportFormat =
  | "markdown"
  | "pdf"
  | "images"
  | "markdown-pdf"
  | "markdown-images"
  | "formatted-markdown"
  | "formatted-markdown-pdf";

export interface LastExport {
  destination: string;
  format: ExportFormat;
}

export interface WatchHookState {
  noteMd5: string;
  pageMd5s: Record<string, string>;
}

export interface SyncManifestFile {
  remoteId: string;
  directoryId: string;
  fileName: string;
  remotePath: string;
  md5: string;
  updateTime: number;
  vaultPath: string;
  syncedAt: string;
  pageCount?: number;
  lastExport?: LastExport;
  watchHooks?: Record<string, WatchHookState>;
}

export interface SyncManifest {
  version: 1;
  files: Record<string, SyncManifestFile>;
}

export const emptyManifest = (): SyncManifest => ({
  version: 1,
  files: {},
});

const serializedManifest = (manifest: SyncManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

interface ManifestOrigin {
  baseline: string;
  generation: number;
  revision: string | null;
}

interface LoadedManifest {
  manifest: SyncManifest;
  migrated: boolean;
}

const manifestOrigins = new WeakMap<SyncManifest, ManifestOrigin>();
const manifestWriteQueues = new WeakMap<
  VaultStore,
  Map<string, Promise<void>>
>();
const manifestGenerations = new WeakMap<VaultStore, Map<string, number>>();

const clone = <Value>(value: Value): Value =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as Value);

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const manifestGeneration = (vault: VaultStore, path: string): number =>
  manifestGenerations.get(vault)?.get(path) ?? 0;

const advanceManifestGeneration = (vault: VaultStore, path: string): number => {
  let paths = manifestGenerations.get(vault);
  if (!paths) {
    paths = new Map();
    manifestGenerations.set(vault, paths);
  }
  const generation = (paths.get(path) ?? 0) + 1;
  paths.set(path, generation);
  return generation;
};

const mergeAtomicState = <State>(
  baseline: State | undefined,
  ours: State | undefined,
  latest: State | undefined,
): State | undefined => {
  if (equal(ours, baseline)) {
    return clone(latest);
  }
  if (equal(latest, baseline)) {
    return clone(ours);
  }
  if (ours === undefined) {
    return clone(latest);
  }
  return clone(ours);
};

const mergeWatchHooks = (
  baseline: Record<string, WatchHookState> | undefined,
  ours: Record<string, WatchHookState> | undefined,
  latest: Record<string, WatchHookState> | undefined,
): Record<string, WatchHookState> | undefined => {
  if (equal(ours, baseline)) {
    return clone(latest);
  }
  if (equal(latest, baseline)) {
    return clone(ours);
  }
  if (!ours) {
    return clone(latest);
  }
  if (!latest) {
    return clone(ours);
  }
  const merged: Record<string, WatchHookState> = {};
  const ids = new Set([
    ...Object.keys(baseline ?? {}),
    ...Object.keys(ours),
    ...Object.keys(latest),
  ]);
  for (const id of ids) {
    const state = mergeAtomicState(baseline?.[id], ours[id], latest[id]);
    if (state) {
      merged[id] = state;
    }
  }
  return merged;
};

const mergeEntry = (
  baseline: SyncManifestFile | undefined,
  ours: SyncManifestFile,
  latest: SyncManifestFile | undefined,
): SyncManifestFile => {
  if (!latest) {
    return clone(ours);
  }
  const merged: Record<string, unknown> = {};
  const baselineRecord = baseline as
    | (SyncManifestFile & Record<string, unknown>)
    | undefined;
  const oursRecord = ours as SyncManifestFile & Record<string, unknown>;
  const latestRecord = latest as
    | (SyncManifestFile & Record<string, unknown>)
    | undefined;
  const keys = new Set([
    ...Object.keys(baselineRecord ?? {}),
    ...Object.keys(oursRecord),
    ...Object.keys(latestRecord ?? {}),
  ]);
  for (const key of keys) {
    const baselineValue = baselineRecord?.[key];
    const oursValue = oursRecord[key];
    const latestValue = latestRecord?.[key];
    const value =
      key === "lastExport"
        ? mergeAtomicState(
            baseline?.lastExport,
            ours.lastExport,
            latest?.lastExport,
          )
        : key === "watchHooks"
          ? mergeWatchHooks(
              baseline?.watchHooks,
              ours.watchHooks,
              latest?.watchHooks,
            )
          : equal(oursValue, baselineValue)
            ? clone(latestValue)
            : clone(oursValue);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as unknown as SyncManifestFile;
};

const matchingEntry = (
  files: Record<string, SyncManifestFile>,
  entry: SyncManifestFile,
): [string, SyncManifestFile] | undefined =>
  Object.entries(files).find(
    ([, candidate]) =>
      candidate.vaultPath === entry.vaultPath ||
      candidate.remotePath === entry.remotePath,
  );

const mergeManifests = (
  baseline: SyncManifest,
  ours: SyncManifest,
  latest: SyncManifest,
): SyncManifest => {
  const files = clone(latest.files);
  const replacedBaselineIds = new Set<string>();

  for (const [id, ourEntry] of Object.entries(ours.files)) {
    if (equal(ourEntry, baseline.files[id])) {
      continue;
    }
    const baselineMatch = baseline.files[id]
      ? ([id, baseline.files[id]] as const)
      : matchingEntry(baseline.files, ourEntry);
    const latestMatch = latest.files[id]
      ? ([id, latest.files[id]] as const)
      : matchingEntry(latest.files, ourEntry);
    if (baselineMatch && baselineMatch[0] !== id) {
      replacedBaselineIds.add(baselineMatch[0]);
      delete files[baselineMatch[0]];
    }
    const merged = mergeEntry(baselineMatch?.[1], ourEntry, latestMatch?.[1]);
    delete files[id];
    if (latestMatch) {
      delete files[latestMatch[0]];
    }
    files[merged.remoteId] = merged;
  }

  for (const [id, baselineEntry] of Object.entries(baseline.files)) {
    if (
      ours.files[id] === undefined &&
      !replacedBaselineIds.has(id) &&
      equal(latest.files[id], baselineEntry)
    ) {
      delete files[id];
    }
  }

  return { version: 1, files };
};

const withManifestWriteLock = async <Result>(
  vault: VaultStore,
  path: string,
  operation: () => Promise<Result>,
): Promise<Result> => {
  let paths = manifestWriteQueues.get(vault);
  if (!paths) {
    paths = new Map();
    manifestWriteQueues.set(vault, paths);
  }
  const previous = paths.get(path) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  paths.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (paths.get(path) === current) {
      paths.delete(path);
    }
  }
};

const readManifest = async (
  vault: VaultStore,
  path: string,
): Promise<LoadedManifest> => {
  const generation = manifestGeneration(vault, path);
  const revision = await vault.getRevision(path);
  const content = await vault.readText(path);
  if (content === null) {
    const manifest = emptyManifest();
    manifestOrigins.set(manifest, {
      baseline: serializedManifest(manifest),
      generation,
      revision,
    });
    return { manifest, migrated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot parse sync manifest at ${path}`, { cause: error });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("files" in parsed) ||
    typeof parsed.files !== "object" ||
    parsed.files === null
  ) {
    throw new Error(`Unsupported sync manifest at ${path}`);
  }

  const manifest = parsed as SyncManifest;
  let removedLegacyCache = false;
  for (const entry of Object.values(manifest.files)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "transcriptionCache" in entry
    ) {
      delete (entry as unknown as Record<string, unknown>).transcriptionCache;
      removedLegacyCache = true;
    }
  }
  manifestOrigins.set(manifest, {
    baseline: removedLegacyCache ? serializedManifest(manifest) : content,
    generation,
    revision,
  });
  return { manifest, migrated: removedLegacyCache };
};

export const loadManifest = async (
  vault: VaultStore,
  path: string,
): Promise<SyncManifest> => {
  const loaded = await readManifest(vault, path);
  if (loaded.migrated) {
    await saveManifest(vault, path, loaded.manifest);
  }
  return loaded.manifest;
};

export async function saveManifest(
  vault: VaultStore,
  path: string,
  manifest: SyncManifest,
): Promise<void> {
  await withManifestWriteLock(vault, path, async () => {
    const origin = manifestOrigins.get(manifest);
    let committed = manifest;
    const revision = await vault.getRevision(path);
    if (
      origin &&
      (revision !== origin.revision ||
        manifestGeneration(vault, path) !== origin.generation)
    ) {
      const latest = await readManifest(vault, path);
      committed = mergeManifests(
        JSON.parse(origin.baseline) as SyncManifest,
        manifest,
        latest.manifest,
      );
    }
    const content = serializedManifest(committed);
    await vault.writeText(path, content);
    const generation = advanceManifestGeneration(vault, path);
    manifest.files = committed.files;
    manifestOrigins.set(manifest, {
      baseline: content,
      generation,
      revision: await vault.getRevision(path),
    });
  });
}

export class SyncManifestTransaction {
  private used = false;

  private constructor(
    private readonly vault: VaultStore,
    private readonly path: string,
    private readonly manifest: SyncManifest,
  ) {}

  static async open(
    vault: VaultStore,
    path: string,
  ): Promise<SyncManifestTransaction> {
    const loaded = await readManifest(vault, path);
    return new SyncManifestTransaction(vault, path, loaded.manifest);
  }

  async run<Result>(
    operation: (manifest: SyncManifest) => Promise<Result>,
  ): Promise<Result> {
    if (this.used) {
      throw new Error("Sync manifest transaction has already completed");
    }
    this.used = true;
    let result: Result;
    try {
      result = await operation(this.manifest);
    } catch (operationError) {
      try {
        await saveManifest(this.vault, this.path, this.manifest);
      } catch (saveError) {
        throw new AggregateError(
          [operationError, saveError],
          "Sync failed and completed manifest entries could not be saved",
        );
      }
      throw operationError;
    }
    await saveManifest(this.vault, this.path, this.manifest);
    return result;
  }
}
