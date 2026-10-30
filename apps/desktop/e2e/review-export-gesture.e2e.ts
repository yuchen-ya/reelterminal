import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { value } from "./harness/cli-client";
import { expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp } from "./harness/launch";
import { connectExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";
import { evidenceJsonReplacer } from "./harness/evidence";


test("a real pointer gesture on each formal handle reaches the native drag boundary", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const page = launched.page;
  try {
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Gesture regression");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    value(await agent.callCommand("review.ingest", { target: { ...context.target, nodeId: node.id }, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "Gesture fixture",
      items: [{ id: crypto.randomUUID(), title: "single", type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: "Single", speakerOrContext: "", text: "Gesture exact original" } }] }));
    await page.getByTestId("text-body").waitFor();
    await vi.waitFor(async () => expect(await page.getByTestId("review-node-editor").locator("[inert]").count()).toBe(0));
    await page.getByTestId("review-export-menu-trigger").click();
    await page.getByTestId("review-export-open").click();
    await page.getByTestId("review-export-prepare").click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-export-status").getAttribute("data-state")).toBe("ready"));
    // Observe the production IPC call, suppressing only the native OS modal drag.
    // Explorer receipt remains a separate manual acceptance test.
    await launched.app.evaluate(({ BrowserWindow }) => {
      const calls: Array<{ files: string[]; icon: { width: number; height: number } }> = [];
      (globalThis as unknown as { gestureCalls: typeof calls }).gestureCalls = calls;
      BrowserWindow.getAllWindows()[0].webContents.startDrag = item => { calls.push({ files: item.files ?? [item.file!], icon: typeof item.icon === "string" ? { width: -1, height: -1 } : item.icon.getSize() }); };
    });
    await page.evaluate(() => {
      const events: Array<{ type: string; target: string | null; prevented: boolean }> = [];
      (window as unknown as { gestureEvents: typeof events }).gestureEvents = events;
      for (const type of ["pointerdown", "dragstart", "dragend"]) document.addEventListener(type, event => { events.push({ type, target: (event.target as HTMLElement).getAttribute("data-testid"), prevented: event.defaultPrevented }); });
    });
    for (const [index, id] of ["review-export-drag-files", "review-export-drag-folder"].entries()) {
      const handle = page.getByTestId(id);
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 10 });
      await page.mouse.up();
      await vi.waitFor(async () => expect(await launched.app.evaluate(() => (globalThis as unknown as { gestureCalls: unknown[] }).gestureCalls.length)).toBe(index + 1));
    }
    const calls = await launched.app.evaluate(() => (globalThis as unknown as { gestureCalls: Array<{ files: string[]; icon: { width: number; height: number } }> }).gestureCalls);
    expect(calls.every(call => call.icon.width === 32 && call.icon.height === 32)).toBe(true);
    expect(calls[0].files[0]).toMatch(/single\.txt$/);
    expect(calls[1].files[0]).toMatch(/Gesture regression$/);
    await expect(page.evaluate(id => window.reelterminal!.reviewExport!.startDrag(id, false), crypto.randomUUID())).rejects.toThrow(/Export does not belong/);
    const exportId = (await page.getByTestId("review-export-status").getAttribute("data-export-id"))!;
    expect(await page.evaluate(id => window.reelterminal!.reviewExport!.startDrag(id, false), exportId)).toEqual({ state: "handed-to-system" });
  } finally {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACTS_DIR, "review-export-gesture.json"), JSON.stringify({
      calls: await launched.app.evaluate(() => (globalThis as unknown as { gestureCalls?: unknown[] }).gestureCalls),
      events: await page.evaluate(() => (window as unknown as { gestureEvents?: unknown[] }).gestureEvents),
      alerts: await page.getByRole("alert").allTextContents(), console: launched.output.rendererConsole,
    }, evidenceJsonReplacer, 2));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-export-gesture.png") });
    await agent.close(); await launched.close();
  }
}, 60_000);
