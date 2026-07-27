import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const production = process.argv[2] === "production";
const workerInputPaths = new Map();
const compressedFonts = new Map();
const compressedFontPlugin = {
  name: "compressed-font",
  setup(build) {
    build.onLoad({ filter: /\.ttf$/ }, async (args) => {
      const source = await readFile(args.path);
      const compressed = gzipSync(source, { level: 9 });
      compressedFonts.set(args.path, {
        compressedBytes: compressed.byteLength,
        sourceBytes: source.byteLength,
      });
      return {
        contents: compressed,
        loader: "binary",
      };
    });
  },
};

const inlineWorkerPlugin = {
  name: "inline-worker",
  setup(build) {
    build.onResolve({ filter: /\?worker&inline$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?worker&inline$/, "")),
      namespace: "inline-worker",
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-worker" }, async (args) => {
      const worker = await esbuild.build({
        entryPoints: [args.path],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: production,
        metafile: production,
        loader: {
          ".ttf": "binary",
        },
        plugins: [compressedFontPlugin],
      });
      workerInputPaths.set(
        args.path,
        new Set(Object.keys(worker.metafile?.inputs ?? {})),
      );
      const source = worker.outputFiles[0]?.text;
      if (!source) {
        throw new Error(`Could not bundle worker at ${args.path}`);
      }
      return {
        contents: `
            export default class InlineWorker extends Worker {
              constructor() {
                const url = URL.createObjectURL(
                  new Blob([${JSON.stringify(source)}], {
                    type: "text/javascript",
                  }),
                );
                super(url);
                URL.revokeObjectURL(url);
              }
            }
          `,
        loader: "js",
        watchFiles: [args.path],
      };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  minify: production,
  metafile: production,
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  loader: {
    ".ttf": "binary",
  },
  plugins: [compressedFontPlugin, inlineWorkerPlugin],
});

if (production) {
  const result = await context.rebuild();
  await context.dispose();
  const output = await readFile("main.js");
  const mainInputPaths = Object.keys(result.metafile?.inputs ?? {});
  const inputsForWorker = (name) => {
    const entry = [...workerInputPaths.entries()].find(([path]) =>
      path.endsWith(name),
    );
    return [...(entry?.[1] ?? [])];
  };
  const notebookWorkerInputPaths = inputsForWorker("notebook.worker.ts");
  const pdfWorkerInputPaths = inputsForWorker("pdf.worker.ts");
  const allWorkerInputPaths = [
    ...new Set([...notebookWorkerInputPaths, ...pdfWorkerInputPaths]),
  ];
  const packagesIn = (paths, packageName) =>
    new Set(
      paths
        .filter((path) => path.includes(`node_modules/.pnpm/${packageName}@`))
        .map(
          (path) =>
            path.match(
              new RegExp(`node_modules/\\.pnpm/${packageName}@([^/]+)`),
            )?.[1],
        )
        .filter(Boolean),
    );
  const assertAbsent = (paths, packageNames, scope) => {
    const present = packageNames.filter((packageName) =>
      paths.some((path) => path.includes(`node_modules/.pnpm/${packageName}@`)),
    );
    if (present.length > 0) {
      throw new Error(
        `${scope} bundle contains unexpected package stack: ${present.join(", ")}`,
      );
    }
  };
  assertAbsent(
    mainInputPaths,
    [
      "@pdf-lib+fontkit",
      "fast-png",
      "image-js",
      "jpeg-js",
      "marked",
      "pako",
      "pdf-lib",
      "supernote-typescript",
      "tiff",
    ],
    "Main",
  );
  assertAbsent(
    notebookWorkerInputPaths,
    ["@pdf-lib+fontkit", "marked", "pdf-lib"],
    "Notebook worker",
  );
  assertAbsent(
    pdfWorkerInputPaths,
    ["fast-png", "image-js", "jpeg-js", "supernote-typescript", "tiff"],
    "PDF worker",
  );
  for (const [scope, paths] of [
    ["Main", mainInputPaths],
    ["Notebook worker", notebookWorkerInputPaths],
    ["PDF worker", pdfWorkerInputPaths],
  ]) {
    const pakoVersions = packagesIn(paths, "pako");
    if (pakoVersions.size > 1) {
      throw new Error(
        `${scope} bundle contains duplicate pako versions: ${[...pakoVersions].join(", ")}`,
      );
    }
  }
  const fontSourceBytes = [...compressedFonts.values()].reduce(
    (total, font) => total + font.sourceBytes,
    0,
  );
  const fontCompressedBytes = [...compressedFonts.values()].reduce(
    (total, font) => total + font.compressedBytes,
    0,
  );
  const report = {
    bundle: {
      brotliBytes: brotliCompressSync(output, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        },
      }).byteLength,
      gzipBytes: gzipSync(output, { level: 9 }).byteLength,
      rawBytes: output.byteLength,
    },
    fonts: {
      compressedBytes: fontCompressedBytes,
      decodedBytes: fontSourceBytes,
    },
    stacks: {
      mainPakoVersions: [...packagesIn(mainInputPaths, "pako")],
      workerPakoVersions: [...packagesIn(allWorkerInputPaths, "pako")],
    },
  };
  if (report.bundle.rawBytes > 4 * 1024 * 1024) {
    throw new Error(
      `Production main.js is ${report.bundle.rawBytes} bytes; limit is 4194304 bytes`,
    );
  }
  console.log(`Production bundle report: ${JSON.stringify(report)}`);
} else {
  await context.watch();
}
