import { readFile } from "node:fs/promises";

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(tag)) {
  throw new Error(
    `Release tag must be exact SemVer without a v prefix: ${tag}`,
  );
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const packageJson = await readJson("package.json");
const manifest = await readJson("manifest.json");
const versions = await readJson("versions.json");

if (packageJson.version !== tag || manifest.version !== tag) {
  throw new Error(
    `Tag ${tag}, package ${packageJson.version}, and manifest ${manifest.version} must match`,
  );
}
if (versions[tag] !== manifest.minAppVersion) {
  throw new Error(`versions.json must map ${tag} to ${manifest.minAppVersion}`);
}

console.log(
  `Release declarations accepted: ${tag}, Obsidian ${manifest.minAppVersion}+`,
);
