import { describe, expect, it, vi } from "vitest";

import {
  InstanceStateStore,
  emptyInstanceState,
} from "../src/sync/instance-state";
import { emptyPairBaseline } from "../src/sync/pair-sync-service";

class MemoryLocalStorage {
  value: unknown = null;
  readonly loadLocalStorage = vi.fn(() => this.value);
  readonly saveLocalStorage = vi.fn((_key: string, value: unknown) => {
    this.value = value;
  });
}

describe("InstanceStateStore", () => {
  it("defaults execution and authentication to safe device-local values", () => {
    const storage = new MemoryLocalStorage();

    expect(new InstanceStateStore(storage).load()).toEqual(
      emptyInstanceState(),
    );
  });

  it("round-trips the session, controls, Pair baseline, and last Send destination", () => {
    const storage = new MemoryLocalStorage();
    const store = new InstanceStateStore(storage);
    const state = {
      ...emptyInstanceState(),
      sessionToken: "secret",
      autoSyncMinutes: 30,
      runAutomationsOnThisDevice: true,
      lastSendDestination: {
        directoryId: "destination",
        remotePath: "Document/Shared",
      },
      pairBaselines: {
        pair: {
          ...emptyPairBaseline(),
          initialized: true,
        },
      },
    };

    store.save(state);

    expect(store.load()).toEqual(state);
  });

  it("rebuilds safely when device-local state is corrupt", () => {
    const storage = new MemoryLocalStorage();
    storage.value = {
      version: 1,
      sessionToken: 42,
      autoSyncMinutes: "hourly",
    };

    expect(new InstanceStateStore(storage).load()).toEqual(
      emptyInstanceState(),
    );
  });

  it("migrates legacy synced values only when no local state exists", () => {
    const storage = new MemoryLocalStorage();
    const store = new InstanceStateStore(storage);

    const migrated = store.load({
      sessionToken: "legacy-token",
      autoSyncMinutes: 60,
    });

    expect(migrated).toMatchObject({
      sessionToken: "legacy-token",
      autoSyncMinutes: 60,
      runAutomationsOnThisDevice: false,
    });
    expect(storage.saveLocalStorage).toHaveBeenCalledOnce();

    storage.value = {
      ...emptyInstanceState(),
      sessionToken: "local-token",
      autoSyncMinutes: 5,
    };
    expect(
      store.load({ sessionToken: "ignored", autoSyncMinutes: 90 }),
    ).toMatchObject({
      sessionToken: "local-token",
      autoSyncMinutes: 5,
    });
  });
});
