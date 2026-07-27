import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicReadmePath = resolve(root, "README.md");
const hasPublicReadme = existsSync(publicReadmePath);
const markdownFiles = [
  ...(hasPublicReadme ? ["README.md"] : []),
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/decisions/README.md",
  ".github/pull_request_template.md",
];
const requiredFiles = [
  ...markdownFiles,
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/windows_beta_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  "CHANGELOG.md",
];
const errors = [];

for (const relativePath of requiredFiles) {
  if (!existsSync(resolve(root, relativePath))) {
    errors.push(`Missing contributor file: ${relativePath}`);
  }
}

if (hasPublicReadme) {
  const publicReadme = readFileSync(publicReadmePath, "utf8");
  for (const target of [
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
  ]) {
    if (!publicReadme.includes(`](${target})`)) {
      errors.push(`README.md must link to ${target}`);
    }
  }
}

const markdownLinkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
const intentionallyPublicSchemes = /^(?:https?:|mailto:)/;
const forbiddenPrivatePaths = /(?:^|\/)(?:tickets|docs\/adr)(?:\/|$)/;

for (const relativePath of markdownFiles) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    continue;
  }

  const source = readFileSync(absolutePath, "utf8");
  for (const match of source.matchAll(markdownLinkPattern)) {
    const target = match[1]?.trim();
    if (
      !target ||
      target.startsWith("#") ||
      intentionallyPublicSchemes.test(target)
    ) {
      continue;
    }

    const path = target.split("#", 1)[0];
    if (!path || forbiddenPrivatePaths.test(path)) {
      errors.push(`${relativePath} links to private material: ${target}`);
      continue;
    }

    const resolvedTarget = resolve(dirname(absolutePath), path);
    const relativeTarget = relative(root, resolvedTarget);
    const escapesRoot =
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget);
    if (
      escapesRoot ||
      !existsSync(resolvedTarget) ||
      (!statSync(resolvedTarget).isFile() &&
        !existsSync(resolve(resolvedTarget, "README.md")))
    ) {
      errors.push(`${relativePath} has broken internal link: ${target}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(
  `Contributor documents accepted (${requiredFiles.length} files; internal links resolve${hasPublicReadme ? " and README cross-links are present" : "; public README cross-links deferred"}).`,
);
