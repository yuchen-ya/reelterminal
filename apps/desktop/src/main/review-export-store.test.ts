import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes, open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReviewExportPlan } from "@reelterminal/core/review/export";
import { ReviewFileStore } from "./review-file-store";
import { ReviewExportStore } from "./review-export-store";

const directories: string[] = [];
let activeRecovery: { cancel: AbortController; settled: Promise<void> } | undefined;
afterEach(async () => {
  // A Vitest timeout does not cancel an async test. Stop the serial fixture and
  // wait for its current disk operation before removing its directories.
  const active = activeRecovery;
  if (active) { active.cancel.abort(); await active.settled; }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "reel-review-export-"));
  directories.push(directory);
  const resources = new ReviewFileStore(path.join(directory, "resources"));
  const store = new ReviewExportStore(path.join(directory, "exports"), resources);
  const plan: ReviewExportPlan = { exportId: randomUUID(), nodeId: randomUUID(), nodeRevision: 4, name: "Node", mode: "original", scope: "node", entries: [] };
  return { directory, resources, store, plan };
}

describe("frozen review exports with actual filesystem copies", () => {
  it("streams a >256 MiB original through formal preparation and destination copying with identical bytes", async () => {
    const { directory, resources, store, plan } = await setup();
    const source = path.join(directory, "large.bin");
    const size = 257 * 1024 * 1024 + 31;
    const handle = await open(source, "w");
    try {
      await handle.truncate(size);
      for (const [position, text] of [[0, "Large original start"], [Math.floor(size / 2), "Large original middle"], [size - 24, "Large original tail"]] as const) {
        await handle.write(Buffer.from(text), 0, Buffer.byteLength(text), position);
      }
    } finally { await handle.close(); }
    // Large binary IO fixture; playable-media decoding is covered separately.
    const resource = await resources.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: source, mime: "application/octet-stream", source: "user" });
    await store.prepare({ ...plan, entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "large.bin", resourceId: resource.id }] });
    expect((await store.wait(plan.exportId)).state).toBe("ready");
    const destination = path.join(directory, "copied");
    await mkdir(destination);
    const copied = await store.copy(plan.exportId, destination, plan.nodeId);
    const paths = [source, store.dragPaths(plan.exportId, false)[0], path.join(copied.directory, "large.bin")];
    for (const filename of paths) expect((await stat(filename)).size).toBe(size);
    const readers = await Promise.all(paths.map(filename => open(filename, "r")));
    const buffers = paths.map(() => Buffer.alloc(1024 * 1024));
    try {
      for (let position = 0; position < size; position += buffers[0].length) {
        const count = Math.min(buffers[0].length, size - position);
        const results = await Promise.all(readers.map((reader, index) => reader.read(buffers[index], 0, count, position)));
        expect(results.every(result => result.bytesRead === count)).toBe(true);
        expect(buffers[1].subarray(0, count).equals(buffers[0].subarray(0, count))).toBe(true);
        expect(buffers[2].subarray(0, count).equals(buffers[0].subarray(0, count))).toBe(true);
      }
    } finally { await Promise.all(readers.map(reader => reader.close())); }
  }, 30_000);

  it("fails a missing managed source without exposing output and can export a newly prepared replacement", async () => {
    const { directory, resources, store, plan } = await setup();
    const source = path.join(directory, "source.txt");
    await writeFile(source, "Source remains recoverable");
    const input = { operationId: randomUUID(), resourceId: randomUUID(), sourcePath: source, mime: "text/plain", source: "user" as const };
    const resource = await resources.prepare(input);
    await unlink((await resources.resolve(resource.id)).path);
    const entry = { itemId: randomUUID(), itemVersion: 1, fileName: "source.txt", resourceId: resource.id };
    await store.prepare({ ...plan, entries: [entry] });
    expect(await store.wait(plan.exportId)).toMatchObject({ state: "failed", error: { reason: "MISSING_FILE" } });
    expect(() => store.dragPaths(plan.exportId, false)).toThrow(/Prepare/);
    await expect(store.copy(plan.exportId, directory)).rejects.toMatchObject({ reason: "CONFLICT" });
    expect(await readFile(source, "utf8")).toBe("Source remains recoverable");
    const replacement = await resources.prepare({ ...input, operationId: randomUUID(), resourceId: randomUUID() });
    const retry = { ...plan, exportId: randomUUID(), entries: [{ ...entry, resourceId: replacement.id }] };
    await store.prepare(retry); expect((await store.wait(retry.exportId)).state).toBe("ready");
    expect(await readFile(store.dragPaths(retry.exportId, false)[0], "utf8")).toBe("Source remains recoverable");
  });
  it("cleans expired disposable exports at startup while preserving fresh copies and managed originals", async () => {
    const { directory, resources, store, plan } = await setup();
    const original = path.join(directory, "source.txt");
    await writeFile(original, "Managed original survives export expiry");
    const resource = await resources.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: original, mime: "text/plain", source: "user" });
    const frozen = { ...plan, entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "source.txt", resourceId: resource.id }] };
    await store.prepare(frozen);
    expect((await store.wait(plan.exportId)).state).toBe("ready");
    const expired = path.join(store.root, plan.exportId);
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(expired, past, past);
    const fresh = path.join(store.root, randomUUID());
    await mkdir(fresh); await writeFile(path.join(fresh, "fresh.txt"), "keep fresh copy");
    const restarted = new ReviewExportStore(store.root, resources);
    const next = { ...frozen, exportId: randomUUID() };
    await restarted.prepare(next);
    expect((await restarted.wait(next.exportId)).state).toBe("ready");
    expect(await readdir(store.root)).not.toContain(plan.exportId);
    expect(await readFile(path.join(fresh, "fresh.txt"), "utf8")).toBe("keep fresh copy");
    expect(await readFile((await resources.resolve(resource.id, true)).path, "utf8")).toBe("Managed original survives export expiry");
  });
  it("preserves exact originals, deduplicates resources, resolves name collisions, and isolates dragged copies", async () => {
    const { directory, resources, store, plan } = await setup();
    const source = path.join(directory, "original.txt");
    await writeFile(source, "Original 👀\r\nexact\0bytes", "utf8");
    const resource = await resources.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: source, mime: "text/plain", source: "user" });
    const frozen = { ...plan, entries: [
      { itemId: randomUUID(), itemVersion: 1, fileName: "Same.txt", resourceId: resource.id },
      { itemId: randomUUID(), itemVersion: 1, fileName: "Alias.txt", resourceId: resource.id },
      { itemId: randomUUID(), itemVersion: 3, fileName: "same.TXT", text: "Serialized\ntext", serialization: "utf8-text" as const },
    ] };
    expect(["queued", "preparing"]).toContain((await store.prepare(frozen)).state);
    const ready = await store.wait(plan.exportId);
    expect(ready.state).toBe("ready");
    expect(ready.manifest?.entries.map(entry => entry.relativePath)).toEqual(["Same.txt", "Same.txt", "same (2).TXT"]);
    const [dragged] = store.dragPaths(plan.exportId, false);
    expect((await readFile(dragged)).equals(await readFile(source))).toBe(true);
    const parent = path.join(directory, "destination");
    await mkdir(path.join(parent, "Node"), { recursive: true });
    await writeFile(path.join(parent, "Node", "keep.txt"), "existing");
    const copied = await store.copy(plan.exportId, parent, plan.nodeId);
    expect(path.basename(copied.directory)).toBe("Node (2)");
    expect(new Set(await readdir(copied.directory))).toEqual(new Set(["Same.txt", "manifest.json", "same (2).TXT"]));
    expect((await readFile(path.join(copied.directory, "Same.txt"))).equals(await readFile(source))).toBe(true);
    await rm(dragged);
    expect(() => store.dragPaths(plan.exportId, false)).toThrow(/moved or deleted/);
    expect(() => store.dragPaths(plan.exportId, true)).toThrow(/moved or deleted/);
    expect((await resources.resolve(resource.id, true)).resource.sha256).toBe(resource.sha256);
    expect(await readFile(path.join(parent, "Node", "keep.txt"), "utf8")).toBe("existing");
    await expect(store.prepare({ ...frozen, nodeRevision: 5 })).rejects.toThrow(/reused/);
    await expect(store.status(plan.exportId, randomUUID())).rejects.toThrow(/belong/);
    await expect(store.status(randomUUID(), plan.nodeId)).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("recovers evicted ready jobs from disk and keeps internal receipts outside the dragged folder", { timeout: 120_000 }, async () => {
    const cancel = new AbortController();
    const run = async () => {
      const { store, resources, plan } = await setup();
      const startedAt = Date.now();
      const plans = Array.from({ length: 65 }, (_, index): ReviewExportPlan => ({
        ...plan,
        exportId: randomUUID(),
        name: index === 0 ? "control" : "Node " + index,
        entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "status.json", text: "value " + index, serialization: "utf8-text" }],
      }));
      for (const [index, frozen] of plans.entries()) {
        if (cancel.signal.aborted) return;
        await store.prepare(frozen);
        expect((await store.wait(frozen.exportId)).state).toBe("ready");
        if (process.env.CI && (index + 1) % 16 === 0) console.info(`export recovery fixture: ${index + 1}/65 ready in ${Date.now() - startedAt}ms`);
      }
      if (process.env.CI) console.info(`export recovery fixture: 65/65 ready in ${Date.now() - startedAt}ms; checking eviction and disk recovery`);

      const cache = (store as unknown as {
        jobs: Map<string, { plan?: ReviewExportPlan; status: Record<string, unknown> }>;
      }).jobs;
      expect(cache.size).toBe(64);
      expect(cache.has(plans[0].exportId)).toBe(false);
      for (const job of cache.values()) {
        expect(job.plan).toBeUndefined();
        expect("manifest" in job.status).toBe(false);
      }
      expect((await store.prepare(plans[0])).state).toBe("ready");
      expect(store.dragPaths(plans[0].exportId, true)).toHaveLength(1);
      const copiedRoot = path.join(path.dirname(store.root), "reloaded-copy");
      await mkdir(copiedRoot);
      const copied = await store.copy(plans[0].exportId, copiedRoot, plans[0].nodeId);
      expect(await readFile(path.join(copied.directory, "status.json"), "utf8")).toBe("value 0");

      const reloaded = new ReviewExportStore(store.root, resources);
      expect(await reloaded.status(plans[0].exportId, plans[0].nodeId)).toMatchObject({
        state: "ready", manifest: { entries: [{ relativePath: "status.json" }] },
      });
      expect(await readFile(reloaded.dragPaths(plans[0].exportId, false)[0], "utf8")).toBe("value 0");
      expect(new Set(await readdir(reloaded.dragPaths(plans[0].exportId, true)[0]))).toEqual(new Set(["manifest.json", "status.json"]));
      expect((await reloaded.prepare(plans[0])).state).toBe("ready");
      await expect(reloaded.prepare({ ...plans[0], nodeRevision: plans[0].nodeRevision + 1 })).rejects.toMatchObject({ reason: "CONFLICT" });

      await rm(reloaded.dragPaths(plans[0].exportId, false)[0]);
      expect(() => reloaded.dragPaths(plans[0].exportId, false)).toThrow(/moved or deleted/);
      expect(() => reloaded.dragPaths(plans[0].exportId, true)).toThrow(/moved or deleted/);
    };
    const pending = run();
    activeRecovery = { cancel, settled: pending.then(() => undefined, () => undefined) };
    try { await pending; } finally { activeRecovery = undefined; }
  });

  it("shares concurrent same-ID reservations across stores and rejects conflicts", async () => {
    const { store, resources, plan } = await setup();
    const secondClient = new ReviewExportStore(store.root, resources);
    const frozen: ReviewExportPlan = { ...plan, entries: [{
      itemId: randomUUID(), itemVersion: 1, fileName: "parallel.txt", text: "one frozen result", serialization: "utf8-text",
    }] };
    const [first, second] = await Promise.all([store.prepare(frozen), secondClient.prepare(frozen)]);
    expect([first.state, second.state].every(state => state === "queued" || state === "preparing" || state === "ready")).toBe(true);
    await Promise.all([store.wait(frozen.exportId), secondClient.wait(frozen.exportId)]);
    expect(await secondClient.status(frozen.exportId, frozen.nodeId)).toMatchObject({ state: "ready", manifest: { exportId: frozen.exportId } });
    await expect(secondClient.prepare({ ...frozen, name: "Different plan" })).rejects.toMatchObject({ reason: "CONFLICT" });
  });

  it("bounds outstanding reservations and accepts the same ID after capacity becomes available", async () => {
    const { store, plan } = await setup();
    const frozen = Array.from({ length: 9 }, (_, index): ReviewExportPlan => ({
      ...plan,
      exportId: randomUUID(),
      name: "Concurrent " + index,
      entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "value.txt", text: "value " + index, serialization: "utf8-text" }],
    }));
    const attemptsPending = frozen.map(item => store.prepare(item));
    const activeState = store as unknown as {
      jobs: Map<string, { live: boolean; status: { state: string } }>;
      reservations: Map<string, unknown>;
    };
    const activeJobs = [...activeState.jobs.values()].filter(job => job.live && (job.status.state === "queued" || job.status.state === "preparing")).length;
    expect(activeJobs + activeState.reservations.size).toBe(8);
    const attempts = await Promise.allSettled(attemptsPending);
    const rejected = attempts.findIndex(result => result.status === "rejected");
    expect(rejected).toBe(8);
    expect(attempts[rejected]).toMatchObject({ status: "rejected", reason: { reason: "CONFLICT" } });
    await Promise.all(frozen.slice(0, 8).map(item => store.wait(item.exportId)));
    expect(["queued", "preparing", "ready"]).toContain((await store.prepare(frozen[8])).state);
    expect((await store.wait(frozen[8].exportId)).state).toBe("ready");
  });

  it("fails changed external sources and cancelled plans without advertising ready output", async () => {
    const { directory, resources, store, plan } = await setup();
    const source = path.join(directory, "external.txt");
    await writeFile(source, "original");
    const resource = await resources.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: source, mime: "text/plain", source: "user", mode: "external" });
    await writeFile(source, "changed externally");
    await store.prepare({ ...plan, entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "original.txt", resourceId: resource.id }] });
    expect(await store.wait(plan.exportId)).toMatchObject({ state: "failed", error: { reason: "SOURCE_CHANGED" } });
    expect(() => store.dragPaths(plan.exportId, true)).toThrow(/Prepare/);
    const cancelled = { ...plan, exportId: randomUUID(), entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "con.txt", text: "serialized", serialization: "utf8-text" as const }] };
    await store.prepare(cancelled);
    await store.cancel(cancelled.exportId);
    expect((await store.wait(cancelled.exportId)).state).toBe("cancelled");
    expect(await readFile(source, "utf8")).toBe("changed externally");
  });
});
