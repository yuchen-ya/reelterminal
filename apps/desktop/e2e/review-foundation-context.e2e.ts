import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LEGACY_IDB_MATERIAL_LIBRARY } from "@reelterminal/core/legacy/physical-identifiers";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR, REELCTL_PATH } from "./harness/paths";

describe("review foundation: actual no-project CLI discovery and IDB upgrade", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => { await agent?.close(); await launched?.close(); });

  test("keeps a user workspace identity across restart and preserves v1 material bytes", async () => {
    launched = await launchApp();
    const legacy = await launched.page.evaluate(async databaseName => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 1);
        open.onupgradeneeded = () => {
          for (const name of ["materials", "journal", "blobs"]) open.result.createObjectStore(name, { keyPath: "id" });
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(["materials", "journal", "blobs"], "readwrite");
        transaction.objectStore("materials").put({ id: "legacy-preservation-probe", revision: 7, userNotes: "human notes stay exact" });
        transaction.objectStore("journal").put({ id: "legacy-journal", order: { sequence: 9 } });
        transaction.objectStore("blobs").put({ id: "legacy-preservation-probe", blob: new Blob(["original legacy bytes"]) });
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      const version = database.version;
      database.close();
      return { version };
    }, LEGACY_IDB_MATERIAL_LIBRARY);
    expect(legacy.version).toBe(1);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    let first: ReviewContext;
    await vi.waitFor(async () => {
      const reply = await agent.callCommand<ReviewContext>("review.context");
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      first = reply.value!;
    }, { timeout: 15_000, interval: 250 });
    expect(first!.target.kind).toBe("review");
    expect(first!.access).toBe("read-only");
    const aliasContext = JSON.parse(execFileSync(process.execPath, [REELCTL_PATH, "review", "context"], {
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile }, windowsHide: true, encoding: "utf8",
    }));
    expect(aliasContext.value.target.reviewWorkspaceId).toBe(first!.target.reviewWorkspaceId);
    const cursorProbe = await launched.page.evaluate(async databaseName => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(databaseName);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const nodeId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(["reviewItems", "reviewVersions", "reviewSteps"], "readwrite");
        const ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
        ids.forEach(id => {
          transaction.objectStore("reviewItems").add({ id, nodeId, batchId: runId, type: "text", status: "pending", version: 1, name: "P0 cursor fixture" });
          transaction.objectStore("reviewVersions").add({ itemId: id, version: 1, content: { text: "P0 real persisted body ".repeat(100) } });
        });
        for (let index = 0; index < 100; index += 1) {
          transaction.objectStore("reviewSteps").add({ id: crypto.randomUUID(), nodeId, runId,
            state: "completed", label: `Fixture step ${index}`, inputKeys: [`${ids[index]}:1`], outputKeys: [`${ids[index + 1]}:1`],
            inputs: [{ itemId: ids[index], version: 1, role: "source" }], outputs: [{ itemId: ids[index + 1], version: 1, role: "result" }],
            method: { kind: "algorithm", name: "deterministic-fixture", verification: "declared" }, parameters: {},
          });
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      const readPage = (after?: string) => new Promise<{ ids: string[]; elapsedMs: number; jsonBytes: number }>((resolve, reject) => {
        const started = performance.now();
        const transaction = database.transaction("reviewItems", "readonly");
        const range = IDBKeyRange.bound([nodeId, after ?? ""], [nodeId, "\uffff"], after !== undefined);
        const request = transaction.objectStore("reviewItems").index("node").getAll(range, 100);
        transaction.oncomplete = () => resolve({ ids: request.result.map(row => row.id), elapsedMs: performance.now() - started, jsonBytes: new TextEncoder().encode(JSON.stringify(request.result)).byteLength });
        transaction.onabort = () => reject(transaction.error);
      });
      const firstPage = await readPage();
      const nextPage = await readPage(firstPage.ids.at(-1));
      const steps = await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction("reviewSteps", "readonly");
        const request = transaction.objectStore("reviewSteps").index("run").getAll(IDBKeyRange.bound([nodeId, runId, ""], [nodeId, runId, "\uffff"]), 100);
        transaction.oncomplete = () => resolve(request.result.length);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return { nodeId, runId, itemCount: 1000, stepCount: steps, firstPage, nextPage, decodedMedia: 0,
        scope: "Real Chromium IDB cursor/schema feasibility fixture; not product UI performance or completed ReviewService acceptance" };
    }, LEGACY_IDB_MATERIAL_LIBRARY);
    expect(cursorProbe.firstPage.ids).toHaveLength(100);
    expect(cursorProbe.nextPage.ids).toHaveLength(100);
    expect(cursorProbe.firstPage.ids.some(id => cursorProbe.nextPage.ids.includes(id))).toBe(false);
    expect(cursorProbe.stepCount).toBe(100);
    const processMemory = await launched.app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
      type: metric.type, pid: metric.pid, memory: metric.memory,
    })));
    const stored = await launched.page.evaluate(async databaseName => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(databaseName);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const snapshot = await new Promise<{ material: unknown; journal: unknown; blob: Blob }>((resolve, reject) => {
        const transaction = database.transaction(["materials", "journal", "blobs"], "readonly");
        const material = transaction.objectStore("materials").get("legacy-preservation-probe");
        const journal = transaction.objectStore("journal").get("legacy-journal");
        const blob = transaction.objectStore("blobs").get("legacy-preservation-probe");
        transaction.oncomplete = () => resolve({ material: material.result, journal: journal.result, blob: blob.result.blob });
        transaction.onabort = () => reject(transaction.error);
      });
      const result = { version: database.version, hasHumanBoards: database.objectStoreNames.contains("humanBoards"), material: snapshot.material, journal: snapshot.journal, bytes: await snapshot.blob.text() };
      database.close();
      return result;
    }, LEGACY_IDB_MATERIAL_LIBRARY);
    expect(stored.version).toBe(3);
    expect(stored.hasHumanBoards).toBe(true);
    expect(stored.bytes).toBe("original legacy bytes");
    expect(stored.material).toEqual({ id: "legacy-preservation-probe", revision: 7, userNotes: "human notes stay exact" });
    expect(stored.journal).toEqual({ id: "legacy-journal", order: { sequence: 9 } });
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    let reopened: ReviewContext;
    await vi.waitFor(async () => {
      const reply = await agent.callCommand<ReviewContext>("review.context");
      expect(reply.ok).toBe(true);
      reopened = reply.value!;
    }, { timeout: 15_000, interval: 250 });
    expect(reopened!.target.reviewWorkspaceId).toBe(first!.target.reviewWorkspaceId);
    expect(reopened!.target.instanceId).not.toBe(first!.target.instanceId);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-foundation-context-no-project.png") });
    await writeFile(path.join(ARTIFACTS_DIR, "review-foundation-context.json"), JSON.stringify({
      measuredAt: new Date().toISOString(), legacy, stored, first: first!, reopened: reopened!,
      aliasContext, cursorProbe, processMemory,
      reviewCommands: (await agent.listCommands()).filter(command => command.name.startsWith("review.")),
    }, null, 2));
  });
});
