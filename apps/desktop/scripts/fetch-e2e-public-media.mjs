// Explicit test-only staging from the original author's immutable public URL.
// Never imported by the app, packaged, or added to the model-resource archive.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import identity from "../e2e/fixtures/public-media.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function verifyPublicMedia(bytes, expected = identity) {
  if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
    throw new Error("Public E2E image identity mismatch; no substitute is allowed");
  }
}
export async function downloadPublicMedia(fetcher = fetch, expected = identity) {
  const response = await fetcher(expected.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Public E2E image download failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected.bytes) throw new Error("Public E2E image exceeds the pinned size");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks); verifyPublicMedia(bytes, expected); return bytes;
}
async function main() {
  const directory = path.join(root, ".cache", "e2e-public-fixtures");
  const file = path.join(directory, identity.name);
  try { verifyPublicMedia(await readFile(file)); console.log("[public-e2e-media] existing identity verified"); return; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const bytes = await downloadPublicMedia();
  await mkdir(directory, { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
  console.log(`[public-e2e-media] staged ${bytes.length} verified bytes for local tests only`);
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
