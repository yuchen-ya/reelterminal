import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReviewExportPlan } from "@reelterminal/core/review/export";
import { ReviewFileStore } from "./review-file-store";
import { ReviewExportStore } from "./review-export-store";

const fault = vi.hoisted(() => ({
  directory: "",
  mode: "" as "" | "stream-space" | "manifest-space" | "receipt-space" | "receipt-pause" | "status-space" | "status-once" | "manifest-cancel" | "cancel",
  written: 0,
  injected: false,
  statusWrites: 0,
  afterWrite: undefined as (() => void) | undefined,
  receiptStarted: undefined as (() => void) | undefined,
  receiptRelease: undefined as Promise<void> | undefined,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
    const output = actual.createWriteStream(...args);
    if (!fault.directory || !String(args[0]).startsWith(fault.directory + path.sep)) return output;
    const write = output._write.bind(output);
    output._write = (chunk, encoding, callback) => {
      if (fault.mode === "stream-space" && fault.written >= 1024 * 1024) {
        fault.injected = true;
        callback(Object.assign(new Error("Injected ENOSPC at the export file write"), { code: "ENOSPC" }));
        return;
      }
      write(chunk, encoding, error => {
        if (!error) {
          fault.written += Buffer.byteLength(chunk);
          if (fault.mode === "cancel") { fault.injected = true; fault.afterWrite!(); }
        }
        callback(error);
      });
    };
    return output;
  } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    const filename = String(args[0]);
    if (fault.mode === "receipt-pause" && filename.startsWith(fault.directory + path.sep) && path.basename(filename) === "job.json") {
      const written = await actual.writeFile(args[0], args[1], args[2]);
      fault.receiptStarted?.();
      await fault.receiptRelease;
      return written;
    }
    if (fault.mode === "receipt-space" && filename.startsWith(fault.directory + path.sep) && path.basename(filename) === "job.json") {
      fault.injected = true;
      throw Object.assign(new Error("Injected ENOSPC while writing export receipt"), { code: "ENOSPC" });
    }
    if ((fault.mode === "status-space" || fault.mode === "status-once") && filename.startsWith(fault.directory + path.sep) && path.basename(filename).startsWith("status.json.tmp-")) {
      fault.statusWrites++;
      const savedState = JSON.parse(String(args[1])) as { state?: string };
      if ((fault.mode === "status-space" && savedState.state === "ready") || (fault.mode === "status-once" && fault.statusWrites === 3)) {
        fault.injected = true;
        throw Object.assign(new Error("Injected ENOSPC while writing terminal export status"), { code: "ENOSPC" });
      }
    }
    if (fault.mode === "manifest-cancel" && filename.startsWith(fault.directory + path.sep) && path.basename(filename) === "manifest.json") {
      const written = await actual.writeFile(args[0], args[1], args[2]);
      fault.injected = true;
      fault.afterWrite!();
      return written;
    }
    if (fault.mode === "manifest-space" && String(args[0]).startsWith(fault.directory + path.sep) && path.basename(String(args[0])) === "manifest.json") {
      if (!Buffer.isBuffer(args[1])) throw new Error("Expected the native manifest Buffer");
      await actual.writeFile(args[0], args[1].subarray(0, 17), args[2]);
      fault.injected = true;
      throw Object.assign(new Error("Injected ENOSPC during manifest write"), { code: "ENOSPC" });
    }
    return actual.writeFile(...args);
  } };
});

const directories: string[] = [];
afterEach(async () => {
  fault.directory = ""; fault.mode = ""; fault.written = 0; fault.injected = false; fault.statusWrites = 0;
  fault.afterWrite = undefined; fault.receiptStarted = undefined; fault.receiptRelease = undefined;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reel-review-export-fault-"));
  directories.push(directory);
  const source = path.join(directory, "original.bin");
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0x51);
  bytes.write("Exact original tail", bytes.length - 19);
  await writeFile(source, bytes);
  const resources = new ReviewFileStore(path.join(directory, "resources"));
  const resource = await resources.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: source, mime: "application/octet-stream", source: "user" });
  const store = new ReviewExportStore(path.join(directory, "exports"), resources);
  const plan: ReviewExportPlan = { exportId: randomUUID(), nodeId: randomUUID(), nodeRevision: 4, name: "Node", mode: "original", scope: "node",
    entries: [{ itemId: randomUUID(), itemVersion: 1, fileName: "original.bin", resourceId: resource.id }] };
  return { directory, source, bytes, resources, resource, store, plan };
}

describe("review export native write failures and in-flight cancellation", () => {
  it("waits for an in-progress receipt before exposing a concurrent same-ID retry", async () => {
    const { resources, store, plan } = await fixture();
    const secondClient = new ReviewExportStore(store.root, resources);
    let releaseReceipt!: () => void;
    let receiptStarted!: () => void;
    const started = new Promise<void>(resolve => { receiptStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    fault.directory = store.root;
    fault.mode = "receipt-pause";
    fault.receiptStarted = receiptStarted;
    fault.receiptRelease = gate;

    const firstPrepare = store.prepare(plan);
    await started;
    let secondFinished = false;
    const secondPrepare = secondClient.prepare(plan).finally(() => { secondFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(secondFinished).toBe(true);
    expect(["queued", "preparing"]).toContain((await secondPrepare).state);
    releaseReceipt();
    expect(["queued", "preparing", "ready"]).toContain((await firstPrepare).state);
    await Promise.all([store.wait(plan.exportId), secondClient.wait(plan.exportId)]);
    expect(await secondClient.status(plan.exportId, plan.nodeId)).toMatchObject({ state: "ready", manifest: { exportId: plan.exportId } });
  });

  it("cleans a receipt-write failure so the same export ID can reserve again", async () => {
    const { store, plan } = await fixture();
    fault.directory = store.root;
    fault.mode = "receipt-space";
    await expect(store.prepare(plan)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fault.injected).toBe(true);
    expect(existsSync(path.join(store.root, plan.exportId))).toBe(false);
    fault.mode = "";
    await store.prepare(plan);
    expect((await store.wait(plan.exportId)).state).toBe("ready");
  });

  it("keeps a complete export ready when its ready-status write fails once", async () => {
    const { directory, store, resources, plan, bytes } = await fixture();
    fault.directory = store.root;
    fault.mode = "status-once";
    await store.prepare(plan);

    expect(await store.wait(plan.exportId)).toMatchObject({ state: "ready", manifest: { exportId: plan.exportId } });
    expect((await store.prepare(plan)).state).toBe("ready");
    expect(fault.statusWrites).toBe(3);
    expect(fault.injected).toBe(true);

    fault.mode = "";
    const reopened = new ReviewExportStore(store.root, resources);
    expect(await reopened.status(plan.exportId, plan.nodeId)).toMatchObject({ state: "ready", manifest: { exportId: plan.exportId } });
    const destination = path.join(directory, "destination");
    await mkdir(destination);
    const copied = await reopened.copy(plan.exportId, destination, plan.nodeId);
    expect((await readFile(path.join(copied.directory, "original.bin"))).equals(bytes)).toBe(true);
  });

  it("reloads each complete export when every ready-status write fails", async () => {
    const { store, resources, plan } = await fixture();
    const secondPlan = { ...plan, exportId: randomUUID() };
    fault.directory = store.root;
    fault.mode = "status-space";
    await store.prepare(plan);
    await store.prepare(secondPlan);

    expect(await store.wait(plan.exportId)).toMatchObject({ state: "ready", manifest: { exportId: plan.exportId } });
    expect(await store.wait(secondPlan.exportId)).toMatchObject({ state: "ready", manifest: { exportId: secondPlan.exportId } });
    expect(fault.statusWrites).toBe(6);
    expect(fault.injected).toBe(true);

    fault.mode = "";
    const reopened = new ReviewExportStore(store.root, resources);
    expect(await reopened.status(plan.exportId, plan.nodeId)).toMatchObject({ state: "ready", manifest: { exportId: plan.exportId } });
    expect(await reopened.status(secondPlan.exportId, plan.nodeId)).toMatchObject({ state: "ready", manifest: { exportId: secondPlan.exportId } });
  });

  it("keeps a cancellation terminal when it arrives after the full manifest is written", async () => {
    const { source, bytes, resources, store, plan } = await fixture();
    fault.directory = store.root;
    fault.mode = "manifest-cancel";
    fault.afterWrite = () => { void store.cancel(plan.exportId, plan.nodeId); };
    await store.prepare(plan);

    expect(await store.wait(plan.exportId)).toMatchObject({ state: "cancelled", error: { reason: "CANCELLED" } });
    expect(fault.injected).toBe(true);
    expect(existsSync(path.join(store.root, plan.exportId, "content", "Node", "manifest.json"))).toBe(true);
    expect((await readFile(source)).equals(bytes)).toBe(true);
    expect(() => store.dragPaths(plan.exportId, false)).toThrow(/Prepare/);
    await expect(store.copy(plan.exportId, path.dirname(source), plan.nodeId)).rejects.toMatchObject({ reason: "CONFLICT" });

    const reopened = new ReviewExportStore(store.root, resources);
    expect(await reopened.status(plan.exportId, plan.nodeId)).toMatchObject({ state: "cancelled", error: { reason: "CANCELLED" } });
  });

  it.each(["stream-space", "manifest-space"] as const)("rejects %s preparation without usable output, preserves originals, and recovers with a new preparation", async mode => {
    const { source, bytes, resources, resource, store, plan } = await fixture();
    fault.directory = store.root; fault.mode = mode;
    await store.prepare(plan);
    expect(await store.wait(plan.exportId)).toMatchObject({ state: "failed", error: { reason: "NO_SPACE" } });
    expect(fault.injected).toBe(true);
    expect((await store.status(plan.exportId)).manifest).toBeUndefined();
    expect(() => store.dragPaths(plan.exportId, false)).toThrow(/Prepare/);
    expect(() => store.dragPaths(plan.exportId, true)).toThrow(/Prepare/);
    await expect(store.copy(plan.exportId, path.dirname(source), plan.nodeId)).rejects.toMatchObject({ reason: "CONFLICT" });
    const partial = path.join(store.root, plan.exportId, "content", "Node", mode === "stream-space" ? "original.bin" : "manifest.json");
    expect((await stat(partial)).size).toBeGreaterThan(0);
    expect((await stat(partial)).size).toBeLessThan(mode === "stream-space" ? bytes.length : 100);
    expect((await readFile(source)).equals(bytes)).toBe(true);
    expect((await readFile((await resources.resolve(resource.id, true)).path)).equals(bytes)).toBe(true);
    // A completed failure remains the same receipt; GUI recovery uses a new export ID.
    expect((await store.prepare(plan)).state).toBe("failed");
    fault.mode = "";
    const retry = { ...plan, exportId: randomUUID() };
    await store.prepare(retry);
    expect((await store.wait(retry.exportId)).state).toBe("ready");
    expect((await readFile(store.dragPaths(retry.exportId, false)[0])).equals(bytes)).toBe(true);
  });

  it("does not publish a partial destination after ENOSPC, preserves existing output and can retry the same ready export", async () => {
    const { directory, source, bytes, store, plan } = await fixture();
    await store.prepare(plan); expect((await store.wait(plan.exportId)).state).toBe("ready");
    const destination = path.join(directory, "destination");
    await mkdir(path.join(destination, "Node"), { recursive: true });
    await writeFile(path.join(destination, "Node", "keep.txt"), "Existing output stays intact");
    fault.directory = destination; fault.mode = "stream-space";
    await expect(store.copy(plan.exportId, destination, plan.nodeId)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fault.injected).toBe(true);
    expect(await readdir(destination)).toEqual(["Node"]);
    expect(await readFile(path.join(destination, "Node", "keep.txt"), "utf8")).toBe("Existing output stays intact");
    expect((await store.status(plan.exportId)).state).toBe("ready");
    expect((await readFile(source)).equals(bytes)).toBe(true);
    fault.mode = "";
    const retried = await store.copy(plan.exportId, destination, plan.nodeId);
    expect(path.basename(retried.directory)).toBe("Node (2)");
    expect((await readFile(path.join(retried.directory, "original.bin"))).equals(bytes)).toBe(true);
  });

  it("cancels after bytes have reached disk, exposes no ready result and can prepare again", async () => {
    const { source, bytes, resources, store, plan } = await fixture();
    fault.directory = store.root; fault.mode = "cancel";
    fault.afterWrite = () => store.cancel(plan.exportId, plan.nodeId);
    await store.prepare(plan);
    expect(await store.wait(plan.exportId)).toMatchObject({ state: "cancelled", error: { reason: "CANCELLED" } });
    const reopened = new ReviewExportStore(store.root, resources);
    expect(await reopened.status(plan.exportId, plan.nodeId)).toMatchObject({ state: "cancelled", error: { reason: "CANCELLED" } });
    expect(fault.injected).toBe(true);
    expect(fault.written).toBeGreaterThan(0);
    expect(fault.written).toBeLessThan(bytes.length);
    expect(existsSync(path.join(store.root, plan.exportId, "content", "Node", "manifest.json"))).toBe(false);
    expect(() => store.dragPaths(plan.exportId, false)).toThrow(/Prepare/);
    await expect(store.copy(plan.exportId, path.dirname(source))).rejects.toMatchObject({ reason: "CONFLICT" });
    expect((await readFile(source)).equals(bytes)).toBe(true);
    fault.mode = "";
    const retry = { ...plan, exportId: randomUUID() };
    await store.prepare(retry); expect((await store.wait(retry.exportId)).state).toBe("ready");
    expect((await readFile(store.dragPaths(retry.exportId, false)[0])).equals(bytes)).toBe(true);
  });
});
