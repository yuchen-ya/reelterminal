import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile, open, stat, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReviewFileStore } from "./review-file-store";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reel-review-files-"));
  directories.push(directory);
  const sourcePath = path.join(directory, "source.txt");
  await writeFile(sourcePath, "original exact bytes\r\n");
  const root = path.join(directory, "review");
  const input = { operationId: randomUUID(), resourceId: randomUUID(), sourcePath, mime: "text/plain", source: "user" as const };
  return { directory, root, input, store: new ReviewFileStore(root) };
}

describe("review managed file preparation with real filesystem IO", () => {
  it("collects old unregistered crash leftovers after restart while retaining registered resources and external sources", async () => {
    const { root, input, store } = await fixture();
    const orphan = await store.prepare(input);
    const kept = await store.prepare({ ...input, operationId: randomUUID(), resourceId: randomUUID() });
    const external = await store.prepare({ ...input, operationId: randomUUID(), resourceId: randomUUID(), mode: "external" });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const resource of [orphan, kept, external]) await utimes(path.join(root, "resources", resource.id), old, old);
    expect((await store.collectUnregistered([])).removed).toBe(0);
    const restarted = new ReviewFileStore(root);
    expect((await restarted.collectUnregistered([kept.id])).removed).toBe(2);
    expect((await restarted.resolve(kept.id, true)).resource.id).toBe(kept.id);
    expect(await readFile(input.sourcePath, "utf8")).toBe("original exact bytes\r\n");
    await expect(restarted.resolve(orphan.id)).rejects.toMatchObject({ reason: "MISSING_FILE" });
  });
  it("copies exact bytes, survives a new store, and never links to the external source", async () => {
    const { root, input, store } = await fixture();
    const resource = await store.prepare(input);
    const resolved = await new ReviewFileStore(root).resolve(resource.id, true);
    expect(await readFile(resolved.path, "utf8")).toBe("original exact bytes\r\n");
    await writeFile(input.sourcePath, "changed outside");
    expect(await readFile(resolved.path, "utf8")).toBe("original exact bytes\r\n");
    expect((await store.prepare(input)).sha256).toBe(resource.sha256);
  });

  it("detects a changed external reference without changing or deleting its source", async () => {
    const { input, store } = await fixture();
    const resource = await store.prepare({ ...input, mode: "external" });
    await writeFile(input.sourcePath, "external edit");
    await expect(store.resolve(resource.id, true)).rejects.toMatchObject({ reason: "SOURCE_CHANGED" });
    expect(await readFile(input.sourcePath, "utf8")).toBe("external edit");
  });

  it("reuses a frozen managed copy after temporary-source relocation and rejects changed bytes before publication", async () => {
    const { directory, input, store } = await fixture();
    const resource = await store.prepare({ ...input, originalFileName: "legacy.txt" });
    const relocated = path.join(directory, "new-temporary-source.txt");
    await writeFile(relocated, "original exact bytes\r\n");
    expect(await store.prepare({ ...input, sourcePath: relocated, originalFileName: "legacy.txt", expectedHash: resource.sha256 })).toEqual(resource);
    await writeFile(relocated, "unexpected replacement bytes");
    const nextId = randomUUID();
    await expect(store.prepare({ ...input, resourceId: nextId, sourcePath: relocated, expectedHash: resource.sha256 })).rejects.toMatchObject({ reason: "SOURCE_CHANGED" });
    await expect(store.resolve(nextId)).rejects.toMatchObject({ reason: "MISSING_FILE" });
    expect(await readFile((await store.resolve(resource.id, true)).path, "utf8")).toBe("original exact bytes\r\n");
  });

  it("recovers publication without metadata by retrying the same prepared identity", async () => {
    const { root, input, store } = await fixture();
    const first = await store.prepare(input);
    await unlink(path.join(root, "resources", first.id, "resource.json"));
    const retried = await new ReviewFileStore(root).prepare(input);
    expect(retried).toEqual(first);
    expect(await readFile((await store.resolve(first.id, true)).path, "utf8")).toBe("original exact bytes\r\n");
  });

  it("rejects traversal IDs, missing files and an already aborted preparation", async () => {
    const { root, input, store } = await fixture();
    await expect(store.prepare({ ...input, resourceId: "../../outside" })).rejects.toMatchObject({ reason: "INVALID_PARAMS" });
    await expect(store.prepare({ ...input, sourcePath: path.join(root, "absent") })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.prepare({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(path.join(root, "staging", input.operationId))).toEqual([]);
  });

  it("recovers abandoned staging after a real helper process is killed during streaming", async () => {
    const { directory, root, input } = await fixture();
    const source = await open(input.sourcePath, "w");
    await source.truncate(512 * 1024 * 1024);
    await source.close();
    const bundle = path.join(directory, "store.cjs");
    await build({ entryPoints: [fileURLToPath(new URL("./review-file-store.ts", import.meta.url))], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const helper = path.join(directory, "prepare.cjs");
    await writeFile(helper, `const {ReviewFileStore}=require(${JSON.stringify(bundle)});new ReviewFileStore(${JSON.stringify(root)}).prepare(${JSON.stringify(input)}).then(()=>console.log('completed'));`);
    const child = spawn(process.execPath, ["--max-old-space-size=96", helper], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    const staging = path.join(root, "staging", input.operationId);
    let observedPartial = false;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && child.exitCode === null && !observedPartial) {
        let entries: string[];
        try { entries = await readdir(staging); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
        for (const entry of entries) {
          const facts = await stat(path.join(staging, entry));
          if (entry.startsWith(".part-") && facts.size > 0 && facts.size < 512 * 1024 * 1024) observedPartial = true;
        }
        if (!observedPartial) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(observedPartial, stderr).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await exit;
    }
    const recovered = new ReviewFileStore(root);
    const resource = await recovered.prepare(input);
    expect(resource.size).toBe(512 * 1024 * 1024);
    expect((await recovered.resolve(resource.id, true)).resource.sha256).toBe(resource.sha256);
    expect(await readdir(staging)).toEqual([]);
  }, 30_000);
});
