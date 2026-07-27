const { readFileSync, statSync } = require("node:fs");
const Module = require("node:module");
const { resolve } = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

const bundlePath = resolve(process.argv[2] ?? "main.js");
const benchmarkPlatform = process.argv[3] ?? "desktop";
const benchmarkMode = process.argv[4] ?? "activation";
const source = readFileSync(bundlePath, "utf8");

const inert = new Proxy(function InertObsidianValue() {}, {
  apply: () => inert,
  construct: () => inert,
  get: (_target, property) => {
    if (property === Symbol.toPrimitive) {
      return () => 0;
    }
    if (property === "prototype") {
      return {};
    }
    return inert;
  },
});

const benchmarkApp = {
  fileManager: {
    getAvailablePathForAttachment: async (name) => name,
  },
  metadataCache: {
    getFileCache: () => null,
  },
  vault: {
    adapter: {},
    cachedRead: async () => "",
    getAbstractFileByPath: () => null,
    getFiles: () => [],
  },
  workspace: {
    getActiveFile: () => null,
    on: () => ({}),
    onLayoutReady: () => undefined,
  },
};

class BenchmarkPlugin {
  constructor() {
    this.app = benchmarkApp;
  }

  addCommand() {}
  addRibbonIcon() {}
  addSettingTab() {}
  addStatusBarItem() {
    return inert;
  }
  async loadData() {
    return null;
  }
  register() {}
  registerEditorExtension() {}
  registerEvent() {}
  registerExtensions() {}
  registerInterval(interval) {
    clearInterval(interval);
  }
  registerMarkdownPostProcessor() {}
  registerView() {}
  removeCommand() {}
  async saveData() {}
}

class BenchmarkModal {
  constructor(app) {
    this.app = app;
    this.contentEl = inert;
  }

  close() {}
  open() {}
  setTitle() {}
}

const obsidianValues = {
  FileSystemAdapter: class BenchmarkFileSystemAdapter {},
  Modal: BenchmarkModal,
  Platform: {
    isDesktopApp: benchmarkPlatform === "desktop",
    isMobile: benchmarkPlatform === "mobile",
  },
  Plugin: BenchmarkPlugin,
  PluginSettingTab: class BenchmarkPluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = inert;
    }
  },
  requestUrl: async () => {
    throw new Error("Startup benchmark attempted a network request");
  },
};
const obsidianStub = new Proxy(obsidianValues, {
  get: (target, property) => (property in target ? target[property] : inert),
});

const originalLoad = Module._load;
Module._load = function benchmarkLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return obsidianStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.Worker = class BenchmarkWorker {
  onmessage = null;
  onerror = null;

  addEventListener() {}

  postMessage(request) {
    queueMicrotask(() => {
      const response =
        request.type === "native-start"
          ? { type: "ready", id: request.id }
          : request.type === "native-page"
            ? {
                type: "page-consumed",
                id: request.id,
                pageNumber: request.page.pageNumber,
              }
            : request.type === "native-finish"
              ? {
                  type: "native-result",
                  id: request.id,
                  pdf: new ArrayBuffer(0),
                }
              : null;
      if (response) {
        this.onmessage?.({ data: response });
      }
    });
  }

  terminate() {}
};
globalThis.window = {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
};
globalThis.document = {
  addEventListener() {},
  body: inert,
  createDocumentFragment: () => inert,
  documentElement: { style: {} },
  removeEventListener() {},
};

const ownedBytes = (memory) => memory.heapUsed + memory.external;

const main = async () => {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const evaluationStart = performance.now();
  const compiled = new Module(bundlePath);
  compiled.filename = bundlePath;
  compiled.paths = Module._nodeModulePaths(resolve(bundlePath, ".."));
  compiled._compile(source, bundlePath);
  const moduleEvaluationMs = performance.now() - evaluationStart;
  const PluginClass = compiled.exports.default;
  if (typeof PluginClass !== "function") {
    throw new Error("Production bundle did not export the plugin class");
  }
  const plugin = new PluginClass();
  const onloadStart = performance.now();
  await plugin.onload();
  const onloadMs = performance.now() - onloadStart;
  let pdfFirstUseMaxTaskMs = 0;
  let pdfFirstUseMs = 0;
  if (benchmarkMode === "pdf-first-use") {
    const delay = monitorEventLoopDelay({ resolution: 1 });
    let intervalDelayMs = 0;
    let lastIntervalAt = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      intervalDelayMs = Math.max(intervalDelayMs, now - lastIntervalAt - 1);
      lastIntervalAt = now;
    }, 1);
    delay.enable();
    await new Promise((resolveDelay) => setImmediate(resolveDelay));
    const firstUseStart = performance.now();
    const exporter = await plugin.loadPdfExporter();
    await exporter.export([
      {
        height: 1,
        pageNumber: 1,
        pageText: "",
        png: new Uint8Array(256 * 1024),
        positionedText: [],
        width: 1,
      },
    ]);
    pdfFirstUseMs = performance.now() - firstUseStart;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    clearInterval(interval);
    delay.disable();
    pdfFirstUseMaxTaskMs = Math.max(
      delay.max / 1_000_000,
      intervalDelayMs,
      pdfFirstUseMs,
    );
  }
  plugin.onunload();
  globalThis.gc?.();
  const after = process.memoryUsage();

  process.stdout.write(
    JSON.stringify({
      bundleBytes: statSync(bundlePath).size,
      moduleEvaluationMs,
      onloadMs,
      pdfFirstUseMaxTaskMs,
      pdfFirstUseMs,
      retainedBytes: Math.max(0, ownedBytes(after) - ownedBytes(before)),
    }),
  );
};

void main().catch((error) => {
  process.stderr.write(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
