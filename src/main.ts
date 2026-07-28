import {
  apiVersion,
  FileSystemAdapter,
  Modal,
  Notice,
  Platform,
  Plugin,
  Setting,
  TFile,
  TFolder,
  requestUrl,
  type MarkdownPostProcessorContext,
  type RequestUrlParam,
} from "obsidian";

import {
  SupernoteAuthExpiredError,
  SupernoteCloudClient,
  type RequestExecutor,
  type SupernoteVerificationChallenge,
  type SupernoteVerificationRequired,
} from "./cloud/client";
import type { CloudFile } from "./cloud/types";
import {
  ExportCollisionError,
  ExportService,
  type ExportDefaults,
  type PageExportResult,
} from "./export/export-service";
import type { PdfExporter } from "./export/pdf-export";
import PdfWorker from "./export/pdf.worker.ts?worker&inline";
import {
  NotebookService,
  type NotebookSessionLease,
} from "./note/notebook-service";
import NotebookWorker from "./note/notebook.worker.ts?worker&inline";
import { ApiOcrService, type ChatCompletionExecutor } from "./ocr/api-ocr";
import { AgentOcrService } from "./ocr/agent-ocr";
import { CommandOcrService } from "./ocr/command-ocr";
import { ApiModelCatalog, type ApiModelOption } from "./ocr/api-models";
import {
  defaultModelForEngine,
  effectiveTranscriptionSelection,
  type TranscriptionEngine,
  type TranscriptionSelection,
} from "./ocr/configuration";
import type { OcrPort } from "./ocr/types";
import {
  renderDiagnosticsReport,
  type LastSyncOutcome,
} from "./onboarding/diagnostics";
import {
  PerformanceDiagnostics,
  performanceFailureCategory,
  type ActivePerformanceOperation,
  type FinishPerformanceOperation,
  type PerformanceOperationKind,
} from "./onboarding/performance-diagnostics";
import {
  setupPrerequisites as buildSetupPrerequisites,
  shouldShowSetupNotice,
  type SetupPrerequisite,
  verifyWritableFolder,
} from "./onboarding/setup";
import {
  createDesktopBatch,
  desktopEnvironmentDetails,
  DesktopBinaryResolver,
  runDesktopCommand,
  type DesktopAgentBinary,
  type DesktopBinaryStatus,
} from "./shared/desktop-command";
import { RunConsoleController } from "./run/run-console";
import { RunRegistry } from "./run/run-registry";
import {
  normalizeOptionalRelativePath,
  normalizeRelativePath,
  vaultSafeName,
} from "./shared/path";
import { SupernoteSyncSettingTab } from "./settings";
import { AutomationAgentService } from "./sync/automation-agent";
import { ChecksumService } from "./sync/checksum-service";
import ChecksumWorker from "./sync/checksum.worker.ts?worker&inline";
import {
  loadManifest,
  saveManifest,
  SyncManifestTransaction,
  type ExportFormat,
  type SyncManifest,
} from "./sync/manifest";
import {
  emptyInstanceState,
  InstanceStateStore,
  type InstanceState,
} from "./sync/instance-state";
import { moveMirrorTransaction } from "./sync/mirror-move";
import {
  indexedFilePathsBelow,
  ObsidianVaultStore,
} from "./sync/obsidian-vault-store";
import {
  PairSyncService,
  emptyPairBaseline,
  type PairConflict,
  type PairConflictResolution,
  type PairSyncResult,
} from "./sync/pair-sync-service";
import {
  SendToSupernoteService,
  type MarkdownPdfPort,
} from "./sync/send-to-supernote";
import {
  isInsideSendToSupernoteFolder,
  resolveSendToSupernoteEnabled,
} from "./sync/send-to-supernote-policy";
import { syncCompletionOutcome } from "./sync/sync-outcome";
import {
  shouldRemoveMissingMirrorEntry,
  SyncService,
} from "./sync/sync-service";
import {
  automationResultNotice,
  createWatchHook,
  normalizeWatchHooks,
  refreshAutomationCommands,
  removeWatchHook,
  updateWatchHooks,
} from "./sync/watch-hook-configuration";
import {
  getWatchHookConfigurationWarning,
  WatchHookService,
  type WatchHookDefinition,
} from "./sync/watch-hooks";
import { upsertAutomationDraft } from "./settings-ux/automation-draft";
import {
  FolderPickerModal,
  type StopMirroringPreview,
} from "./ui/folder-picker-modal";
import { CloudBrowserStatusIndex } from "./ui/cloud-browser-status";
import {
  describeMirroredFolders,
  matchesUncoveredEntrySnapshot,
  removeMirroredFolder,
  selectMirroredFolder,
  syncedVaultFolderPaths,
  uncoveredEntriesAfterRemovingFolder,
  type MirroredCloudFolder,
} from "./ui/mirrored-folder-policy";
import { MirroredFolderTreeIndicator } from "./ui/mirrored-folder-tree-indicator";
import { SettingsFlowModal } from "./ui/settings-flow-modal";
import {
  chooseMarkdownSendFormat,
  chooseSendCollision,
  confirmPairLocalRemoval,
} from "./ui/send-to-supernote-modal";
import { setupFlowView } from "./ui/setup-flow";
import { NOTE_VIEW_TYPE, SupernoteNoteView } from "./viewer/note-view";
import type { TranscriptionAvailability } from "./viewer/export-options";
import {
  parseFixedPageEmbeds,
  parseInvalidFixedPageEmbeds,
} from "./viewer/fixed-page-embed";
import {
  FixedPageReadingView,
  InvalidFixedPageReadingView,
  matchFixedPageEmbedElements,
  matchInvalidFixedPageEmbedElements,
} from "./viewer/fixed-page-reading-view";
import { parseNotebookEmbeds } from "./viewer/notebook-embed";
import {
  matchNotebookEmbedElements,
  NotebookReadingView,
} from "./viewer/notebook-reading-view";
import { registerSupernoteNativeEmbed } from "./viewer/obsidian-embed";
import {
  countImageEmbedsBeforeLine,
  exportedPageReaderLink,
  resolveExportedPage,
} from "./viewer/state";

export interface SupernoteSyncSettings {
  targetFolder: string;
  pushFolder: string;
  autoSyncMinutes: number;
  watchHooks: WatchHookDefinition[];
  transcriptionEngine: TranscriptionEngine;
  transcriptionClaudeModel: string;
  transcriptionClaudeMaxBudgetUsd: number;
  transcriptionClaudePath: string;
  transcriptionCodexModel: string;
  transcriptionCodexPath: string;
  transcriptionCommand: string;
  transcriptionTimeoutMinutes: number;
  transcriptionApiBaseUrl: string;
  transcriptionApiKey: string;
  transcriptionApiModel: string;
  transcriptionExtraInstructions: string;
}
interface PluginData {
  token: string | null;
  lastSyncAt: string | null;
  lastSyncOutcome: LastSyncOutcome;
  setupNoticeShown: boolean;
  verifiedMirrorFolder: string | null;
  sendToSupernoteEnabled: boolean;
  pairDirectoryId: string | null;
  settings: SupernoteSyncSettings;
  mirroredFolders: Array<{ directoryId: string; remotePath: string }>;
  missingCloudNotes: string[];
}

export interface PairDisablePreview {
  remoteFolder: string;
  coveredByMirror: boolean;
  localFiles: string[];
}

const DEFAULT_SETTINGS: SupernoteSyncSettings = {
  targetFolder: "supernote",
  pushFolder: "Document/Obsidian",
  autoSyncMinutes: 0,
  watchHooks: [],
  transcriptionEngine: "api",
  transcriptionClaudeModel: "",
  transcriptionClaudeMaxBudgetUsd: 2,
  transcriptionClaudePath: "",
  transcriptionCodexModel: "",
  transcriptionCodexPath: "",
  transcriptionCommand: "",
  transcriptionTimeoutMinutes: 10,
  transcriptionApiBaseUrl: "https://openrouter.ai/api/v1",
  transcriptionApiKey: "",
  transcriptionApiModel: "",
  transcriptionExtraInstructions: "",
};

const DEFAULT_DATA: PluginData = {
  token: null,
  lastSyncAt: null,
  lastSyncOutcome: "never",
  setupNoticeShown: false,
  verifiedMirrorFolder: null,
  sendToSupernoteEnabled: false,
  pairDirectoryId: null,
  settings: DEFAULT_SETTINGS,
  mirroredFolders: [],
  missingCloudNotes: [],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unexpected Supernote sync error";

const confirmExportOverwrite = (
  app: SupernoteSyncPlugin["app"],
  paths: readonly string[],
): Promise<boolean> =>
  new Promise((resolve) => {
    new ExportOverwriteModal(app, paths, resolve).open();
  });

class ExportOverwriteModal extends Modal {
  private resolved = false;

  constructor(
    app: SupernoteSyncPlugin["app"],
    private readonly paths: readonly string[],
    private readonly resolve: (overwrite: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Overwrite existing export?");
    this.contentEl.createEl("p", {
      text:
        this.paths.length === 1
          ? `${this.paths[0]} already exists.`
          : `${this.paths.length} export files already exist.`,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.finish(false)),
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Overwrite")
          .onClick(() => this.finish(true)),
      );
  }

  onClose(): void {
    this.finish(false);
    this.contentEl.empty();
  }

  private finish(overwrite: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.resolve(overwrite);
    this.close();
  }
}

export default class SupernoteSyncPlugin extends Plugin {
  private data: PluginData = DEFAULT_DATA;
  private cloud!: SupernoteCloudClient;
  private vaultStore!: ObsidianVaultStore;
  private notebookService: NotebookService | null = null;
  private checksumService: ChecksumService | null = null;
  private pdfExporterInitialization: Promise<PdfExporter> | null = null;
  private markdownPdfInitialization: Promise<MarkdownPdfPort> | null = null;
  private readonly lazyPdfExporter: PdfExporter = {
    export: async (pages) => (await this.loadPdfExporter()).export(pages),
  };
  private readonly lazyMarkdownPdfRenderer: MarkdownPdfPort = {
    render: async (markdown) =>
      (await this.loadMarkdownPdfRenderer()).render(markdown),
  };
  private readonly binaryResolver = new DesktopBinaryResolver({
    pathOverride: (engine) =>
      engine === "claude"
        ? this.data.settings.transcriptionClaudePath
        : this.data.settings.transcriptionCodexPath,
  });
  private readonly apiModelCatalog = new ApiModelCatalog();
  private readonly runs = new RunRegistry();
  private instanceStateStore!: InstanceStateStore;
  private instanceState: InstanceState = emptyInstanceState();
  private runConsole: RunConsoleController | null = null;
  private mirroredFolderTreeIndicator: MirroredFolderTreeIndicator | null =
    null;
  private syncInProgress = false;
  private mirrorMoveInProgress = false;
  private watchHooksInProgress = false;
  private watchHooksRerunRequested = false;
  private registeredWatchCommands: string[] = [];
  private lastAutoSyncAttempt = 0;
  private workspaceLayoutReady = false;
  private performanceDiagnostics!: PerformanceDiagnostics;

  get settings(): Readonly<SupernoteSyncSettings> {
    return this.data.settings;
  }

  get isLoggedIn(): boolean {
    return this.cloud.accessToken !== null;
  }

  get lastSyncAt(): string | null {
    return this.data.lastSyncAt;
  }

  get lastSyncOutcome(): LastSyncOutcome {
    return this.data.lastSyncOutcome;
  }

  get sendToSupernoteEnabled(): boolean {
    return this.data.sendToSupernoteEnabled;
  }

  get autoSyncMinutes(): number {
    return this.instanceState.autoSyncMinutes;
  }

  get runAutomationsOnThisDevice(): boolean {
    return this.instanceState.runAutomationsOnThisDevice;
  }

  get mirroredFoldersDescription(): string {
    return describeMirroredFolders(this.data.mirroredFolders);
  }

  get isAutomationRunning(): boolean {
    return this.watchHooksInProgress;
  }

  get isSyncRunning(): boolean {
    return this.syncInProgress;
  }

  get isMirrorMoveRunning(): boolean {
    return this.mirrorMoveInProgress;
  }

  get automationConfigurationBlockingReason(): string | null {
    if (this.watchHooksInProgress) {
      return "Wait for the current Automation run to finish.";
    }
    if (this.mirrorMoveInProgress) {
      return "Wait for the current Mirror move to finish.";
    }
    return null;
  }

  get syncBlockingReason(): string | null {
    if (!this.isLoggedIn) {
      return "Sign in to Supernote Cloud first.";
    }
    if (this.syncInProgress) {
      return "A Supernote sync is already running.";
    }
    if (this.watchHooksInProgress) {
      return "Wait for the current Automation run to finish.";
    }
    if (this.mirrorMoveInProgress) {
      return "Wait for the current Mirror move to finish.";
    }
    const mirror = this.setupPrerequisites().find(
      (prerequisite) => prerequisite.id === "mirror",
    );
    return mirror?.state === "missing" ? mirror.detail : null;
  }

  async onload(): Promise<void> {
    this.app.workspace.onLayoutReady(() => {
      this.workspaceLayoutReady = true;
    });
    const stored = (await this.loadData()) as
      | (Partial<PluginData> & {
          writableSubtreeConfigured?: boolean;
        })
      | null;
    const storedSettings = stored?.settings as
      | Partial<SupernoteSyncSettings>
      | undefined;
    this.instanceStateStore = new InstanceStateStore(this.app);
    this.instanceState = this.instanceStateStore.load({
      sessionToken: stored?.token,
      autoSyncMinutes: storedSettings?.autoSyncMinutes,
    });
    this.data = {
      token: this.instanceState.sessionToken,
      lastSyncAt: stored?.lastSyncAt ?? null,
      lastSyncOutcome:
        stored?.lastSyncOutcome ?? (stored?.lastSyncAt ? "succeeded" : "never"),
      setupNoticeShown: stored?.setupNoticeShown ?? false,
      verifiedMirrorFolder:
        stored?.verifiedMirrorFolder ??
        (stored?.lastSyncAt && storedSettings?.targetFolder
          ? normalizeOptionalRelativePath(storedSettings.targetFolder)
          : null),
      sendToSupernoteEnabled: resolveSendToSupernoteEnabled(stored ?? {}),
      pairDirectoryId:
        typeof stored?.pairDirectoryId === "string"
          ? stored.pairDirectoryId
          : null,
      settings: {
        targetFolder:
          storedSettings?.targetFolder ?? DEFAULT_SETTINGS.targetFolder,
        pushFolder: storedSettings?.pushFolder ?? DEFAULT_SETTINGS.pushFolder,
        autoSyncMinutes: this.instanceState.autoSyncMinutes,
        watchHooks: normalizeWatchHooks(storedSettings?.watchHooks),
        transcriptionEngine:
          storedSettings?.transcriptionEngine === "claude" ||
          storedSettings?.transcriptionEngine === "codex" ||
          storedSettings?.transcriptionEngine === "command"
            ? storedSettings.transcriptionEngine
            : DEFAULT_SETTINGS.transcriptionEngine,
        transcriptionClaudeModel:
          storedSettings?.transcriptionClaudeModel ??
          DEFAULT_SETTINGS.transcriptionClaudeModel,
        transcriptionClaudeMaxBudgetUsd:
          storedSettings?.transcriptionClaudeMaxBudgetUsd ??
          DEFAULT_SETTINGS.transcriptionClaudeMaxBudgetUsd,
        transcriptionClaudePath:
          storedSettings?.transcriptionClaudePath ??
          DEFAULT_SETTINGS.transcriptionClaudePath,
        transcriptionCodexModel:
          storedSettings?.transcriptionCodexModel ??
          DEFAULT_SETTINGS.transcriptionCodexModel,
        transcriptionCodexPath:
          storedSettings?.transcriptionCodexPath ??
          DEFAULT_SETTINGS.transcriptionCodexPath,
        transcriptionCommand:
          storedSettings?.transcriptionCommand ??
          DEFAULT_SETTINGS.transcriptionCommand,
        transcriptionTimeoutMinutes:
          storedSettings?.transcriptionTimeoutMinutes ??
          DEFAULT_SETTINGS.transcriptionTimeoutMinutes,
        transcriptionApiBaseUrl:
          storedSettings?.transcriptionApiBaseUrl ??
          DEFAULT_SETTINGS.transcriptionApiBaseUrl,
        transcriptionApiKey:
          storedSettings?.transcriptionApiKey ??
          DEFAULT_SETTINGS.transcriptionApiKey,
        transcriptionApiModel:
          storedSettings?.transcriptionApiModel ??
          DEFAULT_SETTINGS.transcriptionApiModel,
        transcriptionExtraInstructions:
          storedSettings?.transcriptionExtraInstructions ??
          DEFAULT_SETTINGS.transcriptionExtraInstructions,
      },
      mirroredFolders: Array.isArray(stored?.mirroredFolders)
        ? stored.mirroredFolders
        : [],
      missingCloudNotes: Array.isArray(stored?.missingCloudNotes)
        ? stored.missingCloudNotes
        : [],
    };
    this.performanceDiagnostics = new PerformanceDiagnostics(
      this.instanceState.performanceDiagnostics,
    );
    this.persistPerformanceDiagnostics();
    if (
      stored?.token !== undefined ||
      storedSettings?.autoSyncMinutes !== undefined
    ) {
      await this.persistData(this.data);
    }
    const request: RequestExecutor = async (options) => {
      const requestOptions: RequestUrlParam = {
        url: options.url,
        method: options.method,
        throw: false,
      };
      if (options.headers !== undefined) {
        requestOptions.headers = options.headers;
      }
      if (options.body !== undefined) {
        requestOptions.body = options.body;
      }
      const response = await requestUrl(requestOptions);
      return {
        status: response.status,
        headers: response.headers,
        json: options.method === "POST" ? response.json : null,
        arrayBuffer: response.arrayBuffer,
      };
    };

    this.cloud = new SupernoteCloudClient(this.data.token, request);
    this.vaultStore = new ObsidianVaultStore(
      this.app.vault,
      this.app.fileManager,
    );
    this.runConsole = new RunConsoleController(
      this.app,
      this.runs,
      Platform.isDesktopApp ? this.addStatusBarItem() : undefined,
      {
        conflicts: () => this.pairConflicts(),
        resolve: (conflictId, resolution) =>
          this.resolvePairConflict(conflictId, resolution),
      },
    );
    this.refreshPairConflictAttention();

    this.registerView(
      NOTE_VIEW_TYPE,
      (leaf) =>
        new SupernoteNoteView(leaf, {
          notebooks: this.getNotebookService(),
          beginNotebookOpen: (scope) =>
            this.beginPerformanceOperation("notebook-open", scope),
          finishNotebookOpen: (operation, result) =>
            this.finishPerformanceOperation(operation, result),
          consumeInterruptedNotebookOpen: (scope) =>
            this.performanceDiagnostics.consumeInterrupted(
              "notebook-open",
              scope,
            ),
          isAutomaticWorkspaceRestore: () => !this.workspaceLayoutReady,
          trackedNotebookBytes: () =>
            this.notebookService?.snapshot().retainedBytes ?? 0,
          copyDiagnostics: () => this.copyDiagnostics(),
          getTranscriptionAvailability: () =>
            this.getTranscriptionAvailability(),
          getTargetFolder: () => this.data.settings.targetFolder,
          exportPages: (rawNotePath, options, displayedSession) =>
            this.exportLocalPages(rawNotePath, options, displayedSession),
          getExportDefaults: (rawNotePath) =>
            this.getExportDefaults(rawNotePath),
        }),
    );
    try {
      this.registerExtensions(["note"], NOTE_VIEW_TYPE);
    } catch {
      new Notice(
        'Could not register the Supernote viewer. Disable "Supernote (Unofficial)" because only one plugin can open .note files.',
        15_000,
      );
    }
    if (
      !registerSupernoteNativeEmbed(this, {
        notebooks: () => this.getNotebookService(),
      })
    ) {
      new Notice(
        "Could not register inline Supernote previews because this Obsidian version or another plugin already owns .note embeds.",
        15_000,
      );
    }
    this.registerMarkdownPostProcessor((element, context) => {
      this.attachSupernoteEmbeds(element, context);
    });
    this.registerMarkdownPostProcessor(async (element, context) => {
      await this.attachExportedPageNavigation(element, context);
    });

    this.addRibbonIcon("pen-line", "Mirror from Supernote Cloud", () =>
      this.openCloudBrowser(),
    );
    this.mirroredFolderTreeIndicator = new MirroredFolderTreeIndicator(
      this.app,
      () =>
        syncedVaultFolderPaths(
          this.data.settings.targetFolder,
          this.data.mirroredFolders,
          this.data.sendToSupernoteEnabled
            ? this.data.settings.pushFolder
            : null,
        ),
    );
    this.app.workspace.onLayoutReady(() =>
      this.mirroredFolderTreeIndicator?.start(),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () =>
        this.mirroredFolderTreeIndicator?.refresh(),
      ),
    );
    this.register(() => this.mirroredFolderTreeIndicator?.stop());
    this.addCommand({
      id: "browse-supernote-cloud",
      name: "Browse and mirror Supernote files",
      callback: () => this.openCloudBrowser(),
    });
    this.addCommand({
      id: "sync-mirrored-notebooks",
      name: "Sync mirrored Supernote files",
      callback: () => void this.syncMirroredNotebooks(),
    });
    this.addCommand({
      id: "send-to-supernote",
      name: "Send to Supernote",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.sendToSupernote(file);
        }
        return true;
      },
    });
    this.addCommand({
      id: "show-runs",
      name: "Show activity",
      callback: () => this.runConsole?.open(),
    });
    this.addCommand({
      id: "open-supernote-setup",
      name: "Open setup",
      callback: () => this.openSetupFlow(),
    });
    this.addCommand({
      id: "copy-supernote-diagnostics",
      name: "Copy diagnostics",
      callback: () => void this.copyDiagnostics(),
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) {
          return;
        }
        menu.addItem((item) =>
          item
            .setTitle("Send to Supernote")
            .setIcon("send")
            .setDisabled(!this.isLoggedIn)
            .onClick(() => void this.sendToSupernote(file)),
        );
      }),
    );
    this.refreshWatchHookCommands();
    this.addSettingTab(new SupernoteSyncSettingTab(this.app, this));
    if (
      shouldShowSetupNotice({
        sessionActive: this.isLoggedIn,
        noticeShown: this.data.setupNoticeShown,
      })
    ) {
      this.data.setupNoticeShown = true;
      await this.persistData(this.data);
      const message = document.createDocumentFragment();
      message.append("Finish Supernote Cloud Sync setup. ");
      const open = message.createEl("button", {
        text: "Open setup",
      });
      open.addEventListener("click", () => this.openSetupFlow());
      new Notice(message, 10_000);
    }
    this.scheduleConfiguredAgentWarmup();

    this.registerInterval(
      window.setInterval(() => void this.maybeAutoSync(), 60_000),
    );
  }

  onunload(): void {
    this.performanceDiagnostics.cancelActive();
    this.persistPerformanceDiagnostics();
    this.runConsole?.dispose();
    this.runConsole = null;
    this.notebookService?.dispose();
    this.notebookService = null;
    this.checksumService?.dispose();
    this.checksumService = null;
  }

  async login(
    email: string,
    password: string,
  ): Promise<SupernoteVerificationRequired | null> {
    try {
      const result = await this.cloud.login(email, password);
      if (typeof result !== "string") {
        return result;
      }
      this.data.token = result;
      this.instanceState.sessionToken = result;
      this.instanceStateStore.save(this.instanceState);
      await this.persistData(this.data);
      new Notice("Logged in to Supernote Cloud.");
      return null;
    } catch (error) {
      await this.reportError(error);
      throw error;
    }
  }

  async verifyLogin(
    challenge: SupernoteVerificationChallenge,
    code: string,
  ): Promise<void> {
    try {
      this.data.token = await this.cloud.verifyLogin(challenge, code);
      this.instanceState.sessionToken = this.data.token;
      this.instanceStateStore.save(this.instanceState);
      await this.persistData(this.data);
      new Notice("Logged in to Supernote Cloud.");
    } catch (error) {
      await this.reportError(error);
      throw error;
    }
  }

  async resendVerificationCode(
    challenge: SupernoteVerificationChallenge,
  ): Promise<SupernoteVerificationChallenge> {
    try {
      return await this.cloud.resendVerificationCode(challenge);
    } catch (error) {
      await this.reportError(error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.cloud.logout();
    this.data.token = null;
    this.instanceState.sessionToken = null;
    this.instanceStateStore.save(this.instanceState);
    await this.persistData(this.data);
    new Notice("Supernote Cloud session cleared.");
  }

  async updateSettings(update: Partial<SupernoteSyncSettings>): Promise<void> {
    const nextData: PluginData = {
      ...this.data,
      settings: { ...this.data.settings, ...update },
    };
    if (update.autoSyncMinutes !== undefined) {
      this.instanceState.autoSyncMinutes = update.autoSyncMinutes;
      this.instanceStateStore.save(this.instanceState);
    }
    await this.persistData(nextData);
    this.data = nextData;
    if (update.watchHooks !== undefined) {
      this.refreshWatchHookCommands();
    }
    if (update.transcriptionClaudePath !== undefined) {
      this.binaryResolver.invalidate("claude");
    }
    if (update.transcriptionCodexPath !== undefined) {
      this.binaryResolver.invalidate("codex");
    }
    if (
      update.transcriptionClaudePath !== undefined ||
      update.transcriptionCodexPath !== undefined
    ) {
      this.refreshWatchHookCommands();
    }
    const selectedEngine = this.data.settings.transcriptionEngine;
    const selectedPathChanged =
      (selectedEngine === "claude" &&
        update.transcriptionClaudePath !== undefined) ||
      (selectedEngine === "codex" &&
        update.transcriptionCodexPath !== undefined);
    if (
      (selectedEngine === "claude" || selectedEngine === "codex") &&
      (update.transcriptionEngine !== undefined || selectedPathChanged)
    ) {
      await this.resolveAgentBinary(selectedEngine);
    }
  }

  async updateInstanceExecutionSettings(update: {
    autoSyncMinutes?: number;
    runAutomationsOnThisDevice?: boolean;
  }): Promise<void> {
    if (update.autoSyncMinutes !== undefined) {
      this.instanceState.autoSyncMinutes = update.autoSyncMinutes;
      this.data.settings.autoSyncMinutes = update.autoSyncMinutes;
    }
    if (update.runAutomationsOnThisDevice !== undefined) {
      this.instanceState.runAutomationsOnThisDevice =
        update.runAutomationsOnThisDevice;
    }
    this.instanceStateStore.save(this.instanceState);
  }

  private async persistData(data: PluginData): Promise<void> {
    const { token: _token, settings: runtimeSettings, ...persisted } = data;
    const { autoSyncMinutes: _autoSyncMinutes, ...settings } = runtimeSettings;
    await this.saveData({ ...persisted, settings });
  }

  private async beginPerformanceOperation(
    kind: PerformanceOperationKind,
    scope: string | null = null,
  ): Promise<ActivePerformanceOperation> {
    const operation = this.performanceDiagnostics.begin(kind, scope);
    this.persistPerformanceDiagnostics();
    return operation;
  }

  private async finishPerformanceOperation(
    operation: ActivePerformanceOperation,
    result: FinishPerformanceOperation,
  ): Promise<void> {
    this.performanceDiagnostics.finish(operation, result);
    this.persistPerformanceDiagnostics();
  }

  private persistPerformanceDiagnostics(): void {
    this.instanceState.performanceDiagnostics =
      this.performanceDiagnostics.snapshot();
    try {
      this.instanceStateStore.save(this.instanceState);
    } catch {
      // Diagnostic persistence must never deny the operation being observed.
    }
  }

  getMirroredNotePaths(): string[] {
    const mirror = normalizeRelativePath(this.data.settings.targetFolder);
    return indexedFilePathsBelow(
      this.app.vault.getAbstractFileByPath(mirror),
    ).filter((path) => path.toLocaleLowerCase().endsWith(".note"));
  }

  getWatchHookWarning(
    hook: WatchHookDefinition,
    mirroredNotePaths: readonly string[],
  ): string | null {
    const configurationWarning = getWatchHookConfigurationWarning(
      hook,
      this.data.settings.targetFolder,
    );
    if (configurationWarning) {
      return configurationWarning;
    }
    if (
      hook.action !== "command" &&
      !this.isAutomationActionAvailable(hook.action)
    ) {
      const label = hook.action === "claude" ? "Claude Code" : "Codex CLI";
      const status = this.agentBinaryStatus(hook.action);
      return status.state === "unknown"
        ? `${label} availability has not been checked yet.`
        : status.state === "checking"
          ? `Checking ${label} availability…`
          : status.state === "unavailable"
            ? status.reason === "not-executable"
              ? `${label} was found but could not be executed.`
              : `${label} was not found in PATH.`
            : `${label} is available.`;
    }
    if (this.data.missingCloudNotes.includes(hook.sourceNote)) {
      return "This notebook is no longer present in its Supernote Cloud folder.";
    }
    if (!mirroredNotePaths.includes(hook.sourceNote)) {
      return "This notebook is not currently available in the mirror.";
    }
    return null;
  }

  getAutomationBlockingReason(
    hook: WatchHookDefinition,
    mirroredNotePaths: readonly string[] = this.getMirroredNotePaths(),
  ): string | null {
    if (!this.isLoggedIn) {
      return "Sign in to Supernote Cloud first.";
    }
    if (this.isSyncRunning) {
      return "Wait for the current Supernote sync to finish.";
    }
    if (this.isMirrorMoveRunning) {
      return "Wait for the current Mirror move to finish.";
    }
    if (this.isAutomationRunning) {
      return "Another Supernote Automation is already running.";
    }
    return this.getWatchHookWarning(hook, mirroredNotePaths);
  }

  isAutomationActionAvailable(action: WatchHookDefinition["action"]): boolean {
    return (
      action === "command" ||
      (Platform.isDesktopApp &&
        this.agentBinaryStatus(action).state === "available")
    );
  }

  agentBinaryStatus(engine: DesktopAgentBinary): DesktopBinaryStatus {
    return Platform.isDesktopApp
      ? this.binaryResolver.status(engine)
      : { state: "unavailable", reason: "not-found" };
  }

  agentBinaryLabel(engine: DesktopAgentBinary): string {
    const label = engine === "claude" ? "Claude Code" : "Codex CLI";
    const status = this.agentBinaryStatus(engine);
    return status.state === "unknown"
      ? `${label} (check on use)`
      : status.state === "checking"
        ? `${label} (checking…)`
        : status.state === "unavailable"
          ? status.reason === "not-executable"
            ? `${label} (not executable)`
            : `${label} (not found)`
          : label;
  }

  isAgentBinarySelectable(engine: DesktopAgentBinary): boolean {
    const state = this.agentBinaryStatus(engine).state;
    return state === "unknown" || state === "available";
  }

  async ensureAgentBinary(engine: DesktopAgentBinary): Promise<boolean> {
    return Boolean(await this.resolveAgentBinary(engine));
  }

  async redetectAgentBinary(engine: DesktopAgentBinary): Promise<boolean> {
    if (!Platform.isDesktopApp) {
      return false;
    }
    const available = Boolean(await this.binaryResolver.redetect(engine));
    this.refreshWatchHookCommands();
    return available;
  }

  async verifyAgentBinary(engine: DesktopAgentBinary): Promise<boolean> {
    if (!Platform.isDesktopApp) {
      return false;
    }
    const available = await this.binaryResolver.verify(engine);
    this.refreshWatchHookCommands();
    return available;
  }

  async testAgentCandidate(
    engine: DesktopAgentBinary,
    pathOverride: string,
  ): Promise<DesktopBinaryStatus> {
    return Platform.isDesktopApp
      ? this.binaryResolver.testCandidate(engine, pathOverride)
      : { state: "unavailable", reason: "not-found" };
  }

  setupPrerequisites(): readonly SetupPrerequisite[] {
    const mirrorFolder = normalizeOptionalRelativePath(
      this.data.settings.targetFolder,
    );
    const mirrorFolderWritable = Boolean(
      mirrorFolder &&
        this.app.vault.getAbstractFileByPath(mirrorFolder) instanceof TFolder &&
        normalizeOptionalRelativePath(this.data.verifiedMirrorFolder ?? "") ===
          mirrorFolder,
    );
    return buildSetupPrerequisites({
      sessionActive: this.isLoggedIn,
      mirrorFolder,
      mirrorFolderWritable,
      sendToSupernote: {
        enabled: this.data.sendToSupernoteEnabled,
        folder: normalizeOptionalRelativePath(this.data.settings.pushFolder),
      },
      engine: this.transcriptionSelection().engine,
      apiKeySet: Boolean(this.data.settings.transcriptionApiKey.trim()),
      commandConfigured: Boolean(
        this.data.settings.transcriptionCommand.trim(),
      ),
      isDesktop: Platform.isDesktopApp,
      agentStatuses: {
        claude: this.agentBinaryStatus("claude"),
        codex: this.agentBinaryStatus("codex"),
      },
    });
  }

  async chooseMirrorFolder(path: string): Promise<boolean> {
    if (
      this.syncInProgress ||
      this.watchHooksInProgress ||
      this.mirrorMoveInProgress
    ) {
      new Notice(
        "Wait for the current sync, Automation run, or Mirror move to finish.",
      );
      return false;
    }
    const normalized = normalizeOptionalRelativePath(path);
    if (
      !normalized ||
      !(this.app.vault.getAbstractFileByPath(normalized) instanceof TFolder)
    ) {
      new Notice("Choose an existing folder below the vault root.");
      return false;
    }
    const previous = this.data.verifiedMirrorFolder;
    try {
      await verifyWritableFolder(
        this.vaultStore,
        normalized,
        `.supernote-write-check-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`,
      );
      this.data.verifiedMirrorFolder = normalized;
      await this.updateSettings({ targetFolder: normalized });
      return true;
    } catch {
      this.data.verifiedMirrorFolder = previous;
      new Notice(
        "That vault folder could not be written. Choose another folder.",
      );
      return false;
    }
  }

  async moveMirror(path: string): Promise<boolean> {
    if (
      this.syncInProgress ||
      this.watchHooksInProgress ||
      this.mirrorMoveInProgress
    ) {
      new Notice(
        "Wait for the current sync, Automation run, or Mirror move to finish.",
      );
      return false;
    }
    const source = normalizeOptionalRelativePath(
      this.data.settings.targetFolder,
    );
    const destination = normalizeOptionalRelativePath(path);
    const sourceFolder = this.app.vault.getAbstractFileByPath(source);
    if (!source || !(sourceFolder instanceof TFolder)) {
      new Notice("The current Mirror folder is unavailable.");
      return false;
    }
    const previousData = this.data;
    this.mirrorMoveInProgress = true;
    try {
      const manifest = await loadManifest(
        this.vaultStore,
        `${source}/.sync-manifest.json`,
      );
      await moveMirrorTransaction(
        {
          source,
          destination,
          manifest,
          automations: this.data.settings.watchHooks,
          missingCloudNotes: this.data.missingCloudNotes,
        },
        {
          preflight: async (_from, to) => {
            const target = this.app.vault.getAbstractFileByPath(to);
            if (!(target instanceof TFolder)) {
              throw new Error("Choose an existing empty vault folder.");
            }
            const entries = await this.app.vault.adapter.list(to);
            if (entries.files.length > 0 || entries.folders.length > 0) {
              throw new Error("The new Mirror folder must be empty.");
            }
            await verifyWritableFolder(
              this.vaultStore,
              to,
              `.supernote-write-check-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`,
            );
          },
          moveFolder: async (from, to) => {
            const current = this.app.vault.getAbstractFileByPath(from);
            const target = this.app.vault.getAbstractFileByPath(to);
            if (!(current instanceof TFolder) || !(target instanceof TFolder)) {
              throw new Error("Mirror folders changed before the move.");
            }
            await this.app.fileManager.trashFile(target);
            try {
              await this.app.vault.rename(current, to);
            } catch (error) {
              await this.app.vault.createFolder(to).catch(() => undefined);
              throw error;
            }
          },
          writeManifest: (manifestPath, value) =>
            saveManifest(this.vaultStore, manifestPath, value),
          saveState: async (state) => {
            const nextData: PluginData = {
              ...this.data,
              verifiedMirrorFolder: state.targetFolder,
              settings: {
                ...this.data.settings,
                targetFolder: state.targetFolder,
                watchHooks: state.automations,
              },
              missingCloudNotes: state.missingCloudNotes,
            };
            await this.persistData(nextData);
            this.data = nextData;
          },
          rollbackFolder: async (from, to) => {
            const moved = this.app.vault.getAbstractFileByPath(from);
            if (!(moved instanceof TFolder)) {
              throw new Error("Moved Mirror is unavailable for rollback.");
            }
            await this.app.vault.rename(moved, to);
          },
          restoreDestination: async (to) => {
            if (!this.app.vault.getAbstractFileByPath(to)) {
              await this.app.vault.createFolder(to);
            }
          },
        },
      );
      try {
        this.refreshWatchHookCommands();
      } catch {
        new Notice(
          "Mirror moved, but Automation commands could not refresh. Reload Obsidian.",
          12_000,
        );
      }
      this.mirroredFolderTreeIndicator?.refresh();
      new Notice(`Mirror moved to ${destination}.`);
      return true;
    } catch (error) {
      this.data = previousData;
      new Notice(`Could not move the Mirror: ${errorMessage(error)}`, 12_000);
      return false;
    } finally {
      this.mirrorMoveInProgress = false;
    }
  }

  openSendToSupernoteFolderPicker(onSelected: () => void): void {
    if (!this.isLoggedIn) {
      new Notice("Sign in to Supernote Cloud first.");
      return;
    }
    if (this.syncInProgress || this.mirrorMoveInProgress) {
      new Notice("Wait for the current sync or Mirror move to finish.");
      return;
    }
    new FolderPickerModal(
      this.app,
      this.cloud,
      async () => undefined,
      async (directoryId, remotePath) => {
        const normalizedRemotePath = normalizeRelativePath(remotePath);
        if (
          this.data.sendToSupernoteEnabled &&
          normalizeRelativePath(this.data.settings.pushFolder) !==
            normalizedRemotePath
        ) {
          const preview = await this.previewDisablePair();
          if (
            !preview.coveredByMirror &&
            preview.localFiles.length > 0 &&
            !(await confirmPairLocalRemoval(
              this.app,
              preview.localFiles.length,
              "Change",
            ))
          ) {
            return false;
          }
          await this.disableSendToSupernote(preview);
        }
        const nextData: PluginData = {
          ...this.data,
          sendToSupernoteEnabled: true,
          pairDirectoryId: directoryId,
          settings: {
            ...this.data.settings,
            pushFolder: normalizedRemotePath,
          },
        };
        await this.persistData(nextData);
        this.data = nextData;
        this.mirroredFolderTreeIndicator?.refresh();
        onSelected();
        return true;
      },
      undefined,
      {
        folderActionLabel: "Use this folder",
        foldersOnly: true,
      },
    ).open();
  }

  async previewDisablePair(): Promise<PairDisablePreview> {
    const remoteFolder = normalizeRelativePath(this.data.settings.pushFolder);
    const coveredByMirror = this.data.mirroredFolders.some((folder) => {
      const root = normalizeOptionalRelativePath(folder.remotePath);
      return (
        remoteFolder === root || (root && remoteFolder.startsWith(`${root}/`))
      );
    });
    const vaultFolder = `${normalizeRelativePath(
      this.data.settings.targetFolder,
    )}/${remoteFolder}`;
    return {
      remoteFolder,
      coveredByMirror: Boolean(coveredByMirror),
      localFiles: await this.vaultStore.listFiles(vaultFolder),
    };
  }

  async disableSendToSupernote(preview?: PairDisablePreview): Promise<void> {
    if (this.syncInProgress || this.mirrorMoveInProgress) {
      throw new Error("Wait for the current sync or Mirror move to finish.");
    }
    const current = await this.previewDisablePair();
    if (!preview && !current.coveredByMirror && current.localFiles.length > 0) {
      throw new Error(
        "Confirm the local Paired-folder removal before disabling it.",
      );
    }
    if (
      preview &&
      (current.remoteFolder !== preview.remoteFolder ||
        current.coveredByMirror !== preview.coveredByMirror ||
        JSON.stringify(current.localFiles) !==
          JSON.stringify(preview.localFiles))
    ) {
      throw new Error(
        "The Paired folder changed. Review the updated count and try again.",
      );
    }
    await this.applyPairDisable(current);
  }

  private async applyPairDisable(preview: PairDisablePreview): Promise<void> {
    const directoryId = this.data.pairDirectoryId;
    const baselineKey = directoryId ? this.pairBaselineKey(directoryId) : null;
    const baseline = baselineKey
      ? this.instanceState.pairBaselines[baselineKey]
      : undefined;
    if (preview.coveredByMirror && baseline) {
      const transaction = await SyncManifestTransaction.open(
        this.vaultStore,
        this.createSyncService().manifestPath,
      );
      await transaction.run(async (manifest) => {
        for (const entry of Object.values(baseline.entries)) {
          manifest.files[entry.remoteId] = {
            remoteId: entry.remoteId,
            directoryId: entry.directoryId,
            fileName: entry.fileName,
            remotePath: `/${preview.remoteFolder}/${entry.remoteRelativePath}`,
            md5: entry.checksum,
            updateTime: 0,
            vaultPath: `${normalizeRelativePath(
              this.data.settings.targetFolder,
            )}/${preview.remoteFolder}/${entry.localRelativePath}`,
            syncedAt: new Date().toISOString(),
          };
        }
      });
    } else if (!preview.coveredByMirror) {
      const vaultFolder = `${normalizeRelativePath(
        this.data.settings.targetFolder,
      )}/${preview.remoteFolder}`;
      if (await this.vaultStore.exists(vaultFolder)) {
        await this.vaultStore.delete(vaultFolder);
      }
    }
    if (baselineKey) {
      delete this.instanceState.pairBaselines[baselineKey];
      this.instanceStateStore.save(this.instanceState);
    }
    this.refreshPairConflictAttention();
    const nextData: PluginData = {
      ...this.data,
      sendToSupernoteEnabled: false,
    };
    await this.persistData(nextData);
    this.data = nextData;
    this.mirroredFolderTreeIndicator?.refresh();
  }

  async diagnosticsReport(): Promise<string> {
    const desktop = Platform.isDesktopApp
      ? desktopEnvironmentDetails()
      : {
          platform: Platform.isIosApp
            ? "ios"
            : Platform.isAndroidApp
              ? "android"
              : "mobile",
          architecture: "unknown",
          homeDirectory: null,
        };
    const adapter = this.app.vault.adapter;
    const vaultPath =
      adapter instanceof FileSystemAdapter
        ? adapter.getBasePath()
        : "not available";
    const mirrorFolder = normalizeOptionalRelativePath(
      this.data.settings.targetFolder,
    );
    const mirroredFileCount = mirrorFolder
      ? Object.keys(
          (
            await loadManifest(
              this.vaultStore,
              `${mirrorFolder}/.sync-manifest.json`,
            )
          ).files,
        ).length
      : 0;
    return renderDiagnosticsReport({
      pluginVersion: this.manifest.version,
      obsidianVersion: apiVersion,
      platform: desktop.platform,
      architecture: desktop.architecture,
      mode: Platform.isDesktopApp ? "desktop" : "mobile",
      engine: this.transcriptionSelection().engine,
      sessionActive: this.isLoggedIn,
      apiKeySet: Boolean(this.data.settings.transcriptionApiKey.trim()),
      agentStatuses: {
        claude: this.agentBinaryStatus("claude"),
        codex: this.agentBinaryStatus("codex"),
      },
      prerequisites: this.setupPrerequisites(),
      mirroredFileCount,
      lastSyncOutcome: this.data.lastSyncOutcome,
      performance: this.performanceDiagnostics.snapshot().recent,
      homeDirectory: desktop.homeDirectory,
      paths: {
        vault: vaultPath,
        transcriptionCommand: this.data.settings.transcriptionCommand,
        temporaryBatches: this.runs
          .records()
          .flatMap((run) => (run.batchPath ? [run.batchPath] : [])),
      },
    });
  }

  async copyDiagnostics(): Promise<void> {
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard access is unavailable");
      }
      await navigator.clipboard.writeText(await this.diagnosticsReport());
      new Notice("Diagnostics copied.");
    } catch {
      new Notice("Could not copy diagnostics.");
    }
  }

  openSetupFlow(): void {
    new SettingsFlowModal(this.app, setupFlowView(this)).open();
  }

  createWatchHookDraft(): WatchHookDefinition {
    const notes = this.getMirroredNotePaths();
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return createWatchHook(this.data.settings.watchHooks, notes[0] ?? "", id);
  }

  async saveWatchHookDraft(draft: WatchHookDefinition): Promise<void> {
    const blocked = this.automationConfigurationBlockingReason;
    if (blocked) {
      throw new Error(blocked);
    }
    await this.updateSettings({
      watchHooks: upsertAutomationDraft(this.data.settings.watchHooks, draft),
    });
    if (draft.action === "claude" || draft.action === "codex") {
      void this.resolveAgentBinary(draft.action);
    }
  }

  async updateWatchHook(
    id: string,
    update: Partial<Omit<WatchHookDefinition, "id">>,
  ): Promise<void> {
    await this.updateSettings({
      watchHooks: updateWatchHooks(this.data.settings.watchHooks, id, update),
    });
    if (update.action === "claude" || update.action === "codex") {
      void this.resolveAgentBinary(update.action);
    }
  }

  async removeWatchHook(id: string): Promise<void> {
    const blocked = this.automationConfigurationBlockingReason;
    if (blocked) {
      throw new Error(blocked);
    }
    await this.updateSettings({
      watchHooks: removeWatchHook(this.data.settings.watchHooks, id),
    });
  }

  openCloudBrowser(onChanged?: () => void): void {
    if (!this.isLoggedIn) {
      new Notice("Log in to Supernote Cloud in plugin settings first.");
      return;
    }

    void (async () => {
      let statuses!: CloudBrowserStatusIndex;
      const refreshStatuses = async (): Promise<void> => {
        const manifest = await loadManifest(
          this.vaultStore,
          this.createSyncService().manifestPath,
        );
        statuses = new CloudBrowserStatusIndex({
          mirroredFolders: this.data.mirroredFolders,
          pushFolder: this.data.sendToSupernoteEnabled
            ? this.data.settings.pushFolder
            : null,
          manifest,
        });
      };
      await refreshStatuses();
      new FolderPickerModal(
        this.app,
        this.cloud,
        async (file, remotePath) => {
          await this.mirrorAndOpenFile(file, remotePath);
        },
        async (directoryId, remotePath) => {
          const mirrored = await this.mirrorCloudFolder(
            directoryId,
            remotePath,
          );
          await refreshStatuses();
          return mirrored;
        },
        (item, remotePath) => ({
          status: statuses.statusFor(item, remotePath),
          includedVia: statuses.includedVia(remotePath),
        }),
        {
          ...(onChanged ? { onChanged } : {}),
          openDownloadedFile: async (file, remotePath) => {
            await this.openDownloadedCloudFile(file, remotePath);
          },
          previewStopMirroringFolder: (directoryId, remotePath) =>
            this.previewStopMirroringFolder(directoryId, remotePath),
          stopMirroringFolder: async (directoryId, remotePath, preview) => {
            await this.stopMirroringFolder(directoryId, remotePath, preview);
            await refreshStatuses();
          },
        },
      ).open();
    })().catch((error: unknown) => {
      void this.reportError(error);
    });
  }

  private async mirrorCloudFolder(
    directoryId: string,
    remotePath: string,
  ): Promise<boolean> {
    const nextFolders = selectMirroredFolder(this.data.mirroredFolders, {
      directoryId,
      remotePath,
    });
    if (
      JSON.stringify(nextFolders) !== JSON.stringify(this.data.mirroredFolders)
    ) {
      this.data.mirroredFolders = nextFolders;
      await this.persistData(this.data);
      this.mirroredFolderTreeIndicator?.refresh();
    }
    return this.syncMirroredNotebooks();
  }

  private async previewStopMirroringFolder(
    directoryId: string,
    remotePath: string,
  ): Promise<StopMirroringPreview> {
    const removed = { directoryId, remotePath };
    const remaining = removeMirroredFolder(this.data.mirroredFolders, removed);
    const manifest = await loadManifest(
      this.vaultStore,
      this.createSyncService().manifestPath,
    );
    const entries = uncoveredEntriesAfterRemovingFolder({
      manifest,
      removed,
      remaining,
      protectedRemoteFolders: this.protectedRemoteFolders,
    });
    return { remoteIds: entries.map((entry) => entry.remoteId) };
  }

  private async stopMirroringFolder(
    directoryId: string,
    remotePath: string,
    preview: StopMirroringPreview,
  ): Promise<void> {
    if (this.syncInProgress) {
      throw new Error("A Supernote sync is already running.");
    }
    if (this.mirrorMoveInProgress) {
      throw new Error("Wait for the current Mirror move to finish.");
    }
    const removed: MirroredCloudFolder = { directoryId, remotePath };
    const previousFolders = this.data.mirroredFolders;
    const remaining = removeMirroredFolder(previousFolders, removed);
    if (remaining.length === previousFolders.length) {
      return;
    }

    const service = this.createSyncService();
    const activity = this.runs.start({
      kind: "sync",
      label: `Stopping mirror for ${remotePath}`,
      engine: "cloud",
      model: "mirror",
    });
    this.syncInProgress = true;
    try {
      const transaction = await SyncManifestTransaction.open(
        this.vaultStore,
        service.manifestPath,
      );
      const removedFiles = await transaction.run(async (manifest) => {
        const entries = uncoveredEntriesAfterRemovingFolder({
          manifest,
          removed,
          remaining,
          protectedRemoteFolders: this.protectedRemoteFolders,
        });
        if (!matchesUncoveredEntrySnapshot(entries, preview.remoteIds)) {
          throw new Error(
            "The files covered by this folder changed. Review the updated count and try again.",
          );
        }
        for (const entry of entries) {
          await service.removeMirroredFile(entry.remoteId, manifest);
          activity.append("stdout", `Moved ${entry.remotePath} to Trash.\n`);
        }
        return entries.length;
      });
      const removedRoot = normalizeOptionalRelativePath(remotePath);
      const retainedRoots = [
        ...remaining.map((folder) =>
          normalizeOptionalRelativePath(folder.remotePath),
        ),
        ...this.protectedRemoteFolders.map((folder) =>
          normalizeOptionalRelativePath(folder),
        ),
      ];
      const uncoveredDirectories = Object.entries(
        this.instanceState.mirrorDirectories,
      )
        .filter(([, directory]) => {
          const path = normalizeOptionalRelativePath(directory.remotePath);
          const insideRemoved =
            path === removedRoot || path.startsWith(`${removedRoot}/`);
          const retained = retainedRoots.some(
            (root) => path === root || path.startsWith(`${root}/`),
          );
          return insideRemoved && !retained;
        })
        .sort(
          ([, left], [, right]) =>
            right.vaultPath.split("/").length -
            left.vaultPath.split("/").length,
        );
      for (const [remoteId, directory] of uncoveredDirectories) {
        if (
          (await this.vaultStore.listFiles(directory.vaultPath)).length === 0 &&
          (await this.vaultStore.exists(directory.vaultPath))
        ) {
          await this.vaultStore.delete(directory.vaultPath);
        }
        delete this.instanceState.mirrorDirectories[remoteId];
      }
      this.instanceStateStore.save(this.instanceState);
      this.data.mirroredFolders = remaining;
      try {
        await this.persistData(this.data);
      } catch (error) {
        this.data.mirroredFolders = previousFolders;
        throw error;
      }
      this.mirroredFolderTreeIndicator?.refresh();
      activity.finish("succeeded");
      new Notice(
        `Stopped mirroring ${remotePath}; ${removedFiles} file${
          removedFiles === 1 ? "" : "s"
        } moved to Trash.`,
      );
    } catch (error) {
      activity.append("stderr", `${errorMessage(error)}\n`);
      activity.finish("failed");
      await this.reportError(error);
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  private get protectedRemoteFolders(): string[] {
    return this.data.sendToSupernoteEnabled
      ? [this.data.settings.pushFolder]
      : [];
  }

  private async collectCloudInventory(
    directoryId: string,
    remotePath: string,
  ): Promise<{
    files: Array<{ file: CloudFile; remotePath: string }>;
    directories: Array<{ remoteId: string; remotePath: string }>;
  }> {
    const files: Array<{ file: CloudFile; remotePath: string }> = [];
    const normalizedBase = normalizeOptionalRelativePath(remotePath);
    const base = normalizedBase ? `/${normalizedBase}` : "";
    const directories = [{ remoteId: directoryId, remotePath: base }];
    for (const item of await this.cloud.listDirectory(directoryId)) {
      const itemPath = `${base}/${item.fileName}`;
      if (item.isFolder) {
        const child = await this.collectCloudInventory(item.id, itemPath);
        files.push(...child.files);
        directories.push(...child.directories);
      } else {
        files.push({ file: item as CloudFile, remotePath: itemPath });
      }
    }
    return { files, directories };
  }

  private isInPushFolder(remotePath: string): boolean {
    return isInsideSendToSupernoteFolder(
      remotePath,
      this.data.settings.pushFolder,
    );
  }

  private async sendToSupernote(file: TFile): Promise<void> {
    if (!this.isLoggedIn) {
      new Notice("Log in to Supernote Cloud first.");
      return;
    }
    if (this.syncInProgress) {
      new Notice("A Supernote sync is already running.");
      return;
    }
    if (this.mirrorMoveInProgress) {
      new Notice("Wait for the current Mirror move to finish.");
      return;
    }
    const lastDestination = this.instanceState.lastSendDestination;
    new FolderPickerModal(
      this.app,
      this.cloud,
      async () => undefined,
      async (directoryId, remotePath) => {
        await this.sendToSelectedFolder(file, { directoryId, remotePath });
        return true;
      },
      undefined,
      {
        folderActionLabel: "Send here",
        foldersOnly: true,
        ...(lastDestination
          ? {
              initialLocation: {
                id: lastDestination.directoryId,
                path: lastDestination.remotePath,
              },
            }
          : {}),
      },
    ).open();
  }

  private async sendToSelectedFolder(
    file: TFile,
    destination: { directoryId: string; remotePath: string },
  ): Promise<void> {
    const markdownFormat =
      file.extension.toLocaleLowerCase() === "md"
        ? await chooseMarkdownSendFormat(this.app)
        : "pdf";
    if (!markdownFormat) {
      return;
    }
    const activity = this.runs.start({
      kind: "sync",
      label: `Sending ${file.name}`,
      engine: "cloud",
      model: "upload",
    });
    activity.append("stdout", `Preparing ${file.path} for Supernote Cloud.\n`);
    this.syncInProgress = true;
    try {
      activity.setLabel("Uploading to Supernote");
      const result = await new SendToSupernoteService({
        vault: this.vaultStore,
        cloud: this.cloud,
        markdownPdf: this.lazyMarkdownPdfRenderer,
        resolveCollision: (collision) =>
          chooseSendCollision(
            this.app,
            collision.fileName,
            collision.destination.remotePath,
          ),
      }).send(file.path, { destination, markdownFormat });
      this.instanceState.lastSendDestination = destination;
      this.instanceStateStore.save(this.instanceState);
      this.data.lastSyncOutcome = "succeeded";
      await this.persistData(this.data);
      activity.setLabel("Verifying Send");
      new Notice(
        `Sent ${file.name} as ${result.fileName} to ${destination.remotePath}.`,
      );
      activity.append(
        "stdout",
        `Verified ${result.cloudPath} (${result.checksum}).\n`,
      );
      activity.finish("succeeded");
    } catch (error) {
      activity.append("stderr", `${errorMessage(error)}\n`);
      activity.finish("failed");
      this.data.lastSyncOutcome = "failed";
      await this.persistData(this.data).catch(() => undefined);
      await this.reportError(error);
    } finally {
      this.syncInProgress = false;
    }
  }

  async syncMirroredNotebooks(runAutomations = true): Promise<boolean> {
    if (this.syncInProgress) {
      new Notice("A Supernote sync is already running.");
      return false;
    }
    if (this.mirrorMoveInProgress) {
      new Notice("Wait for the current Mirror move to finish.");
      return false;
    }
    if (!this.isLoggedIn) {
      new Notice("Log in to Supernote Cloud first.");
      return false;
    }

    this.syncInProgress = true;
    const diagnosticOperation = await this.beginPerformanceOperation("sync");
    let diagnosticPeakBytes =
      this.notebookService?.snapshot().retainedBytes ?? 0;
    const diagnosticSampler = window.setInterval(() => {
      diagnosticPeakBytes = Math.max(
        diagnosticPeakBytes,
        this.notebookService?.snapshot().retainedBytes ?? 0,
      );
    }, 50);
    let diagnosticOutcome: "succeeded" | "failed" = "failed";
    let diagnosticFailureCategory: string | null = null;
    let completed = false;
    const activity = this.runs.start({
      kind: "sync",
      label: "Scanning Supernote Cloud",
      engine: "cloud",
      model: "mirror",
    });
    activity.append("stdout", "Checking Supernote Cloud for changes.\n");
    try {
      const manifestService = this.createSyncService();
      const transaction = await SyncManifestTransaction.open(
        this.vaultStore,
        manifestService.manifestPath,
      );
      const run = async (
        manifest: SyncManifest,
      ): Promise<{
        synced: number;
        skipped: number;
        removedFromMirror: number;
        protectedFiles: string[];
        failed: string[];
        pair: PairSyncResult;
        missingCloudNotes: string[];
      }> => {
        const service = manifestService;
        const filesToSync = new Map<
          string,
          { file: CloudFile; remotePath: string }
        >();
        const directoriesToMirror = new Map<
          string,
          { remoteId: string; remotePath: string }
        >();
        const previousMirrorDirectoryPaths: string[] = [];
        let mirrorSnapshotComplete = true;
        let synced = 0;
        let skipped = 0;
        let removedFromMirror = 0;
        const protectedFiles: string[] = [];
        const failed: string[] = [];
        const missingCloudNotes: string[] = [];

        for (const folder of this.data.mirroredFolders) {
          try {
            const inventory = await this.collectCloudInventory(
              folder.directoryId,
              folder.remotePath,
            );
            for (const item of inventory.files) {
              if (!this.isInPushFolder(item.remotePath)) {
                filesToSync.set(item.file.id, item);
              }
            }
            for (const directory of inventory.directories) {
              if (!this.isInPushFolder(directory.remotePath)) {
                directoriesToMirror.set(directory.remoteId, directory);
              }
            }
          } catch (error) {
            mirrorSnapshotComplete = false;
            failed.push(`${folder.remotePath}: ${errorMessage(error)}`);
          }
        }

        const mirrorSnapshot = {
          complete: mirrorSnapshotComplete,
          remoteIds: new Set(filesToSync.keys()),
          remoteFolders: this.data.mirroredFolders.map(
            (folder) => folder.remotePath,
          ),
        };
        activity.setLabel("Updating Mirror");
        if (mirrorSnapshotComplete) {
          for (const directory of directoriesToMirror.values()) {
            const remotePath = normalizeOptionalRelativePath(
              directory.remotePath,
            );
            const vaultPath = remotePath
              ? `${normalizeRelativePath(
                  this.data.settings.targetFolder,
                )}/${remotePath.split("/").map(vaultSafeName).join("/")}`
              : normalizeRelativePath(this.data.settings.targetFolder);
            await this.vaultStore.createDirectory(vaultPath);
            const previous =
              this.instanceState.mirrorDirectories[directory.remoteId];
            if (previous && previous.vaultPath !== vaultPath) {
              previousMirrorDirectoryPaths.push(previous.vaultPath);
            }
            this.instanceState.mirrorDirectories[directory.remoteId] = {
              remotePath: directory.remotePath,
              vaultPath,
            };
          }
        }
        for (const entry of Object.values(manifest.files)) {
          if (
            this.isInPushFolder(entry.remotePath) ||
            !shouldRemoveMissingMirrorEntry(entry, mirrorSnapshot)
          ) {
            continue;
          }
          try {
            const removed = await service.removeMirroredFile(
              entry.remoteId,
              manifest,
            );
            if (removed?.status === "removed") {
              removedFromMirror += 1;
              activity.append(
                "stdout",
                `Removed ${removed.remotePath} from the Mirror.\n`,
              );
            } else if (removed?.status === "protected") {
              protectedFiles.push(removed.remotePath);
            }
          } catch (error) {
            if (error instanceof SupernoteAuthExpiredError) {
              throw error;
            }
            failed.push(`${entry.remotePath}: ${errorMessage(error)}`);
          }
        }

        activity.append(
          "stdout",
          `Checking ${filesToSync.size} mirrored file${filesToSync.size === 1 ? "" : "s"}.\n`,
        );
        service.planMirrorPaths(filesToSync.values(), manifest);
        for (const input of filesToSync.values()) {
          try {
            const result = await service.mirrorFile(input, manifest);
            if (result.status === "mirrored") {
              synced += 1;
              activity.append("stdout", `Downloaded ${input.remotePath}.\n`);
            } else if (result.status === "protected") {
              protectedFiles.push(input.remotePath);
            } else {
              skipped += 1;
            }
          } catch (error) {
            if (error instanceof SupernoteAuthExpiredError) {
              throw error;
            }
            failed.push(`${input.remotePath}: ${errorMessage(error)}`);
          }
        }
        for (const vaultPath of previousMirrorDirectoryPaths.sort(
          (left, right) => right.split("/").length - left.split("/").length,
        )) {
          if (
            (await this.vaultStore.listFiles(vaultPath)).length === 0 &&
            (await this.vaultStore.exists(vaultPath))
          ) {
            await this.vaultStore.delete(vaultPath);
          }
        }
        if (mirrorSnapshotComplete) {
          for (const [remoteId, directory] of Object.entries(
            this.instanceState.mirrorDirectories,
          )) {
            if (directoriesToMirror.has(remoteId)) {
              continue;
            }
            const remotePath = normalizeOptionalRelativePath(
              directory.remotePath,
            );
            const covered = this.data.mirroredFolders.some((folder) => {
              const root = normalizeOptionalRelativePath(folder.remotePath);
              return (
                !root ||
                remotePath === root ||
                remotePath.startsWith(`${root}/`)
              );
            });
            if (!covered || this.isInPushFolder(directory.remotePath)) {
              continue;
            }
            const remainingFiles = await this.vaultStore.listFiles(
              directory.vaultPath,
            );
            if (remainingFiles.length === 0) {
              if (await this.vaultStore.exists(directory.vaultPath)) {
                await this.vaultStore.delete(directory.vaultPath);
              }
              delete this.instanceState.mirrorDirectories[remoteId];
            }
          }
          this.instanceStateStore.save(this.instanceState);
        }
        activity.append(
          "stdout",
          this.data.sendToSupernoteEnabled
            ? "Checking the Paired folder.\n"
            : "Paired folder is disabled.\n",
        );
        let pair: PairSyncResult = {
          baseline: emptyPairBaseline(),
          uploaded: [],
          downloaded: [],
          unchanged: [],
          deletedLocal: [],
          deletedRemote: [],
          movedLocal: [],
          movedRemote: [],
          createdLocalDirectories: [],
          createdRemoteDirectories: [],
          deletedLocalDirectories: [],
          deletedRemoteDirectories: [],
          conflicts: [],
        };
        if (this.data.sendToSupernoteEnabled) {
          activity.setLabel("Reconciling Pair");
          const directoryId = await this.resolvePairDirectoryId();
          const baselineKey = this.pairBaselineKey(directoryId);
          const baseline =
            this.instanceState.pairBaselines[baselineKey] ??
            emptyPairBaseline();
          const priorPairRemoteIds = new Set(
            Object.values(baseline.entries).map((entry) => entry.remoteId),
          );
          pair = await this.createPairSyncService(directoryId).reconcile(
            baseline,
            {
              onBaselineChange: (nextBaseline) => {
                this.instanceState.pairBaselines[baselineKey] = nextBaseline;
                this.instanceStateStore.save(this.instanceState);
              },
            },
          );
          this.instanceState.pairBaselines[baselineKey] = pair.baseline;
          this.instanceStateStore.save(this.instanceState);
          this.refreshPairConflictAttention();
          const currentPairRemoteIds = new Set(
            Object.values(pair.baseline.entries).map((entry) => entry.remoteId),
          );
          for (const remoteId of priorPairRemoteIds) {
            if (!currentPairRemoteIds.has(remoteId)) {
              delete manifest.files[remoteId];
            }
          }
          for (const entry of Object.values(pair.baseline.entries)) {
            manifest.files[entry.remoteId] = {
              remoteId: entry.remoteId,
              directoryId: entry.directoryId,
              fileName: entry.fileName,
              remotePath: `/${normalizeRelativePath(
                this.data.settings.pushFolder,
              )}/${entry.remoteRelativePath}`,
              md5: entry.checksum,
              updateTime: 0,
              vaultPath: `${normalizeRelativePath(
                this.data.settings.targetFolder,
              )}/${normalizeRelativePath(
                this.data.settings.pushFolder,
              )}/${entry.localRelativePath}`,
              syncedAt: new Date().toISOString(),
            };
          }
        }
        return {
          synced,
          skipped,
          removedFromMirror,
          protectedFiles,
          failed,
          pair,
          missingCloudNotes,
        };
      };

      const {
        synced,
        skipped,
        removedFromMirror,
        protectedFiles,
        failed,
        pair,
        missingCloudNotes,
      } = await transaction.run(run);

      if (
        synced > 0 ||
        skipped > 0 ||
        removedFromMirror > 0 ||
        pair.uploaded.length > 0 ||
        pair.downloaded.length > 0 ||
        pair.unchanged.length > 0 ||
        pair.deletedLocal.length > 0 ||
        pair.deletedRemote.length > 0 ||
        pair.createdLocalDirectories.length > 0 ||
        pair.createdRemoteDirectories.length > 0 ||
        pair.deletedLocalDirectories.length > 0 ||
        pair.deletedRemoteDirectories.length > 0
      ) {
        this.data.lastSyncAt = new Date().toISOString();
      }
      this.instanceState.lastFullSyncAt = new Date().toISOString();
      this.instanceStateStore.save(this.instanceState);
      this.data.missingCloudNotes = missingCloudNotes;
      const summary =
        `${synced + pair.downloaded.length} downloaded, ` +
        `${pair.uploaded.length} uploaded, ` +
        `${skipped + pair.unchanged.length} unchanged, ` +
        `${
          removedFromMirror +
          pair.deletedLocal.length +
          pair.deletedRemote.length +
          pair.deletedLocalDirectories.length +
          pair.deletedRemoteDirectories.length
        } removed`;
      const warnings = [
        ...protectedFiles.map((path) => `Protected local edit: ${path}`),
        ...pair.conflicts.map(
          (conflict) =>
            `Pair conflict (${conflict.kind}): ${this.data.settings.pushFolder}/${conflict.remoteRelativePath}`,
        ),
        ...failed,
      ];
      const outcome = syncCompletionOutcome(warnings.length);
      this.data.lastSyncOutcome = outcome;
      this.data.verifiedMirrorFolder = normalizeOptionalRelativePath(
        this.data.settings.targetFolder,
      );
      await this.persistData(this.data);
      if (warnings.length > 0) {
        for (const warning of warnings) {
          activity.append("stderr", `${warning}\n`);
        }
        new Notice(
          `${summary}, ${warnings.length} need attention.\n` +
            warnings.join("\n"),
          12_000,
        );
      } else {
        new Notice(summary);
      }
      activity.append("stdout", `${summary}.\n`);
      activity.finish(outcome);
      completed = true;
      diagnosticOutcome = "succeeded";
      return true;
    } catch (error) {
      diagnosticFailureCategory = performanceFailureCategory(error);
      activity.append("stderr", `${errorMessage(error)}\n`);
      activity.finish("failed");
      this.data.lastSyncOutcome = "failed";
      await this.persistData(this.data).catch(() => undefined);
      await this.reportError(error);
      return false;
    } finally {
      this.syncInProgress = false;
      window.clearInterval(diagnosticSampler);
      const diagnosticSettledBytes =
        this.notebookService?.snapshot().retainedBytes ?? 0;
      await this.finishPerformanceOperation(diagnosticOperation, {
        outcome: diagnosticOutcome,
        peakTrackedBytes: Math.max(diagnosticPeakBytes, diagnosticSettledBytes),
        settledTrackedBytes: diagnosticSettledBytes,
        failureCategory: diagnosticFailureCategory,
      });
      if (
        completed &&
        runAutomations &&
        this.instanceState.runAutomationsOnThisDevice
      ) {
        void this.runConfiguredWatchHooks();
      }
    }
  }

  private async mirrorAndOpenFile(
    file: CloudFile,
    remotePath: string,
  ): Promise<void> {
    if (this.syncInProgress) {
      const error = new Error("A Supernote sync is already running");
      await this.reportError(error);
      throw error;
    }
    if (this.mirrorMoveInProgress) {
      const error = new Error("A Mirror move is already running");
      await this.reportError(error);
      throw error;
    }
    const activity = this.runs.start({
      kind: "sync",
      label: `Mirroring ${file.fileName}`,
      engine: "cloud",
      model: "download",
    });
    activity.append("stdout", `Downloading ${remotePath}.\n`);
    this.syncInProgress = true;
    try {
      const result = await this.createSyncService().mirrorFile({
        file,
        remotePath,
      });
      this.data.lastSyncAt = new Date().toISOString();
      this.data.lastSyncOutcome = "succeeded";
      this.data.verifiedMirrorFolder = normalizeOptionalRelativePath(
        this.data.settings.targetFolder,
      );
      await this.persistData(this.data);
      const mirrored = this.app.vault.getAbstractFileByPath(result.vaultPath);
      if (!(mirrored instanceof TFile)) {
        throw new Error(`Mirrored file is unavailable at ${result.vaultPath}`);
      }
      if (result.status === "protected") {
        new Notice(
          `Kept local edits in ${result.vaultPath}; cloud did not overwrite them.`,
          10_000,
        );
      }
      try {
        await this.app.workspace.getLeaf("tab").openFile(mirrored);
      } catch {
        new Notice(`Mirrored ${file.fileName} to ${result.vaultPath}.`);
      }
      activity.append("stdout", `Available at ${result.vaultPath}.\n`);
      activity.finish("succeeded");
    } catch (error) {
      activity.append("stderr", `${errorMessage(error)}\n`);
      activity.finish("failed");
      this.data.lastSyncOutcome = "failed";
      await this.persistData(this.data).catch(() => undefined);
      await this.reportError(error);
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  private async openDownloadedCloudFile(
    file: CloudFile,
    remotePath: string,
  ): Promise<void> {
    const manifest = await loadManifest(
      this.vaultStore,
      this.createSyncService().manifestPath,
    );
    const normalizedRemotePath = normalizeOptionalRelativePath(remotePath);
    const entry =
      manifest.files[file.id] ??
      Object.values(manifest.files).find(
        (candidate) =>
          normalizeOptionalRelativePath(candidate.remotePath) ===
          normalizedRemotePath,
      );
    const downloaded = entry
      ? this.app.vault.getAbstractFileByPath(entry.vaultPath)
      : null;
    if (downloaded instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(downloaded);
      return;
    }
    await this.mirrorAndOpenFile(file, remotePath);
  }

  private async exportLocalPages(
    rawNotePath: string,
    options: {
      selectedPages: readonly number[];
      useOcr: boolean;
      format: ExportFormat;
      filename: string;
      destination: string;
      customPrompt?: string;
      transcription?: TranscriptionSelection;
    },
    displayedSession?: NotebookSessionLease,
  ): Promise<PageExportResult | null> {
    if (this.syncInProgress) {
      throw new Error("A Supernote sync is already running");
    }
    if (this.mirrorMoveInProgress) {
      throw new Error("A Mirror move is already running");
    }
    this.syncInProgress = true;
    const diagnosticOperation = await this.beginPerformanceOperation("export");
    let diagnosticPeakBytes =
      this.notebookService?.snapshot().retainedBytes ?? 0;
    const diagnosticSampler = window.setInterval(() => {
      diagnosticPeakBytes = Math.max(
        diagnosticPeakBytes,
        this.notebookService?.snapshot().retainedBytes ?? 0,
      );
    }, 50);
    let diagnosticOutcome: "succeeded" | "failed" | "cancelled" = "failed";
    let diagnosticFailureCategory: string | null = null;
    try {
      const selection = this.transcriptionSelection(options.transcription);
      if (
        options.useOcr &&
        (selection.engine === "claude" || selection.engine === "codex")
      ) {
        const binary = await this.resolveAgentBinary(selection.engine);
        if (!binary) {
          const label =
            selection.engine === "claude" ? "Claude Code" : "Codex CLI";
          const status = this.agentBinaryStatus(selection.engine);
          throw new Error(
            status.state === "unavailable" && status.reason === "not-executable"
              ? `${label} was found but could not be executed`
              : `${label} was not found in PATH`,
          );
        }
      }
      const ocr = options.useOcr ? this.createOcrService(selection) : undefined;
      const run = (overwrite: boolean): Promise<PageExportResult> =>
        this.createExportService(ocr).exportPages({
          rawNotePath,
          ...(displayedSession ? { displayedSession } : {}),
          ...options,
          overwrite,
        });
      try {
        const result = await run(false);
        diagnosticOutcome = "succeeded";
        return result;
      } catch (error) {
        if (!(error instanceof ExportCollisionError)) {
          throw error;
        }
        const overwrite = await confirmExportOverwrite(this.app, error.paths);
        if (!overwrite) {
          diagnosticOutcome = "cancelled";
          return null;
        }
        const result = await run(true);
        diagnosticOutcome = "succeeded";
        return result;
      }
    } catch (error) {
      diagnosticFailureCategory = performanceFailureCategory(error);
      throw error;
    } finally {
      this.syncInProgress = false;
      window.clearInterval(diagnosticSampler);
      const diagnosticSettledBytes =
        this.notebookService?.snapshot().retainedBytes ?? 0;
      await this.finishPerformanceOperation(diagnosticOperation, {
        outcome: diagnosticOutcome,
        peakTrackedBytes: Math.max(diagnosticPeakBytes, diagnosticSettledBytes),
        settledTrackedBytes: diagnosticSettledBytes,
        failureCategory: diagnosticFailureCategory,
      });
    }
  }

  private async getExportDefaults(
    rawNotePath: string,
  ): Promise<ExportDefaults> {
    return this.createExportService().getDefaults(rawNotePath);
  }

  private createSyncService(): SyncService {
    return new SyncService({
      cloud: this.cloud,
      vault: this.vaultStore,
      notebooks: this.getNotebookService(),
      targetFolder: this.data.settings.targetFolder,
    });
  }

  private createPairSyncService(directoryId: string): PairSyncService {
    return new PairSyncService({
      cloud: this.cloud,
      vault: this.vaultStore,
      targetFolder: this.data.settings.targetFolder,
      remoteFolder: this.data.settings.pushFolder,
      remoteDirectoryId: directoryId,
    });
  }

  private pairConflicts(): PairConflict[] {
    return Object.values(this.instanceState.pairBaselines).flatMap((baseline) =>
      Object.values(baseline.conflicts),
    );
  }

  private refreshPairConflictAttention(): void {
    const count = this.pairConflicts().length;
    this.runs.setAttention(
      count === 1
        ? "1 Pair conflict needs attention"
        : `${count} Pair conflicts need attention`,
      count,
    );
  }

  private async resolvePairConflict(
    conflictId: string,
    resolution: PairConflictResolution,
  ): Promise<void> {
    if (!this.data.sendToSupernoteEnabled) {
      throw new Error("Enable the Paired folder before resolving conflicts.");
    }
    if (this.syncInProgress || this.mirrorMoveInProgress) {
      throw new Error("Wait for the current Supernote activity to finish.");
    }
    const directoryId = await this.resolvePairDirectoryId();
    const baselineKey = this.pairBaselineKey(directoryId);
    const baseline = this.instanceState.pairBaselines[baselineKey];
    if (!baseline?.conflicts[conflictId]) {
      this.refreshPairConflictAttention();
      return;
    }
    const activity = this.runs.start({
      kind: "sync",
      label: "Resolving Pair conflict",
      engine: "cloud",
      model: "pair",
    });
    this.syncInProgress = true;
    try {
      const priorRemoteIds = new Set(
        Object.values(baseline.entries).map((entry) => entry.remoteId),
      );
      const result = await this.createPairSyncService(directoryId).reconcile(
        baseline,
        {
          resolutions: { [conflictId]: resolution },
          onBaselineChange: (nextBaseline) => {
            this.instanceState.pairBaselines[baselineKey] = nextBaseline;
            this.instanceStateStore.save(this.instanceState);
          },
        },
      );
      const transaction = await SyncManifestTransaction.open(
        this.vaultStore,
        this.createSyncService().manifestPath,
      );
      await transaction.run(async (manifest) => {
        const currentRemoteIds = new Set(
          Object.values(result.baseline.entries).map((entry) => entry.remoteId),
        );
        for (const remoteId of priorRemoteIds) {
          if (!currentRemoteIds.has(remoteId)) {
            delete manifest.files[remoteId];
          }
        }
        for (const entry of Object.values(result.baseline.entries)) {
          manifest.files[entry.remoteId] = {
            remoteId: entry.remoteId,
            directoryId: entry.directoryId,
            fileName: entry.fileName,
            remotePath: `/${normalizeRelativePath(
              this.data.settings.pushFolder,
            )}/${entry.remoteRelativePath}`,
            md5: entry.checksum,
            updateTime: 0,
            vaultPath: `${normalizeRelativePath(
              this.data.settings.targetFolder,
            )}/${normalizeRelativePath(
              this.data.settings.pushFolder,
            )}/${entry.localRelativePath}`,
            syncedAt: new Date().toISOString(),
          };
        }
      });
      this.instanceState.pairBaselines[baselineKey] = result.baseline;
      this.instanceStateStore.save(this.instanceState);
      this.refreshPairConflictAttention();
      activity.append(
        "stdout",
        `Applied ${resolution} and verified the Paired folder.\n`,
      );
      activity.finish(result.conflicts.length === 0 ? "succeeded" : "failed");
    } catch (error) {
      activity.append("stderr", `${errorMessage(error)}\n`);
      activity.finish("failed");
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  private pairBaselineKey(directoryId: string): string {
    return `${directoryId}:${normalizeRelativePath(
      this.data.settings.pushFolder,
    )}`;
  }

  private async resolvePairDirectoryId(): Promise<string> {
    if (this.data.pairDirectoryId) {
      return this.data.pairDirectoryId;
    }
    let directoryId = "0";
    for (const segment of normalizeRelativePath(
      this.data.settings.pushFolder,
    ).split("/")) {
      const directory = (await this.cloud.listDirectory(directoryId)).find(
        (item) => item.isFolder && item.fileName === segment,
      );
      if (!directory?.isFolder) {
        throw new Error(
          `Paired Remote folder is unavailable: ${this.data.settings.pushFolder}`,
        );
      }
      directoryId = directory.id;
    }
    this.data.pairDirectoryId = directoryId;
    await this.persistData(this.data);
    return directoryId;
  }

  private createWatchHookService(): WatchHookService {
    const agent = new AutomationAgentService({
      resolveBinary: (engine) => this.agentBinaryPath(engine),
      timeoutMs: 10 * 60_000,
    });
    return new WatchHookService({
      vault: this.vaultStore,
      notebooks: this.getNotebookService(),
      targetFolder: this.data.settings.targetFolder,
      isDesktop: Platform.isDesktopApp,
      runs: this.runs,
      ...(Platform.isDesktopApp
        ? {
            createTempBatch: () => createDesktopBatch("supernote-automation-"),
            runCommand: (command, observer) =>
              runDesktopCommand(command, {
                ...(observer ? { observer } : {}),
              }),
            runAgent: (request, observer) => agent.run(request, observer),
            absoluteVaultPath: (path: string) => {
              const adapter = this.app.vault.adapter;
              if (!(adapter instanceof FileSystemAdapter)) {
                throw new Error(
                  "Automation keep folders require a filesystem-backed vault on desktop",
                );
              }
              return adapter.getFullPath(path);
            },
          }
        : {}),
      notify: (message) => new Notice(message, 12_000),
    });
  }

  private refreshWatchHookCommands(): void {
    this.registeredWatchCommands = refreshAutomationCommands({
      commandIds: this.registeredWatchCommands,
      getHooks: () => this.data.settings.watchHooks,
      targetFolder: () => this.data.settings.targetFolder,
      isLoggedIn: () => this.isLoggedIn,
      isRunning: () =>
        this.watchHooksInProgress ||
        this.syncInProgress ||
        this.mirrorMoveInProgress,
      isActionAvailable: (hook) =>
        this.isAutomationActionAvailable(hook.action),
      register: (command) => {
        this.addCommand(command);
      },
      remove: (commandId) => this.removeCommand(commandId),
      run: (hookId) => {
        void this.runWatchHookManually(hookId);
      },
    });
  }

  async runWatchHookManually(hookId: string): Promise<void> {
    const synced = await this.syncMirroredNotebooks(false);
    if (synced) {
      await this.runConfiguredWatchHooks([hookId]);
    }
  }

  private async runConfiguredWatchHooks(
    hookIds?: readonly string[],
  ): Promise<void> {
    if (this.watchHooksInProgress) {
      if (hookIds) {
        new Notice("Supernote Automations are already running.");
      } else {
        this.watchHooksRerunRequested = true;
      }
      return;
    }
    if (this.mirrorMoveInProgress) {
      if (hookIds) {
        new Notice("Wait for the current Mirror move to finish.");
      } else {
        this.watchHooksRerunRequested = true;
      }
      return;
    }
    this.watchHooksInProgress = true;
    try {
      const configured = this.data.settings.watchHooks.filter(
        (hook) =>
          (!hookIds || hookIds.includes(hook.id)) &&
          !getWatchHookConfigurationWarning(
            hook,
            this.data.settings.targetFolder,
          ),
      );
      if (Platform.isDesktopApp) {
        await Promise.all(
          [
            ...new Set(
              configured.flatMap((hook) =>
                hook.action === "claude" || hook.action === "codex"
                  ? [hook.action]
                  : [],
              ),
            ),
          ].map((engine) => this.resolveAgentBinary(engine)),
        );
      }
      const selected = configured.filter((hook) =>
        this.isAutomationActionAvailable(hook.action),
      );
      if (selected.length === 0) {
        return;
      }

      const service = this.createWatchHookService();
      for (const hook of selected) {
        try {
          const result = await service.run(hook);
          const message = automationResultNotice(
            hook,
            result,
            hookIds !== undefined,
          );
          if (message) {
            new Notice(message);
          }
        } catch (error) {
          new Notice(
            `Automation "${hook.name}" failed: ${errorMessage(error)}`,
            12_000,
          );
        }
      }
    } finally {
      const rerun = this.watchHooksRerunRequested;
      this.watchHooksRerunRequested = false;
      this.watchHooksInProgress = false;
      if (rerun) {
        void this.runConfiguredWatchHooks();
      }
    }
  }

  private createExportService(ocr?: OcrPort): ExportService {
    return new ExportService({
      vault: this.vaultStore,
      notebooks: this.getNotebookService(),
      pdfExporter: this.lazyPdfExporter,
      attachmentPath: async (filename, sourcePath) =>
        this.app.fileManager.getAvailablePathForAttachment(
          filename,
          sourcePath,
        ),
      targetFolder: this.data.settings.targetFolder,
      ...(ocr ? { ocr } : {}),
    });
  }

  private createOcrService(
    selection: TranscriptionSelection,
  ): OcrPort | undefined {
    const settings = this.data.settings;
    if (selection.engine === "command") {
      if (!Platform.isDesktopApp || !settings.transcriptionCommand.trim()) {
        return undefined;
      }
      return new CommandOcrService({
        command: settings.transcriptionCommand,
        timeoutMs: Math.max(1, settings.transcriptionTimeoutMinutes) * 60_000,
        runs: this.runs,
      });
    }
    if (selection.engine === "claude" || selection.engine === "codex") {
      const binaryPath = this.agentBinaryPath(selection.engine);
      if (!Platform.isDesktopApp || !binaryPath) {
        return undefined;
      }
      const common = {
        binaryPath,
        model: selection.model,
        timeoutMs: Math.max(1, settings.transcriptionTimeoutMinutes) * 60_000,
        runs: this.runs,
      };
      return selection.engine === "claude"
        ? new AgentOcrService({
            ...common,
            engine: "claude",
            maxBudgetUsd: settings.transcriptionClaudeMaxBudgetUsd,
          })
        : new AgentOcrService({
            ...common,
            engine: "codex",
          });
    }
    if (!settings.transcriptionApiKey.trim()) {
      return undefined;
    }
    const request: ChatCompletionExecutor = async (options) => {
      const requestOptions: RequestUrlParam = {
        url: options.url,
        method: options.method,
        throw: false,
      };
      if (options.headers !== undefined) {
        requestOptions.headers = options.headers;
      }
      if (options.body !== undefined) {
        requestOptions.body = options.body;
      }
      const response = await requestUrl(requestOptions);
      return {
        status: response.status,
        json: response.json,
      };
    };

    return new ApiOcrService({
      baseUrl: settings.transcriptionApiBaseUrl,
      apiKey: settings.transcriptionApiKey,
      model: selection.model,
      extraInstructions: settings.transcriptionExtraInstructions,
      request,
      runs: this.runs,
    });
  }

  getTranscriptionAvailability(): TranscriptionAvailability {
    const configured = this.transcriptionSelection();
    const engines = (
      [
        {
          engine: "api",
          label: "OpenAI-compatible API",
          model: this.data.settings.transcriptionApiModel,
        },
        {
          engine: "claude",
          label: this.agentBinaryLabel("claude"),
          model: this.data.settings.transcriptionClaudeModel,
        },
        {
          engine: "codex",
          label: this.agentBinaryLabel("codex"),
          model: this.data.settings.transcriptionCodexModel,
        },
        { engine: "command", label: "Custom command", model: "" },
      ] satisfies Array<{
        engine: TranscriptionEngine;
        label: string;
        model: string;
      }>
    ).filter(
      (option) =>
        (Platform.isDesktopApp || option.engine === "api") &&
        (option.engine === "claude" || option.engine === "codex"
          ? this.agentBinaryStatus(option.engine).state !== "unavailable"
          : this.isTranscriptionEngineAvailable(option.engine)),
    );
    const selected =
      engines.find((option) => option.engine === configured.engine) ??
      engines[0] ??
      configured;
    return {
      visible: true,
      enabled: engines.length > 0,
      hint:
        engines.length > 0
          ? this.transcriptionEngineHint(selected.engine)
          : "Configure an available transcription engine in plugin settings.",
      engine: selected.engine,
      model: selected.model,
      engines,
      loadApiModels: () => this.loadApiModels(),
    };
  }

  isTranscriptionEngineAvailable(engine: TranscriptionEngine): boolean {
    if (!Platform.isDesktopApp && engine !== "api") {
      return false;
    }
    if (engine === "api") {
      return Boolean(this.data.settings.transcriptionApiKey.trim());
    }
    if (engine === "command") {
      return Boolean(this.data.settings.transcriptionCommand.trim());
    }
    return this.agentBinaryStatus(engine).state === "available";
  }

  transcriptionEngineHint(engine: TranscriptionEngine): string {
    if (engine === "api") {
      return this.isTranscriptionEngineAvailable(engine)
        ? "Uses the configured API on desktop and mobile."
        : "Add an API key to use this engine.";
    }
    if (engine === "command") {
      return this.isTranscriptionEngineAvailable(engine)
        ? "Runs the configured command once for each export batch."
        : "Add a transcription command to use this engine.";
    }
    const label = engine === "claude" ? "Claude Code" : "Codex CLI";
    const status = this.agentBinaryStatus(engine);
    return status.state === "available"
      ? `Uses the installed ${label} login; credentials stay in the CLI.`
      : status.state === "unknown"
        ? `${label} will be checked when configured or first used.`
        : status.state === "checking"
          ? `Checking ${label} availability…`
          : status.reason === "not-executable"
            ? `${label} was found but could not be executed.`
            : `${label} was not found in PATH.`;
  }

  async loadApiModels(
    draftBaseUrl = this.data.settings.transcriptionApiBaseUrl,
  ): Promise<readonly ApiModelOption[]> {
    const baseUrl = draftBaseUrl.trim().replace(/\/+$/, "");
    return this.apiModelCatalog.load(baseUrl, async () => {
      const response = await requestUrl({
        url: `${baseUrl}/models`,
        method: "GET",
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Model catalog returned HTTP ${response.status}`);
      }
      return response.json;
    });
  }

  private transcriptionSelection(
    override: {
      engine?: TranscriptionEngine;
      model?: string;
    } = {},
  ): TranscriptionSelection {
    const models = {
      claude: this.data.settings.transcriptionClaudeModel,
      codex: this.data.settings.transcriptionCodexModel,
      api: this.data.settings.transcriptionApiModel,
    };
    const requestedEngine =
      override.engine ?? this.data.settings.transcriptionEngine;
    return effectiveTranscriptionSelection(
      {
        engine: requestedEngine,
        model: override.model ?? defaultModelForEngine(requestedEngine, models),
      },
      Platform.isDesktopApp,
      models,
    );
  }

  private agentBinaryPath(engine: DesktopAgentBinary): string | null {
    const status = this.agentBinaryStatus(engine);
    return status.state === "available" ? status.path : null;
  }

  private async resolveAgentBinary(
    engine: DesktopAgentBinary,
  ): Promise<string | null> {
    if (!Platform.isDesktopApp) {
      return null;
    }
    const path = await this.binaryResolver.resolve(engine);
    this.refreshWatchHookCommands();
    return path;
  }

  private scheduleConfiguredAgentWarmup(): void {
    if (!Platform.isDesktopApp) {
      return;
    }
    const engines = new Set<DesktopAgentBinary>();
    const transcriptionEngine = this.data.settings.transcriptionEngine;
    if (transcriptionEngine === "claude" || transcriptionEngine === "codex") {
      engines.add(transcriptionEngine);
    }
    for (const hook of this.data.settings.watchHooks) {
      if (hook.action === "claude" || hook.action === "codex") {
        engines.add(hook.action);
      }
    }
    if (engines.size === 0) {
      return;
    }

    let timer: number | null = null;
    this.register(() => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    });
    this.app.workspace.onLayoutReady(() => {
      timer = window.setTimeout(() => {
        timer = null;
        for (const engine of engines) {
          void this.resolveAgentBinary(engine);
        }
      }, 0);
    });
  }

  private getNotebookService(): NotebookService {
    this.notebookService ??= new NotebookService({
      createWorker: () => new NotebookWorker(),
      notifyRenderingUnavailable: (message) => new Notice(message, 12_000),
      maxConcurrentRenders: Platform.isMobile ? 1 : 2,
    });
    return this.notebookService;
  }

  private getChecksumService(): ChecksumService {
    this.checksumService ??= new ChecksumService(() => new ChecksumWorker());
    return this.checksumService;
  }

  private loadPdfExporter(): Promise<PdfExporter> {
    this.pdfExporterInitialization ??= import(
      "./export/pdf-worker-client"
    ).then(
      ({ WorkerPdfExporter }) => new WorkerPdfExporter(() => new PdfWorker()),
    );
    return this.pdfExporterInitialization;
  }

  private loadMarkdownPdfRenderer(): Promise<MarkdownPdfPort> {
    this.markdownPdfInitialization ??= import(
      "./export/pdf-worker-client"
    ).then(
      ({ WorkerMarkdownPdfRenderer }) =>
        new WorkerMarkdownPdfRenderer(() => new PdfWorker()),
    );
    return this.markdownPdfInitialization;
  }

  private async attachExportedPageNavigation(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
  ): Promise<void> {
    const sourceFile = this.app.vault.getAbstractFileByPath(context.sourcePath);
    if (!(sourceFile instanceof TFile)) {
      return;
    }
    const frontmatter =
      this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
    const sourceNote = frontmatter?.["supernote-note"];
    const pages = frontmatter?.["supernote-pages"];
    const sectionStart = context.getSectionInfo(element)?.lineStart ?? 0;
    const markdown = await this.app.vault.cachedRead(sourceFile);
    const imageOffset = countImageEmbedsBeforeLine(markdown, sectionStart);
    const images = [...element.querySelectorAll<HTMLImageElement>("img")];
    for (const [imageIndex, image] of images.entries()) {
      if (image.dataset.supernoteReaderLink === "true") {
        continue;
      }
      const resolved = resolveExportedPage(
        sourceNote,
        pages,
        imageOffset + imageIndex,
      );
      if (!resolved) {
        continue;
      }
      const note = this.app.vault.getAbstractFileByPath(resolved.rawNotePath);
      if (!(note instanceof TFile)) {
        continue;
      }
      image.addClass("supernote-page-reader-trigger");
      image.dataset.supernoteReaderLink = "true";
      image.tabIndex = 0;
      const open = (): void => {
        void this.app.workspace.openLinkText(
          exportedPageReaderLink({
            rawNotePath: note.path,
            pageNumber: resolved.pageNumber,
          }),
          context.sourcePath,
        );
      };
      image.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      });
      image.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    }
  }

  private attachSupernoteEmbeds(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
  ): void {
    const section = context.getSectionInfo(element);
    const sourceSpecs = parseFixedPageEmbeds(section?.text ?? "");
    const replaced = new Set<HTMLElement>();
    for (const { element: embed, spec } of matchFixedPageEmbedElements(
      element,
      sourceSpecs,
    )) {
      const file = this.app.metadataCache.getFirstLinkpathDest(
        spec.linkpath,
        context.sourcePath,
      );
      const container = document.createElement("figure");
      replaced.add(embed);
      embed.replaceWith(container);
      const open = (page: number | null): void => {
        const linkpath = file?.path ?? spec.linkpath;
        void this.app.workspace.openLinkText(
          `${linkpath}${page === null ? "" : `#page=${page}`}`,
          context.sourcePath,
        );
      };
      context.addChild(
        new FixedPageReadingView(container, {
          app: this.app,
          file,
          spec,
          notebooks: this.getNotebookService(),
          openPage: () => open(spec.pageNumber),
          openNotebook: () => open(spec.pageNumber),
        }),
      );
    }
    const invalidSpecs = parseInvalidFixedPageEmbeds(section?.text ?? "");
    for (const { element: embed, spec } of matchInvalidFixedPageEmbedElements(
      element,
      invalidSpecs,
    )) {
      if (replaced.has(embed)) {
        continue;
      }
      const file = this.app.metadataCache.getFirstLinkpathDest(
        spec.linkpath,
        context.sourcePath,
      );
      const container = document.createElement("figure");
      embed.replaceWith(container);
      context.addChild(
        new InvalidFixedPageReadingView(container, {
          file,
          spec,
          openNotebook: () => {
            void this.app.workspace.openLinkText(
              file?.path ?? spec.linkpath,
              context.sourcePath,
            );
          },
        }),
      );
    }
    const notebookSpecs = parseNotebookEmbeds(section?.text ?? "");
    for (const { element: embed, spec } of matchNotebookEmbedElements(
      element,
      notebookSpecs,
    )) {
      if (replaced.has(embed)) {
        continue;
      }
      const file = this.app.metadataCache.getFirstLinkpathDest(
        spec.linkpath,
        context.sourcePath,
      );
      const container = document.createElement("figure");
      embed.replaceWith(container);
      context.addChild(
        new NotebookReadingView(container, {
          app: this.app,
          file,
          spec,
          notebooks: this.getNotebookService(),
          openReader: (pageNumber) => {
            const linkpath = file?.path ?? spec.linkpath;
            void this.app.workspace.openLinkText(
              `${linkpath}#page=${pageNumber}`,
              context.sourcePath,
            );
          },
        }),
      );
    }
  }

  private async maybeAutoSync(): Promise<void> {
    const interval = this.autoSyncMinutes;
    if (
      interval <= 0 ||
      !this.isLoggedIn ||
      this.syncInProgress ||
      this.mirrorMoveInProgress
    ) {
      return;
    }

    const now = Date.now();
    const lastCompletedSync = this.instanceState.lastFullSyncAt
      ? Date.parse(this.instanceState.lastFullSyncAt)
      : 0;
    const intervalStart = Math.max(
      this.lastAutoSyncAttempt,
      Number.isFinite(lastCompletedSync) ? lastCompletedSync : 0,
    );
    if (now - intervalStart < interval * 60_000) {
      return;
    }
    this.lastAutoSyncAttempt = now;
    await this.syncMirroredNotebooks();
  }

  private async reportError(error: unknown): Promise<void> {
    if (error instanceof SupernoteAuthExpiredError) {
      this.cloud.logout();
      this.data.token = null;
      this.instanceState.sessionToken = null;
      this.instanceStateStore.save(this.instanceState);
      await this.persistData(this.data);
    }
    new Notice(errorMessage(error), 10_000);
  }
}
