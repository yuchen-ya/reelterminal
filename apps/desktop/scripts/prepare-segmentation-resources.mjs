/** Stage only the validated MobileSAM pair; never downloads or exports models. */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = path.join(desktopRoot, "resources", "segmentation");
const outputRoot = path.join(resourceRoot, "mobilesam");
const manifestPath = path.join(resourceRoot, "mobilesam-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
if (!check && !(args.length === 2 && args[0] === "--source-dir" && args[1])) {
  throw new Error("Usage: node scripts/prepare-segmentation-resources.mjs --source-dir <validated-model-directory> | --check");
}
const sourceRoot = check ? outputRoot : path.resolve(args[1]);

// Validate both before copying either. These digests identify the approved graph
// conversion, rather than merely accepting any same-sized ONNX files.
for (const file of Object.values(manifest.files)) {
  const source = path.join(sourceRoot, file.name);
  const info = statSync(source);
  if (!info.isFile() || info.size !== file.bytes) {
    throw new Error(`MobileSAM file size mismatch: ${source}`);
  }
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (digest !== file.sha256) throw new Error(`MobileSAM identity mismatch: ${source}`);
}

const notices = ["LICENSE-MobileSAM.txt", "NOTICE-MobileSAM.txt"];
if (check) {
  if (readFileSync(path.join(outputRoot, "manifest.json"), "utf8") !== readFileSync(manifestPath, "utf8")) {
    throw new Error("Staged MobileSAM manifest differs from the approved manifest; prepare resources again");
  }
  for (const name of notices) {
    if (!readFileSync(path.join(outputRoot, name)).equals(readFileSync(path.join(desktopRoot, "LICENSES", name)))) {
      throw new Error(`Staged MobileSAM notice differs: ${name}; prepare resources again`);
    }
  }
} else {
  mkdirSync(outputRoot, { recursive: true });
  for (const file of Object.values(manifest.files)) copyFileSync(path.join(sourceRoot, file.name), path.join(outputRoot, file.name));
  copyFileSync(manifestPath, path.join(outputRoot, "manifest.json"));
  for (const name of notices) copyFileSync(path.join(desktopRoot, "LICENSES", name), path.join(outputRoot, name));
}
console.log(`[segmentation-resources] ${check ? "verified" : "prepared"} ${manifest.modelVersion} at ${outputRoot}`);
