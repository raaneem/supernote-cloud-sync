import { spawnSync } from "node:child_process";

const allowedLicenses = new Set([
  "(MIT AND Zlib)",
  "(WTFPL OR MIT)",
  "0BSD",
  "Apache-2.0",
  "BSD-3-Clause",
  "GPL-3.0-or-later",
  "ISC",
  "MIT",
  "MIT AND OFL-1.1",
  "Public Domain",
  "WTFPL OR ISC",
]);

const report =
  process.platform === "win32"
    ? spawnSync("pnpm licenses list --prod --json", {
        encoding: "utf8",
        shell: true,
      })
    : spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
        encoding: "utf8",
      });

if (report.error) {
  console.error(`Unable to run pnpm license audit: ${report.error.message}`);
  process.exit(1);
}

if (report.status !== 0) {
  process.stderr.write(report.stderr ?? "");
  process.exit(report.status ?? 1);
}

const licenses = JSON.parse(report.stdout ?? "");
const unexpected = Object.keys(licenses).filter(
  (license) => !allowedLicenses.has(license),
);

if (unexpected.length > 0) {
  console.error(
    `Unexpected production license${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
  );
  process.exit(1);
}

const packageCount = Object.values(licenses).reduce(
  (count, packages) => count + packages.length,
  0,
);
console.log(
  `Production dependency licenses accepted (${packageCount} packages, ${Object.keys(licenses).length} expressions).`,
);
