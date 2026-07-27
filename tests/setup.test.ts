import { describe, expect, it } from "vitest";

import {
  agentSetupDetail,
  agentTestResultDetail,
  setupPrerequisites,
  setupReadiness,
  shouldShowSetupNotice,
  verifyWritableFolder,
} from "../src/onboarding/setup";

describe("setup prerequisites", () => {
  it("explains every applicable prerequisite in an unconfigured vault", () => {
    expect(
      setupPrerequisites({
        sessionActive: false,
        mirrorFolder: "supernote",
        mirrorFolderWritable: false,
        sendToSupernote: {
          enabled: false,
          folder: "Document/Obsidian",
        },
        engine: "claude",
        apiKeySet: false,
        commandConfigured: false,
        isDesktop: true,
        agentStatuses: {
          claude: { state: "unknown" },
          codex: { state: "unknown" },
        },
      }),
    ).toEqual([
      {
        id: "account",
        state: "missing",
        detail: "Sign in to Supernote Cloud.",
      },
      {
        id: "mirror",
        state: "missing",
        detail: "Choose an existing vault folder Obsidian can update.",
      },
      {
        id: "send-to-supernote",
        state: "optional",
        detail: "Optional — Paired folder is disabled.",
      },
      {
        id: "transcription",
        state: "missing",
        detail: "Claude Code is selected but its CLI is not verified.",
      },
    ]);
  });

  it("omits process-surface prerequisites on mobile", () => {
    const rows = setupPrerequisites({
      sessionActive: true,
      mirrorFolder: "supernote",
      mirrorFolderWritable: true,
      sendToSupernote: {
        enabled: true,
        folder: "Document/Obsidian",
      },
      engine: "api",
      apiKeySet: true,
      commandConfigured: false,
      isDesktop: false,
      agentStatuses: {
        claude: { state: "available", path: "/usr/bin/claude" },
        codex: { state: "available", path: "/usr/bin/codex" },
      },
    });

    expect(rows.map((row) => row.id)).toEqual([
      "account",
      "mirror",
      "send-to-supernote",
      "transcription",
    ]);
    expect(rows.every((row) => row.state === "satisfied")).toBe(true);
  });

  it("reports partial and complete desktop configurations live", () => {
    const partial = setupPrerequisites({
      sessionActive: true,
      mirrorFolder: "supernote",
      mirrorFolderWritable: false,
      sendToSupernote: {
        enabled: true,
        folder: "Document/Obsidian",
      },
      engine: "codex",
      apiKeySet: false,
      commandConfigured: false,
      isDesktop: true,
      agentStatuses: {
        claude: { state: "unknown" },
        codex: { state: "unavailable", reason: "not-executable" },
      },
    });
    expect(partial.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "account", state: "satisfied" },
      { id: "mirror", state: "missing" },
      { id: "send-to-supernote", state: "satisfied" },
      { id: "transcription", state: "missing" },
    ]);

    const complete = setupPrerequisites({
      sessionActive: true,
      mirrorFolder: "supernote",
      mirrorFolderWritable: true,
      sendToSupernote: {
        enabled: true,
        folder: "Document/Obsidian",
      },
      engine: "codex",
      apiKeySet: false,
      commandConfigured: false,
      isDesktop: true,
      agentStatuses: {
        claude: { state: "unknown" },
        codex: {
          state: "available",
          path: "/usr/local/bin/codex",
        },
      },
    });
    expect(complete.every((row) => row.state === "satisfied")).toBe(true);
  });

  it("requires a folder only after the Paired folder is enabled", () => {
    const common = {
      sessionActive: true,
      mirrorFolder: "supernote",
      mirrorFolderWritable: true,
      engine: "api" as const,
      apiKeySet: true,
      commandConfigured: false,
      isDesktop: false,
      agentStatuses: {
        claude: { state: "unknown" as const },
        codex: { state: "unknown" as const },
      },
    };

    const disabled = setupPrerequisites({
      ...common,
      sendToSupernote: { enabled: false, folder: "" },
    });
    const enabledWithoutFolder = setupPrerequisites({
      ...common,
      sendToSupernote: { enabled: true, folder: "" },
    });

    expect(disabled.find((row) => row.id === "send-to-supernote")).toEqual({
      id: "send-to-supernote",
      state: "optional",
      detail: "Optional — Paired folder is disabled.",
    });
    expect(
      enabledWithoutFolder.find((row) => row.id === "send-to-supernote"),
    ).toEqual({
      id: "send-to-supernote",
      state: "missing",
      detail: "Choose the Paired folder.",
    });
  });

  it("summarizes readiness with the first exact blocker", () => {
    const rows = setupPrerequisites({
      sessionActive: true,
      mirrorFolder: "supernote",
      mirrorFolderWritable: false,
      sendToSupernote: { enabled: false, folder: "" },
      engine: "api",
      apiKeySet: false,
      commandConfigured: false,
      isDesktop: false,
      agentStatuses: {
        claude: { state: "unknown" },
        codex: { state: "unknown" },
      },
    });

    expect(setupReadiness(rows)).toEqual({
      ready: false,
      missingCount: 2,
      firstBlocker: {
        id: "mirror",
        state: "missing",
        detail: "Choose an existing vault folder Obsidian can update.",
      },
    });
  });
});

describe("agent CLI setup", () => {
  it("distinguishes a missing binary from one that cannot execute", () => {
    expect(
      agentSetupDetail("claude", {
        state: "unavailable",
        reason: "not-found",
      }),
    ).toBe("Claude Code is not on PATH and no usable path override is set.");
    expect(
      agentSetupDetail("claude", {
        state: "unavailable",
        reason: "not-executable",
      }),
    ).toBe("Claude Code was found but could not execute --version.");
  });

  it("reports the real verification result", () => {
    expect(
      agentTestResultDetail("codex", {
        state: "available",
        path: "/usr/local/bin/codex",
      }),
    ).toBe("Codex CLI passed the --version test.");
    expect(
      agentTestResultDetail("codex", {
        state: "unavailable",
        reason: "not-executable",
      }),
    ).toBe("Codex CLI was found but could not execute --version.");
    expect(
      agentTestResultDetail("codex", {
        state: "unavailable",
        reason: "not-found",
      }),
    ).toBe("Codex CLI was not found at the draft path or on PATH.");
  });
});

describe("first-run setup notice", () => {
  it("appears once only when no cloud session exists", () => {
    expect(
      shouldShowSetupNotice({
        sessionActive: false,
        noticeShown: false,
      }),
    ).toBe(true);
    expect(
      shouldShowSetupNotice({
        sessionActive: false,
        noticeShown: true,
      }),
    ).toBe(false);
    expect(
      shouldShowSetupNotice({
        sessionActive: true,
        noticeShown: false,
      }),
    ).toBe(false);
  });
});

describe("mirror folder verification", () => {
  it("proves writability with a temporary file and removes it", async () => {
    const calls: string[] = [];

    await verifyWritableFolder(
      {
        writeText: async (path) => {
          calls.push(`write:${path}`);
        },
        delete: async (path) => {
          calls.push(`delete:${path}`);
        },
      },
      "supernote",
      ".supernote-write-check-test",
    );

    expect(calls).toEqual([
      "write:supernote/.supernote-write-check-test",
      "delete:supernote/.supernote-write-check-test",
    ]);
  });

  it("attempts cleanup when the writability probe fails", async () => {
    const deleted: string[] = [];

    await expect(
      verifyWritableFolder(
        {
          writeText: async () => {
            throw new Error("read-only");
          },
          delete: async (path) => {
            deleted.push(path);
          },
        },
        "supernote",
        ".supernote-write-check-test",
      ),
    ).rejects.toThrow("read-only");

    expect(deleted).toEqual(["supernote/.supernote-write-check-test"]);
  });
});
