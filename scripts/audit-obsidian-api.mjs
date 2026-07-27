import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
  );
}
const config = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  root,
  undefined,
  configPath,
);
const apiDeclaration = process.env.OBSIDIAN_API_DECLARATION
  ? resolve(process.env.OBSIDIAN_API_DECLARATION)
  : null;
const program = ts.createProgram(config.fileNames, {
  ...config.options,
  ...(apiDeclaration
    ? {
        baseUrl: root,
        paths: {
          ...config.options.paths,
          obsidian: [apiDeclaration],
        },
      }
    : {}),
});
const checker = program.getTypeChecker();
const records = new Map();
const compatibilityOverrides = new Map([
  ["member:FileView.navigation", "0.15.1"],
  ["method:ButtonComponent.setDisabled", "1.2.3"],
  ["method:ButtonComponent.setIcon", "1.1.0"],
  ["method:ButtonComponent.setTooltip", "1.1.0"],
  ["method:DropdownComponent.setDisabled", "1.2.3"],
  ["method:FileManager.getAvailablePathForAttachment", "1.5.7"],
  ["method:FileManager.trashFile", "1.6.6"],
  ["method:ItemView.addAction", "1.1.0"],
  ["method:Plugin.removeCommand", "1.7.2"],
  ["method:ToggleComponent.setDisabled", "1.2.3"],
  ["method:Vault.createFolder", "1.4.0"],
  ["method:Vault.process", "1.1.0"],
]);

const declarationIsObsidian = (declaration) =>
  apiDeclaration
    ? resolve(declaration.getSourceFile().fileName) === apiDeclaration
    : declaration
        .getSourceFile()
        .fileName.replaceAll("\\", "/")
        .endsWith("/obsidian/obsidian.d.ts");

const sinceFor = (symbol) => {
  const tag = symbol.getJsDocTags(checker).find(({ name }) => name === "since");
  if (!tag?.text) {
    return null;
  }
  return (
    tag.text
      .map((part) => part.text)
      .join("")
      .trim()
      .match(/\d+\.\d+\.\d+/)?.[0] ?? null
  );
};

const declaringType = (symbol) => {
  const declaration = symbol.declarations?.find(declarationIsObsidian);
  const parent = declaration?.parent;
  return parent && "name" in parent && parent.name
    ? parent.name.getText()
    : "obsidian";
};

const add = (kind, name, symbol, sourceFile) => {
  if (!symbol.declarations?.some(declarationIsObsidian)) {
    return;
  }
  const key = `${kind}:${name}`;
  const existing = records.get(key);
  const usedBy = relative(root, sourceFile.fileName).replaceAll("\\", "/");
  if (existing) {
    existing.usedBy.add(usedBy);
    return;
  }
  records.set(key, {
    kind,
    name,
    since: sinceFor(symbol) ?? compatibilityOverrides.get(key) ?? null,
    usedBy: new Set([usedBy]),
  });
};

for (const sourceFile of program.getSourceFiles()) {
  const sourcePath = relative(resolve(root, "src"), sourceFile.fileName);
  if (
    sourceFile.isDeclarationFile ||
    sourcePath.startsWith("..") ||
    isAbsolute(sourcePath)
  ) {
    continue;
  }
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "obsidian"
    ) {
      for (const element of node.importClause?.namedBindings?.elements ?? []) {
        const symbol = checker.getSymbolAtLocation(element.name);
        const target =
          symbol && symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        if (target) {
          add(
            "import",
            element.propertyName?.text ?? element.name.text,
            target,
            sourceFile,
          );
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        add(
          ts.isCallExpression(node.parent) && node.parent.expression === node
            ? "method"
            : "member",
          `${declaringType(symbol)}.${node.name.text}`,
          symbol,
          sourceFile,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// ObsidianVaultStore injects FileManager as a narrow port, so TypeScript sees
// the local interface rather than the Obsidian declaration at the call site.
records.set("method:FileManager.trashFile", {
  kind: "method",
  name: "FileManager.trashFile",
  since: compatibilityOverrides.get("method:FileManager.trashFile"),
  usedBy: new Set(["src/sync/obsidian-vault-store.ts"]),
});

const versions = [...records.values()]
  .map(({ since }) => since)
  .filter(Boolean);
const compareVersions = (left, right) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};
const floor = versions.sort(compareVersions).at(-1);
if (!floor) {
  throw new Error("Could not derive an Obsidian API floor.");
}

const manifest = JSON.parse(
  readFileSync(resolve(root, "manifest.json"), "utf8"),
);
const versionsManifest = JSON.parse(
  readFileSync(resolve(root, "versions.json"), "utf8"),
);
const errors = [];
if (manifest.minAppVersion !== floor) {
  errors.push(
    `manifest.json minAppVersion is ${manifest.minAppVersion}; computed ${floor}`,
  );
}
if (versionsManifest[manifest.version] !== floor) {
  errors.push(
    `versions.json maps ${manifest.version} to ${versionsManifest[manifest.version]}; computed ${floor}`,
  );
}

const sorted = [...records.values()].sort(
  (left, right) =>
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
);
for (const record of sorted) {
  console.log(
    `${record.kind}\t${record.name}\t${record.since ?? "pre-annotation"}\t${[...record.usedBy].sort().join(", ")}`,
  );
}
console.log(`Computed minimum Obsidian version: ${floor}`);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}
