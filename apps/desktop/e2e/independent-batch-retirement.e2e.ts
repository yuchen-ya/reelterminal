import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { LEGACY_IDB_MATERIAL_LIBRARY } from "@reelterminal/core/legacy/physical-identifiers";
import { launchApp } from "./harness/launch";
import { connectExternalAgent } from "./harness/cli-client";
import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { createEvidence } from "./harness/evidence";

test("retired independent batches expose no entry or CLI writes and retain existing stored records", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const page = launched.page;
  const evidence = createEvidence("independent-batch-retirement", page);
  const record = { id: randomUUID(), name: "Existing experimental batch", revision: 7, retainedNote: "Synthetic existing data remains exact" };
  try {
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("folder-task-directory").waitFor();
    await page.evaluate(async ({ databaseName, record }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction("reviewNodes", "readwrite");
          tx.objectStore("reviewNodes").put(record);
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
      } finally { database.close(); }
      const key = "reelterminal.workbench.tabs";
      const saved = JSON.parse(localStorage.getItem(key) ?? '{"state":{"tabs":[],"recentFolders":[]},"version":0}');
      saved.state.tabs.push({ kind: "review", id: record.id, name: record.name });
      saved.state.activeKey = `review:${record.id}`;
      localStorage.setItem(key, JSON.stringify(saved));
    }, { databaseName: LEGACY_IDB_MATERIAL_LIBRARY, record });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("folder-task-directory").waitFor();
    expect(await page.getByTestId("folder-task-new").count()).toBe(1);
    expect(await page.getByTestId("review-new-task").count()).toBe(0);
    expect(await page.locator('[data-testid^="review-tab-"]').count()).toBe(0);
    for (const [command, params] of [
      ["review.context", {}],
      ["review.nodes.create", { target: { reviewWorkspaceId: randomUUID(), instanceId: randomUUID() }, name: "Rejected new batch", expectedWorkspaceRevision: 0, requestId: randomUUID() }],
    ] as const) {
      expect(await agent.callCommand(command, params)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    }
    const preserved = await page.evaluate(async ({ databaseName, id }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise(resolve => { const request = database.transaction("reviewNodes", "readonly").objectStore("reviewNodes").get(id); request.onsuccess = () => resolve(request.result); }); }
      finally { database.close(); }
    }, { databaseName: LEGACY_IDB_MATERIAL_LIBRARY, id: record.id });
    expect(preserved).toEqual(record);
    evidence.record("retirement", { folderEntryAvailable: true, oldCreationAndTabsAbsent: true, oldCliUnsupported: true, existingRecordUnchanged: true });
    await evidence.screenshot("folder-directory-without-batch-entry");
  } finally { evidence.flush(); await agent.close(); await launched.close(); }
});
