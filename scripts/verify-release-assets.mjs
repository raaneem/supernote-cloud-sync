import { access, stat } from "node:fs/promises";

const assets = ["main.js", "manifest.json", "styles.css"];
for (const asset of assets) {
  await access(asset);
  if (!(await stat(asset)).isFile()) {
    throw new Error(`Release asset is not a file: ${asset}`);
  }
}
console.log(`Release install set accepted: ${assets.join(", ")}`);
