import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  arch,
  cpus,
  platform as operatingSystem,
  release,
  totalmem,
} from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type BenchmarkPlatform,
  type BenchmarkProfile,
  evaluateScenario,
  roundResult,
  type ScenarioResult,
} from "./harness";
import { runScenario, type ScenarioName, scenarioNames } from "./scenarios";
import {
  REFERENCE_GRID_PAGES,
  REFERENCE_NOTEBOOK_PAGES,
  REFERENCE_SYNC_BYTES,
  REFERENCE_SYNC_FILES,
} from "./workloads";

interface CliOptions {
  device: string;
  forceBudgetFailure: boolean;
  note?: string;
  output?: string;
  platform: BenchmarkPlatform;
  profile: BenchmarkProfile;
  record: boolean;
  scenarios: ScenarioName[];
}

const pluginRoot = resolve(import.meta.dirname, "..");

const readValue = (
  arguments_: readonly string[],
  index: number,
  name: string,
): string => {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
};

const parseScenario = (value: string): ScenarioName[] => {
  if (value === "all") {
    return [...scenarioNames];
  }
  const names = value.split(",");
  for (const name of names) {
    if (!scenarioNames.includes(name as ScenarioName)) {
      throw new Error(
        `Unknown scenario ${name}; expected ${scenarioNames.join(", ")}, or all`,
      );
    }
  }
  return names as ScenarioName[];
};

export const parseArguments = (arguments_: readonly string[]): CliOptions => {
  const options: CliOptions = {
    device: "local-reference",
    forceBudgetFailure: false,
    platform: "desktop",
    profile: "standard",
    record: false,
    scenarios: [...scenarioNames],
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--":
        break;
      case "--device":
        options.device = readValue(arguments_, index, argument);
        index += 1;
        break;
      case "--force-budget-failure":
        options.forceBudgetFailure = true;
        break;
      case "--note":
        options.note = resolve(readValue(arguments_, index, argument));
        index += 1;
        break;
      case "--output":
        options.output = resolve(readValue(arguments_, index, argument));
        index += 1;
        break;
      case "--platform": {
        const value = readValue(arguments_, index, argument);
        if (value !== "desktop" && value !== "mobile") {
          throw new Error("--platform must be desktop or mobile");
        }
        options.platform = value;
        index += 1;
        break;
      }
      case "--profile": {
        const value = readValue(arguments_, index, argument);
        if (
          value !== "smoke" &&
          value !== "standard" &&
          value !== "reference"
        ) {
          throw new Error("--profile must be smoke, standard, or reference");
        }
        options.profile = value;
        index += 1;
        break;
      }
      case "--record":
        options.record = true;
        break;
      case "--scenario":
        options.scenarios = parseScenario(
          readValue(arguments_, index, argument),
        );
        index += 1;
        break;
      default:
        throw new Error(`Unknown benchmark argument: ${argument}`);
    }
  }
  if (options.note && !existsSync(options.note)) {
    throw new Error("Private benchmark note does not exist");
  }
  return options;
};

const git = (...arguments_: string[]): string => {
  const result = spawnSync("git", arguments_, {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
};

const packageManifest = JSON.parse(
  readFileSync(resolve(pluginRoot, "package.json"), "utf8"),
) as { version: string };
const obsidianManifest = JSON.parse(
  readFileSync(resolve(pluginRoot, "manifest.json"), "utf8"),
) as { minAppVersion: string; version: string };

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  if (
    options.scenarios.includes("cold-activation") &&
    !existsSync(resolve(pluginRoot, "main.js"))
  ) {
    throw new Error(
      "main.js is missing; run pnpm run build:bundle before the cold-activation benchmark",
    );
  }
  const scenarios: ScenarioResult[] = [];
  for (const name of options.scenarios) {
    scenarios.push(
      evaluateScenario(
        await runScenario(name, {
          platform: options.platform,
          pluginRoot,
          profile: options.profile,
          ...(options.note ? { privateNote: options.note } : {}),
        }),
        options.forceBudgetFailure,
      ),
    );
  }
  const report = roundResult({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      device: options.device,
      gitCommit: git("rev-parse", "--short", "HEAD"),
      gitDirty: git("status", "--porcelain").length > 0,
      node: process.version,
      obsidianMinimumVersion: obsidianManifest.minAppVersion,
      obsidianPluginVersion: obsidianManifest.version,
      operatingSystem: operatingSystem(),
      operatingSystemRelease: release(),
      packageVersion: packageManifest.version,
      platform: options.platform,
      totalMemoryBytes: totalmem(),
    },
    profile: options.profile,
    referenceWorkloads: {
      gridPages: REFERENCE_GRID_PAGES,
      notebookPages: REFERENCE_NOTEBOOK_PAGES,
      syncFiles: REFERENCE_SYNC_FILES,
      syncTotalBytes: REFERENCE_SYNC_BYTES,
    },
    scenarios: scenarios.map(({ timings, ...scenario }) => ({
      ...scenario,
      timings: {
        maxMs: timings.maxMs,
        p50Ms: timings.p50Ms,
        p95Ms: timings.p95Ms,
        sampleCount: timings.samplesMs.length,
        totalMs: timings.samplesMs.reduce((total, sample) => total + sample, 0),
      },
    })),
    passed: scenarios.every((scenario) => scenario.passed),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, json);
  }
  process.stdout.write(json);
  if (options.forceBudgetFailure || (!report.passed && !options.record)) {
    process.exitCode = 1;
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
