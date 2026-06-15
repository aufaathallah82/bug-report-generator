const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const manifestPath = join(root, "manifest.json");
const requiredFiles = ["background.js", "content.js", "pageLogger.js", "popup.js", "popup.html", "styles.css"];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json must use manifest_version 3.");
}

for (const file of requiredFiles) {
  readFileSync(join(root, file), "utf8");
}

for (const file of requiredFiles.filter((name) => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log("Extension validation passed.");
