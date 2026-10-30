import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { applyOp, ingestBatch, readIdentity, readProjectState, switchToWorkbench, waitForStableWorkspace } from "./harness/workbench-fixtures";
import { createEvidence } from "./harness/evidence";

test("switching through legacy review keeps video history blocked across keyboard, native menu and review buttons", async () => {
  const launched = await launchApp(), page = launched.page;
  const evidence = createEvidence("legacy-review-history", page);
  await createProjectViaUI(page); await enableAgentSessionViaUI(page, launched.endpointFile);
  await launched.waitForEndpointFile(); const agent = await connectExternalAgent(launched.endpointFile);
  try {
    await waitForStableWorkspace(agent); const identity = await readIdentity(agent);
    await ingestBatch(agent, identity, "legacy-batch", "Legacy review", [{ id: "legacy-text", title: "Legacy text", type: "text",
      content: { type: "text", entryId: "legacy-entry", title: "Legacy text", speakerOrContext: "", text: "Review body" } }], "legacy-ingest");
    value(await applyOp(agent, identity, [{ op: "track.add", trackType: "video", trackId: "legacy-video-top" }]));
    await switchToWorkbench(page);
    const undo = page.getByRole("button", { name: "撤销上一次审阅操作", exact: true });
    await vi.waitFor(async () => expect(await undo.isDisabled()).toBe(true));
    expect(await undo.getAttribute("title")).toContain("视频");
    const before = await readProjectState(agent, identity);
    await page.getByTestId("workbench-tree-panel").getByText("Legacy text", { exact: true }).click();
    await page.keyboard.press("Control+z");
    await launched.app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.items.flatMap(menu => menu.submenu?.items ?? []).find(item => item.label === "Undo");
      if (!item) throw new Error("Undo menu missing"); item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false });
    });
    const after = await readProjectState(agent, identity);
    expect(after.project).toEqual(before.project);
    await evidence.screenshot("video-top-blocked");
    await page.getByRole("tab", { name: /Video edit|视频编辑/i }).click();
    const timeline = page.getByTestId("timeline-time-ruler"); await timeline.focus(); await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect((await readProjectState(agent, identity)).project.timeline.tracks.some((track: { id: string }) => track.id === "legacy-video-top")).toBe(false));
    await switchToWorkbench(page);
    await vi.waitFor(async () => expect(await undo.isEnabled()).toBe(true));
    await undo.click();
    await vi.waitFor(async () => expect((await readProjectState(agent, identity)).project.workbench.items).toHaveLength(0));
    await page.getByTestId("workbench-redo").click();
    await vi.waitFor(async () => expect((await readProjectState(agent, identity)).project.workbench.items).toHaveLength(1));
    evidence.record("isolation", { videoTopBlocked: true, nativeMenuBlocked: true, reviewUndoRedoWorkedAfterVideoUndo: true });
    await evidence.screenshot("review-top-recovered");
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!page.isClosed()) await evidence.screenshot("terminal"); evidence.flush(); await agent.close(); await launched.close();
  }
});
