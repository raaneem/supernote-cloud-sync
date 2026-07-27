import type { SyncManifest } from "./manifest";
import type { WatchHookDefinition } from "./watch-hooks";

export interface MirrorMoveInput {
  source: string;
  destination: string;
  manifest: SyncManifest;
  automations: readonly WatchHookDefinition[];
  missingCloudNotes: readonly string[];
}

export interface RewrittenMirrorState {
  targetFolder: string;
  manifest: SyncManifest;
  automations: WatchHookDefinition[];
  missingCloudNotes: string[];
}

export interface MirrorMoveOperations {
  preflight(source: string, destination: string): Promise<void>;
  moveFolder(source: string, destination: string): Promise<void>;
  writeManifest(path: string, manifest: SyncManifest): Promise<void>;
  saveState(state: RewrittenMirrorState): Promise<void>;
  rollbackFolder(destination: string, source: string): Promise<void>;
  restoreDestination(destination: string): Promise<void>;
}

const normalized = (path: string): string => path.replace(/^\/+|\/+$/g, "");

const rewritePath = (
  path: string,
  source: string,
  destination: string,
): string => {
  const value = normalized(path);
  const from = normalized(source);
  const to = normalized(destination);
  if (value === from) {
    return to;
  }
  return value.startsWith(`${from}/`)
    ? `${to}${value.slice(from.length)}`
    : value;
};

export const rewriteMirrorReferences = (
  input: MirrorMoveInput,
): RewrittenMirrorState => {
  const files = Object.fromEntries(
    Object.entries(input.manifest.files).map(([id, entry]) => [
      id,
      {
        ...entry,
        vaultPath: rewritePath(
          entry.vaultPath,
          input.source,
          input.destination,
        ),
      },
    ]),
  );
  return {
    targetFolder: normalized(input.destination),
    manifest: {
      ...input.manifest,
      files,
    },
    automations: input.automations.map((automation) => ({
      ...automation,
      sourceNote: rewritePath(
        automation.sourceNote,
        input.source,
        input.destination,
      ),
    })),
    missingCloudNotes: input.missingCloudNotes.map((path) =>
      rewritePath(path, input.source, input.destination),
    ),
  };
};

const validateDestination = (source: string, destination: string): void => {
  const from = normalized(source);
  const to = normalized(destination);
  if (!from || !to) {
    throw new Error("Mirror source and destination are required");
  }
  if (from === to) {
    throw new Error("Choose a different Mirror destination");
  }
  if (to.startsWith(`${from}/`)) {
    throw new Error("The new Mirror cannot be inside the current Mirror");
  }
};

export const moveMirrorTransaction = async (
  input: MirrorMoveInput,
  operations: MirrorMoveOperations,
): Promise<RewrittenMirrorState> => {
  validateDestination(input.source, input.destination);
  await operations.preflight(input.source, input.destination);
  const state = rewriteMirrorReferences(input);
  let moved = false;
  try {
    await operations.moveFolder(input.source, input.destination);
    moved = true;
    await operations.writeManifest(
      `${state.targetFolder}/.sync-manifest.json`,
      state.manifest,
    );
    await operations.saveState(state);
    return state;
  } catch (error) {
    if (moved) {
      try {
        await operations.rollbackFolder(input.destination, input.source);
        await operations.writeManifest(
          `${normalized(input.source)}/.sync-manifest.json`,
          input.manifest,
        );
        await operations.restoreDestination(input.destination);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Mirror move and rollback both failed",
        );
      }
    }
    throw error;
  }
};
