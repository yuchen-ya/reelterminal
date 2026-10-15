import { expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createProjectViaUI, createTextClipViaUI, enableAgentSessionViaUI } from "./harness/ui";

test("inspector archives and board preserve preview, target, forms and main layout", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const launched = await launchApp({ runDir: job ? path.join(job, "work", `inspector-profile-${crypto.randomUUID()}`) : undefined, keepRunDir: true });
  let agent: ExternalAgent | undefined;
  let evidence: string | undefined;
  const observations: Record<string, unknown> = {};
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await agent!.callTool<any>(name.replaceAll(".", "_"), args);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value;
  };
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const capabilities = await call("capabilities.get");
    evidence = path.join(job ?? capabilities.mediaImport.recommendedRoot, "evidence", "inspector-layout");
    mkdirSync(evidence, { recursive: true });
    const dismiss = launched.page.getByRole("button", { name: "Dismiss notification", exact: true });
    if (await dismiss.count()) await dismiss.first().click();
    await createTextClipViaUI(launched.page);
    const identity = (await call("editor.get_context")).identity;
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const getState = () => call("project.get_state", target);
    const titleId = (await getState()).project.textClips[0].id;
    await launched.page.getByTestId("current-archive-entry").click();
    await launched.page.getByText("No save points yet. Current edits are still saved normally.").waitFor();
    const timelineHeight = (await launched.page.getByTestId("timeline-tracks-scroll").boundingBox())!.height;
    expect((await call("node.list", { projectId: target.projectId })).nodes).toHaveLength(0);
    await launched.page.getByTestId("create-save-point").click();
    await vi.waitFor(async () => expect((await call("node.list", { projectId: target.projectId })).nodes).toHaveLength(1));
    const first = (await call("node.list", { projectId: target.projectId })).nodes[0];
    for (let index = 1; index <= 8; index++) {
      const before = await getState();
      await call("edit.apply", { ...target, expectedRevision: before.revision, idempotencyKey: `layout-edit-${index}`, ops: [{ op: "text.update", overlayId: titleId, text: `Cut ${index}` }] });
      await call("node.save", { ...target, expectedRevision: (await getState()).revision, name: index === 8 ? "A deliberately long save point name that must remain readable in a narrow inspector" : `Cut ${index}`, idempotencyKey: `layout-point-${index}` });
    }
    expect((await launched.page.getByTestId("timeline-tracks-scroll").boundingBox())!.height).toBeCloseTo(timelineHeight, 0);
    await call("workspace.create", { projectId: target.projectId, sourceNodeId: first.id, name: "Untouched export copy", idempotencyKey: "layout-export-copy" });
    const trial = await call("workspace.create", { projectId: target.projectId, sourceNodeId: first.id, name: "A separate trial", idempotencyKey: "layout-trial" });
    const trialTarget = { projectId: target.projectId, workspaceId: trial.workspace.id };
    await call("edit.apply", { ...trialTarget, expectedRevision: 0, idempotencyKey: "trial-edit", ops: [{ op: "text.update", overlayId: titleId, text: "Independent trial" }] });
    const trialPoint = await call("node.save", { ...trialTarget, expectedRevision: 1, name: "Trial branch", idempotencyKey: "trial-point" });
    expect(await launched.page.getByTestId(`version-node-${first.id}`).getByText("Trial", { exact: true }).count()).toBe(0);
    expect(await launched.page.getByTestId(`version-node-${trialPoint.node.id}`).getByText("Trial", { exact: true }).isVisible()).toBe(true);
    expect(await launched.page.locator(`path[data-child-id="${trialPoint.node.id}"][data-parent-id="${first.id}"]`).count()).toBe(1);
    expect((await getState()).project.textClips[0].text).toBe("Cut 8");
    await launched.page.getByTestId(`version-node-${first.id}`).click();
    expect(await launched.page.getByTestId("version-preview-banner").count()).toBe(0);
    expect((await getState()).project.textClips[0].text).toBe("Cut 8");
    await launched.page.screenshot({ path: path.join(evidence, "archive-tree.png") });
    await launched.page.getByTestId(`version-node-${first.id}`).click({ button: "right" });
    const menu = launched.page.getByTestId("version-node-menu");
    const actions = await menu.getByRole("menuitem").all();
    expect(actions).toHaveLength(5);
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
      "View this node's media", "Preview save point", "Rename", "Continue from this save point", "Move save point to recycle bin",
    ]);
    const rows = await Promise.all(actions.map(action => action.boundingBox()));
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      expect(row.height).toBeGreaterThanOrEqual(32);
      expect(row.width).toBeGreaterThan(180);
      expect(row.x).toBeCloseTo(rows[0]!.x, 1);
      if (index > 0) expect(row.y).toBeGreaterThanOrEqual(rows[index - 1]!.y + rows[index - 1]!.height - 1);
    }
    observations.contextMenuRows = rows;
    await launched.page.screenshot({ path: path.join(evidence, "archive-context-menu.png") });
    await launched.page.keyboard.press("Escape");
    await launched.page.getByTestId(`version-node-${first.id}`).dblclick();
    await launched.page.getByTestId("version-preview-banner").waitFor();
    await launched.page.getByTestId("requirement-board-entry").click();
    await launched.page.getByRole("button", { name: "New requirement", exact: true }).click();
    const formTitle = launched.page.getByRole("textbox", { name: "New requirement", exact: true });
    await formTitle.fill("Board writes to actual edit");
    await launched.page.getByRole("button", { name: "Select text clip New Title", exact: true }).click();
    expect(await launched.page.getByTestId("inspector-properties").isVisible()).toBe(true);
    await launched.page.getByTestId("requirement-board-entry").click();
    expect(await formTitle.inputValue()).toBe("Board writes to actual edit");
    expect(await launched.page.getByTestId("version-preview-banner").isVisible()).toBe(true);
    await launched.page.getByRole("button", { name: "Publish to board", exact: true }).click();
    await vi.waitFor(async () => expect((await getState()).project.requirements.items[0].title).toBe("Board writes to actual edit"));
    observations.boardDuringPreview = { target, displayedPreview: first.id, actualRequirements: (await getState()).project.requirements.items };
    await launched.page.screenshot({ path: path.join(evidence, "board-preview.png") });
    await launched.page.getByTestId("version-preview-return").click();
    await launched.page.getByRole("button", { name: "New requirement", exact: true }).click();
    await formTitle.fill("Unsubmitted project A form");
    await launched.page.getByRole("button", { name: "Horizontal", exact: true }).click();
    await launched.page.getByRole("button", { name: "New Project", exact: true }).click();
    await launched.page.getByLabel(/^Vertical /).click();
    await vi.waitFor(async () => expect((await call("editor.get_context")).identity.projectId).not.toBe(target.projectId));
    await launched.page.getByTestId("requirement-board-entry").click();
    await launched.page.getByRole("button", { name: "New requirement", exact: true }).click();
    expect(await formTitle.inputValue()).toBe("");
    await launched.page.getByRole("button", { name: "Vertical", exact: true }).click();
    await launched.page.getByRole("button", { name: "Open Horizontal", exact: true }).click();
    await vi.waitFor(async () => expect((await call("editor.get_context")).identity.projectId).toBe(target.projectId));
    await launched.page.getByTestId("requirement-board-entry").click();
    expect(await formTitle.inputValue()).toBe("Unsubmitted project A form");
    observations.projectFormsIsolated = true;
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720));
    await launched.page.getByTestId("current-archive-entry").click();
    await launched.page.screenshot({ path: path.join(evidence, "narrow-archives.png") });
  } finally {
    if (evidence) writeFileSync(path.join(evidence, "layout.json"), JSON.stringify(observations, null, 2));
    await agent?.close();
    await launched.close({ keepRunDir: true });
  }
}, 240_000);
