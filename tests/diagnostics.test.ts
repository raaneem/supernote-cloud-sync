import { describe, expect, it } from "vitest";

import {
  homeRelativePath,
  renderDiagnosticsReport,
} from "../src/onboarding/diagnostics";

const prerequisites = [
  {
    id: "account" as const,
    state: "satisfied" as const,
    detail: "Supernote Cloud session is active.",
  },
  {
    id: "mirror" as const,
    state: "satisfied" as const,
    detail: "Mirror folder: supernote.",
  },
  {
    id: "send-to-supernote" as const,
    state: "optional" as const,
    detail: "Optional.",
  },
  {
    id: "transcription" as const,
    state: "satisfied" as const,
    detail: "Claude Code is ready.",
  },
];

describe("diagnostics report", () => {
  it("renders an allowlisted Windows report with home-relative paths", () => {
    const report = renderDiagnosticsReport({
      pluginVersion: "0.1.0",
      obsidianVersion: "1.9.12",
      platform: "win32",
      architecture: "x64",
      mode: "desktop",
      engine: "claude",
      sessionActive: true,
      apiKeySet: true,
      agentStatuses: {
        claude: {
          state: "available",
          path: "C:\\Users\\Alice\\AppData\\Roaming\\npm\\claude.cmd",
        },
        codex: {
          state: "unavailable",
          reason: "not-executable",
        },
      },
      prerequisites,
      mirroredFileCount: 12,
      lastSyncOutcome: "succeeded",
      homeDirectory: "C:\\Users\\Alice",
      paths: {
        vault: "C:\\Users\\Alice\\Notes",
        transcriptionCommand:
          'C:\\Users\\Alice\\tools\\transcribe.cmd "{{folder}}"',
        temporaryBatches: [
          "C:\\Users\\Alice\\AppData\\Local\\Temp\\supernote-123",
        ],
      },
    });

    expect(report).toContain("platform: win32 (x64, desktop)");
    expect(report).toContain(
      "claude.resolution: available (%USERPROFILE%\\AppData\\Roaming\\npm\\claude.cmd)",
    );
    expect(report).toContain("claude.verification: passed");
    expect(report).toContain("codex.verification: failed");
    expect(report).toContain("vault: %USERPROFILE%\\Notes");
    expect(report).toContain("mirroredFiles: 12");
    expect(report).toContain("pairedFolder: disabled");
    expect(report).not.toContain("C:\\Users\\Alice");
  });

  it("cannot render secret settings added outside the allowlist", () => {
    const sessionToken = "SESSION_SECRET_SENTINEL";
    const apiKey = "API_KEY_SECRET_SENTINEL";
    const input = {
      pluginVersion: "0.1.0",
      obsidianVersion: "1.9.12",
      platform: "darwin",
      architecture: "arm64",
      mode: "desktop" as const,
      engine: "api" as const,
      sessionActive: true,
      apiKeySet: true,
      agentStatuses: {
        claude: { state: "unknown" as const },
        codex: { state: "unknown" as const },
      },
      prerequisites,
      mirroredFileCount: 0,
      lastSyncOutcome: "never" as const,
      homeDirectory: "/Users/alice",
      paths: {
        vault: "/Users/alice/Vault",
        transcriptionCommand: "",
        temporaryBatches: [],
      },
      sessionToken,
      transcriptionApiKey: apiKey,
    };

    const report = renderDiagnosticsReport(input);

    expect(report).toContain("session: active");
    expect(report).toContain("apiKey: set");
    expect(report).not.toContain(sessionToken);
    expect(report).not.toContain(apiKey);
    expect(report).not.toContain("/Users/alice");
    expect(report).toContain("vault: ~/Vault");
  });

  it("omits absolute paths that cannot be home-relativised", () => {
    expect(
      homeRelativePath("/opt/tools/claude", "/Users/alice", "darwin"),
    ).toBe("[absolute path outside home omitted]");
    expect(homeRelativePath("/Users/alice/Vault", null, "darwin")).toBe(
      "[absolute path omitted]",
    );
    expect(homeRelativePath("tools/claude", null, "darwin")).toBe(
      "tools/claude",
    );
    expect(
      homeRelativePath("D:\\Tools\\codex.cmd", "C:\\Users\\Alice", "win32"),
    ).toBe("[absolute path outside home omitted]");
    expect(
      homeRelativePath(
        "/Users/alice/bin/tool /opt/other-tool",
        "/Users/alice",
        "darwin",
      ),
    ).toBe("[absolute path outside home omitted]");
    expect(
      homeRelativePath("/Users/alice-other/tool", "/Users/alice", "darwin"),
    ).toBe("[absolute path outside home omitted]");
  });

  it("includes bounded allowlisted performance evidence without operation paths", () => {
    const report = renderDiagnosticsReport({
      pluginVersion: "0.1.0",
      obsidianVersion: "1.12.7",
      platform: "ios",
      architecture: "unknown",
      mode: "mobile",
      engine: "api",
      sessionActive: true,
      apiKeySet: false,
      agentStatuses: {
        claude: { state: "unavailable", reason: "not-found" },
        codex: { state: "unavailable", reason: "not-found" },
      },
      prerequisites,
      mirroredFileCount: 13,
      lastSyncOutcome: "succeeded",
      homeDirectory: null,
      paths: {
        vault: "not available",
        transcriptionCommand: "",
        temporaryBatches: [],
      },
      performance: [
        {
          kind: "notebook-open",
          outcome: "failed",
          durationMs: 42,
          peakTrackedBytes: 106_527_410,
          settledTrackedBytes: 0,
          cleanup: "released",
          failureCategory: "allocation",
        },
      ],
    });

    expect(report).toContain("performance:");
    expect(report).toContain(
      "notebook-open: failed, duration=42ms, peak=106527410, settled=0, cleanup=released, failure=allocation",
    );
    expect(report).not.toContain("Journal");
    expect(report).not.toContain(".note");
  });
});
