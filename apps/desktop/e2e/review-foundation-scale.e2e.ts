import { value } from "./harness/cli-client";
import { expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp } from "./harness/launch";
import { connectExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";


test("measures the actual paged UI with 1,000 text items and 110 declared processing reports", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const memory: unknown[] = [];
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try { memory.push({ at: performance.now(), processes: await launched.app.evaluate(({ app }) => app.getAppMetrics().map(process => ({ type: process.type, pid: process.pid, memory: process.memory }))) }); }
    finally { sampling = false; }
  };
  const timer = setInterval(() => void sample(), 200);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    await page.getByTestId("review-access-toggle").click();
    const node = value(await agent.callCommand<ReviewNode>("review.nodes.create", { target: context.target, expectedWorkspaceRevision: 0, requestId: crypto.randomUUID(), name: "Scale acceptance 1000 / 110" }));
    const target = { ...context.target, nodeId: node.id };
    const runId = crypto.randomUUID();
    for (let batch = 0; batch < 2; batch++) {
      const items = Array.from({ length: 500 }, (_, index) => {
        const id = crypto.randomUUID();
        const title = `Scale ${String(batch * 500 + index).padStart(4, "0")}`;
        return { id, title, type: "text", content: { type: "text", entryId: crypto.randomUUID(), title, speakerOrContext: "", text: `${title}\n${"Exact 👀 text\n".repeat(80)}`.normalize("NFC") } };
      });
      // These are external reports of this test's real string construction,
      // never measured product execution or model-generated processing.
      const steps = batch ? [] : items.slice(0, 110).map(item => ({ id: crypto.randomUUID(), runId, label: `Construct ${item.title}`,
        inputs: [], outputs: [{ nodeId: node.id, itemId: item.id, version: 1, role: "result" }],
        method: { kind: "algorithm", name: "JavaScript String.normalize", version: "NFC" }, parameters: { fixture: true }, startedAt: Date.now() - 1, finishedAt: Date.now() }));
      value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: batch, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: `Scale batch ${batch + 1}`, items, steps }));
    }
    const settled = async () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const started = performance.now();
    await page.getByTestId("review-node-list").locator('button:not([data-testid="review-node-menu-trigger"])').filter({ hasText: "Scale acceptance 1000 / 110" }).click();
    await page.getByTestId("text-body").waitFor();
    const nextPage = page.getByTestId("review-item-pagination").getByTitle("Next", { exact: true });
    await nextPage.waitFor();
    await vi.waitFor(async () => expect(await nextPage.isEnabled()).toBe(true));
    await settled();
    const firstPageMs = performance.now() - started;
    const visibleTreeRows = await page.getByTestId("workbench-tree-panel").getByText(/^Scale \d{4}$/).count();
    expect(visibleTreeRows).toBe(100);
    const firstText = await page.getByTestId("text-body").textContent();
    const nextStarted = performance.now();
    await nextPage.click();
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").textContent()).not.toBe(firstText));
    await settled();
    const nextPageMs = performance.now() - nextStarted;
    const processStarted = performance.now();
    await page.getByTestId("review-process-tab").click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-step-card").count()).toBe(100));
    await settled();
    const processingPageMs = performance.now() - processStarted;
    const stepNextStarted = performance.now();
    await page.getByTestId("review-process-view").getByRole("button", { name: "Next", exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-step-card").count()).toBe(10));
    await settled();
    const processingNextMs = performance.now() - stepNextStarted;
    let count = 0;
    let cursor: string | undefined;
    do {
      const result = value(await agent.callCommand<{ items: unknown[]; cursor?: string }>("review.get", { target, limit: 500, ...(cursor ? { cursor } : {}) }));
      count += result.items.length; cursor = result.cursor;
    } while (cursor);
    expect(count).toBe(1000);
    await sample();
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-scale.png") });
    await writeFile(path.join(ARTIFACTS_DIR, "review-scale.json"), JSON.stringify({ measuredAt: new Date().toISOString(), count, steps: 110, firstPageMs, nextPageMs, processingPageMs, processingNextMs, visibleTreeRows, memory,
      limits: "One warm app, isolated profile, text-only fixtures, two 500-item batches, 100-item/100-step UI pages. Host-clock interaction through two renderer animation frames includes automation overhead, not compositor presentation. Memory is 200ms sampled Electron working sets, not a guaranteed instantaneous peak or hardware-independent latency gate." }, null, 2));
  } finally {
    clearInterval(timer);
    while (sampling) await new Promise(resolve => setTimeout(resolve, 10));
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    if (!launched.page.isClosed()) await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-scale-terminal.png") });
    await agent.close();
    await launched.close();
  }
}, 180_000);

test("pages a 1,000 by 20 table without losing last-page editing or full-column selection", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    await page.getByTestId("review-access-toggle").click();
    const node = value(await agent.callCommand<ReviewNode>("review.nodes.create", { target: context.target,
      expectedWorkspaceRevision: 0, requestId: crypto.randomUUID(), name: "Large table audit" }));
    const target = { ...context.target, nodeId: node.id };
    const columns = Array.from({ length: 20 }, (_, index) => ({ columnId: crypto.randomUUID(), title: `Column ${index}` }));
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ rowId: crypto.randomUUID(),
      cells: Object.fromEntries(columns.map((column, col) => [column.columnId, `Value ${index} / ${col}`])) }));
    const itemId = crypto.randomUUID();
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(),
      batchId: crypto.randomUUID(), name: "Large table", items: [{ id: itemId, title: "Large table", type: "data",
        content: { type: "data", datasetId: crypto.randomUUID(), columns, rows, proposals: [] } }] }));
    const opened = performance.now();
    await page.getByTestId("review-node-list").locator('button:not([data-testid="review-node-menu-trigger"])').filter({ hasText: "Large table audit" }).click();
    const pagination = page.getByTestId("workbench-data-pagination");
    await pagination.waitFor();
    const content = page.getByTestId("workbench-content");
    await vi.waitFor(async () => expect(await content.getByRole("row").count()).toBe(51));
    expect(await content.getByRole("cell").count()).toBe(1050);
    const openMs = performance.now() - opened;
    await content.getByRole("button", { name: /Column 0/ }).click();
    await vi.waitFor(async () => expect(await content.textContent()).toContain("已选 1000 格"));
    const nextStarted = performance.now();
    await pagination.getByRole("button", { name: "末页", exact: true }).click();
    const last = content.getByText("Value 999 / 0", { exact: true });
    await last.waitFor();
    const lastPageMs = performance.now() - nextStarted;
    await last.dblclick();
    const editor = content.locator("td input");
    await editor.fill("Last page edited 👀");
    await editor.press("Enter");
    let updated: { item: { version: number; content: { rows: typeof rows } } };
    await vi.waitFor(async () => {
      updated = value(await agent.callCommand<typeof updated>("review.get", { target, itemId }));
      expect(updated.item.version).toBe(2);
      expect(updated.item.content.rows.at(-1)?.cells[columns[0].columnId]).toBe("Last page edited 👀");
    });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-table-scale.png") });
    await writeFile(path.join(ARTIFACTS_DIR, "review-table-scale.json"), JSON.stringify({ rows: 1000, columns: 20,
      mountedRows: 50, mountedDataCells: 1000, openMs, lastPageMs, lastRowEdited: true, fullColumnSelection: 1000,
      limits: "One isolated packaged Electron profile; automation and API roundtrip included. DOM bound and persistent edit checked, not a hardware-independent latency gate." }, null, 2));
  } finally { await agent.close(); await launched.close(); }
}, 120_000);
