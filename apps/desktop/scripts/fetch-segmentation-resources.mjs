// Explicit build/CI resource staging. Never called by application startup.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MOBILE_SAM_DOWNLOAD = Object.freeze({
  url: "https://github.com/yuchen-ya/reelterminal/releases/download/resources-mobilesam-f706ad9c-v1/mobilesam-f706ad9c-fp32-split-v1.zip",
  bytes: 36672492,
  sha256: "2487d04d9130d882c4c7adc0a59466c10c9733dff95bdae6d8395b0a2b260444",
});
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// Git may check out notices/manifests as CRLF on Windows and LF on macOS/Linux.
const canonicalText = bytes => bytes.toString("utf8").replaceAll("\r\n", "\n");

export function verifyArchive(bytes, expected = MOBILE_SAM_DOWNLOAD) {
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error("MobileSAM download identity mismatch; nothing was staged");
  }
}

export async function downloadArchive(fetcher = fetch, expected = MOBILE_SAM_DOWNLOAD) {
  const response = await fetcher(expected.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`MobileSAM download failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected.bytes) throw new Error("MobileSAM download exceeds the pinned size");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  verifyArchive(bytes, expected);
  return bytes;
}

async function extractArchive(archive, directory) {
  // Reuse the cross-platform extractor already pinned by our direct Electron dependency.
  const require = createRequire(import.meta.url);
  const electronRequire = createRequire(require.resolve("electron"));
  const { extract } = await import(pathToFileURL(electronRequire.resolve("@electron-internal/extract-zip")).href);
  await extract(archive, { dir: directory });
}

export async function validateExtractedModels(directory, targetRoot = desktopRoot) {
  const manifestBytes = await readFile(path.join(targetRoot, "resources/segmentation/mobilesam-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const expected = new Map(Object.values(manifest.files).map(file => [file.name, { bytes: file.bytes, sha256: file.sha256 }]));
  expected.set("manifest.json", { text: canonicalText(manifestBytes) });
  for (const name of ["LICENSE-MobileSAM.txt", "NOTICE-MobileSAM.txt"]) {
    const bytes = await readFile(path.join(targetRoot, "LICENSES", name));
    expected.set(name, { text: canonicalText(bytes) });
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some(entry => !entry.isFile() || !expected.has(entry.name))) {
    throw new Error("MobileSAM archive contains unexpected or missing entries");
  }
  for (const [name, identity] of expected) {
    const bytes = await readFile(path.join(directory, name));
    const matches = identity.text !== undefined
      ? canonicalText(bytes) === identity.text
      : bytes.length === identity.bytes && sha256(bytes) === identity.sha256;
    if (!matches) {
      throw new Error(`MobileSAM archive member identity mismatch: ${name}`);
    }
  }
}

export async function stageArchive(bytes, { targetRoot = desktopRoot, extract = extractArchive, prepare } = {}) {
  // Reject untrusted bytes before invoking any ZIP extractor or touching generated resources.
  verifyArchive(bytes);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "reelterminal-mobilesam-stage-"));
  try {
    const archive = path.join(temporary, "models.zip");
    const extracted = path.join(temporary, "models");
    await writeFile(archive, bytes, { flag: "wx" });
    await extract(archive, extracted);
    await validateExtractedModels(extracted, targetRoot);
    const runPrepare = prepare ?? (source => execFileSync(process.execPath, [path.join(targetRoot, "scripts/prepare-segmentation-resources.mjs"), "--source-dir", source], { windowsHide: true, stdio: "pipe" }));
    await runPrepare(extracted);
  } finally {
    // Only remove the exact temporary directory created by this invocation.
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("reelterminal-mobilesam-stage-")) throw new Error("Unsafe staging cleanup target");
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.length && !(args.length === 2 && args[0] === "--archive")) throw new Error("Usage: fetch-segmentation-resources.mjs [--archive <pinned-archive>]");
  if (!args.length) {
    try {
      execFileSync(process.execPath, [path.join(desktopRoot, "scripts/prepare-segmentation-resources.mjs"), "--check"], { windowsHide: true, stdio: "pipe" });
      console.log("[segmentation-resources] existing staged assets verified");
      return;
    } catch { /* Explicit fetch requested; download only the pinned archive. */ }
  }
  const bytes = args.length ? await readFile(path.resolve(args[1])) : await downloadArchive();
  await stageArchive(bytes);
  console.log("[segmentation-resources] pinned archive and all five members verified and staged");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
