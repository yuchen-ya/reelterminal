/**
 * AI material workbench end-to-end acceptance (isolated profile).
 *
 * Verifies the real loop against a built desktop app: an external agent
 * process ingests a review batch through the Command API, the GUI reviews it
 * (decisions, text revision, data patch), publishes a handoff, the agent
 * reads + acks it and returns rework linked to the original item/version.
 * Everything runs in the isolated harness run dir; no paid or generative
 * service is involved.
 */
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  waitForEditorReady,
} from "./harness/ui";

async function waitForStableWorkspace(agent: ExternalAgent, timeoutMs = 20_000): Promise<void> {
  // The first write after GUI startup can race the workspace bootstrap (the
  // workspace instance id changes once). Poll until two consecutive context
  // reads agree before issuing writes.
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const context = await agent.callCommand<{ identity: { workspaceInstanceId?: string } }>(
      "editor.get_context",
    );
    const instance = context.value?.identity.workspaceInstanceId ?? "";
    if (instance && instance === last) return;
    last = instance;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

describe("workbench: ingest → review → handoff → rework", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let identity: { projectId: string; workspaceId: string; projectEpoch: string } | null = null;
  let projectRevision = 0;

  /** Writes must bind the explicit project/workspace identity like reelctl. */
  const write = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; value?: T; error?: { code: string; message: string } }> =>
    agent.callCommand<T>(name, {
      ...args,
      projectId: identity?.projectId,
      workspaceId: identity?.workspaceId,
      ...(name === "edit.apply" ? { expectedRevision: projectRevision } : {}),
    });

  const refreshContext = async (): Promise<void> => {
    const context = await agent.callCommand<{
      projectRevision: number;
      identity: { projectId: string; workspaceId: string; projectEpoch: string };
    }>("editor.get_context");
    if (context.value?.identity.projectId) {
      identity = context.value.identity;
    }
    // The revision CAS must match the workspace the writes target; the
    // workbench changes view reports that workspace's projectRevision.
    const changes = await agent.callCommand<{ projectRevision: number }>(
      "workbench.changes",
      { batchId: "e2e-batch-1" },
    );
    if (changes.ok && changes.value && changes.value.projectRevision >= 0) {
      projectRevision = changes.value.projectRevision;
    } else if (context.value?.projectRevision !== undefined) {
      projectRevision = context.value.projectRevision;
    }
  };

  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await waitForEditorReady(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    await waitForStableWorkspace(agent);
    await refreshContext();
  }, 240_000);

  afterAll(async () => {
    await agent?.close();
    await launched?.close();
  });

  test("agent ingests a batch over the Command API before the GUI touches it", async () => {
    await refreshContext();
    const ingested = await write("workbench.ingest", {
      batchId: "e2e-batch-1",
      name: "E2E 批次",
      items: [
        {
          id: "e2e-txt-1",
          title: "语料条目",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-1",
            title: "语料条目",
            speakerOrContext: "旁白",
            text: "第一段落包含重复短语。第二段落也有重复短语。",
          },
          agentGuidance: {
            triageGroup: "need_verdict",
            branchName: "文字组",
            nodeSlotLabel: "语料条目",
            whatHappened: "生成完成",
            whatToDoNext: "请人工核对",
            nodButtonLabel: "点头保留",
            nodDecision: "kept",
          },
        },
        {
          id: "e2e-data-1",
          title: "清洗表",
          type: "data",
          content: {
            type: "data",
            datasetId: "ds-1",
            columns: [{ columnId: "c-date", title: "日期" }],
            rows: [
              { rowId: "r1", cells: { "c-date": "2026/1/5" } },
              { rowId: "r2", cells: { "c-date": "2026-01-06" } },
            ],
            proposals: [
              {
                proposalId: "p1",
                rowId: "r1",
                columnId: "c-date",
                originalValue: "2026/1/5",
                proposedValue: "2026-01-05",
                reason: "日期归一",
                provenanceTagId: "tag-date",
                status: "proposed",
              },
            ],
          },
        },
      ],
    });
    expect(ingested.ok, JSON.stringify(ingested.error)).toBe(true);
    await refreshContext();

    // The GUI switches to the workbench tab and shows the ingested items.
    const page = launched.page;
    const tab = page.getByRole("tab", { name: /Review Workspace|审阅工作台/i });
    await tab.waitFor({ state: "visible", timeout: 15_000 });
    await tab.click();
  await page.getByTestId("review-page").waitFor({ state: "visible" });
  if (!await page.locator("[data-review-legacy]").isVisible()) {
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification", exact: true }).all()) {
      await dismiss.click();
    }
    if (await page.getByTestId("review-admin-menu-trigger").isVisible()) {
      await page.getByTestId("review-admin-menu-trigger").click();
    }
    await page.getByTestId("review-legacy-project").click();
  }
    await page.getByTestId("workbench-page").waitFor({ state: "visible", timeout: 15_000 });
    // The workbench must NOT show the video-editor export control.
    expect(await page.locator("[data-tour='desktop-export']").count()).toBe(0);
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("语料条目")
      .first()
      .waitFor({ timeout: 15_000 });
  });

  test("GUI text revision + decision is visible to the agent through workbench.get", async () => {
    const page = launched.page;
    await page.getByText("语料条目").first().click();
    await page
      .getByTestId("workbench-content")
      .getByText("重复短语")
      .first()
      .waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "直接改文" }).first().click();
    const editor = page.getByTestId("workbench-content").locator("textarea").first();
    await editor.waitFor({ timeout: 10_000 });
    await editor.fill("人工修订后的正文内容。");
    await page.getByRole("button", { name: /保存修改/ }).first().click();
    await page.getByText("已修改").first().waitFor({ timeout: 15_000 });

    const read = await agent.callCommand("workbench.get", { batchId: "e2e-batch-1" });
    expect(read.ok).toBe(true);
    const items = (read.value as { items: Array<{ id: string; status: string; version: number }> }).items;
    const text = items.find((item) => item.id === "e2e-txt-1");
    expect(text?.status).toBe("modified");
    expect(text?.version).toBe(2);
  });

  test("data proposal confirm patches exactly the chosen cell", async () => {
    const page = launched.page;
    await page.getByText("清洗表").first().click();
    await page
      .getByTestId("workbench-content")
      .getByText("2026/1/5")
      .first()
      .waitFor({ timeout: 10_000 });
    // Select the pending proposal cells explicitly, then confirm (the button
    // always shows its actual scope count).
    await page.getByRole("button", { name: /全选待清洗建议/ }).first().click();
    await page.getByRole("button", { name: /^确认建议 \(/ }).first().click();
    await page
      .getByTestId("workbench-content")
      .getByText("2026-01-05")
      .first()
      .waitFor({ timeout: 15_000 });
    const read = await agent.callCommand("workbench.get", {
      batchId: "e2e-batch-1",
      itemId: "e2e-data-1",
      includeData: true,
    });
    expect(read.ok).toBe(true);
    const item = (read.value as { item: {
      content: { rows: Array<{ rowId: string; cells: Record<string, string | null> }> };
      status: string;
    } }).item;
    expect(item.content.rows.find((row) => row.rowId === "r1")?.cells["c-date"]).toBe("2026-01-05");
    // The untouched row keeps its original value.
    expect(item.content.rows.find((row) => row.rowId === "r2")?.cells["c-date"]).toBe("2026-01-06");
    expect(item.status).toBe("modified");
  });

  test("publish → agent reads → acks → rework returns linked to the original version", async () => {
    const page = launched.page;
    // Mark the text item as rework first (its revision stays as the input).
    // The left queue defaults to "全部" (the prototype's processed/retrieve
    // switch), so the already-decided item is reachable there.
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("语料条目", { exact: true })
      .first()
      .click();
    await page.getByTitle(/标为待返工/).first().click();
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("返工", { exact: true })
      .first()
      .waitFor({ timeout: 15_000 });

    // Publish through the real handoff dialog.
    await page.getByRole("button", { name: /交回本轮决策/ }).click();
    const publish = page
      .getByRole("button", { name: /发布本轮交接快照|发布新修订快照/ })
      .first();
    await publish.waitFor({ timeout: 10_000 });
    await publish.click();
    await page.getByText(/等待 Agent 读取/).first().waitFor({ timeout: 15_000 });

    // The agent discovers the handoff through workbench.changes, reads the
    // snapshot, acks, and returns rework for the item.
    const changes = await agent.callCommand("workbench.changes", { batchId: "e2e-batch-1" });
    expect(changes.ok).toBe(true);
    const handoffEvents = (changes.value as {
      handoffEvents: Array<{ handoffId: string; deliveryState: string }>;
    }).handoffEvents;
    expect(handoffEvents.length).toBeGreaterThanOrEqual(1);
    const handoffId = handoffEvents[0].handoffId;
    expect(handoffEvents[0].deliveryState).toBe("published_waiting");

    const snapshot = await agent.callCommand("workbench.handoff.get", { handoffId });
    expect(snapshot.ok).toBe(true);
    const reworkTarget = ((snapshot.value as { handoff: {
      items: Array<{ itemId: string; decision: string; itemVersion: number }>;
    } }).handoff.items).find((item) => item.decision === "rework");
    expect(reworkTarget).toBeDefined();

    await refreshContext();
    const acked = await write("edit.apply", {
      ops: [{ op: "workbench.handoff.ack", handoffId }],
    });
    expect(acked.ok, JSON.stringify(acked.error)).toBe(true);
    await refreshContext();

    const reworked = await write("edit.apply", {
      ops: [
        {
          op: "workbench.rework",
          handoffId,
          results: [
            {
              sourceItemId: reworkTarget!.itemId,
              previousVersion: reworkTarget!.itemVersion,
              content: {
                type: "text",
                entryId: "entry-1",
                title: "语料条目",
                speakerOrContext: "旁白",
                text: "返工后的新正文",
              },
            },
          ],
        },
      ],
    });
    expect(reworked.ok, JSON.stringify(reworked.error)).toBe(true);

    // The item is PENDING again with the origin link; the previously decided
    // data item is NOT reopened.
    const read = await agent.callCommand("workbench.get", {
      batchId: "e2e-batch-1",
      itemId: reworkTarget!.itemId,
    });
    const item = (read.value as { item: {
      status: string;
      reworkOrigin?: { fromHandoffId: string };
    } }).item;
    expect(item.status).toBe("pending");
    expect(item.reworkOrigin?.fromHandoffId).toBe(handoffId);

    const dataRead = await agent.callCommand("workbench.get", {
      batchId: "e2e-batch-1",
      itemId: "e2e-data-1",
    });
    expect((dataRead.value as { item: { status: string } }).item.status).toBe("modified");

    // A stale rework (parenting an old version) must fail without changes.
    await refreshContext();
    const stale = await write("edit.apply", {
      ops: [
        {
          op: "workbench.rework",
          handoffId,
          results: [
            {
              sourceItemId: reworkTarget!.itemId,
              previousVersion: 1,
              content: {
                type: "text",
                entryId: "entry-1",
                title: "语料条目",
                speakerOrContext: "旁白",
                text: "冲突版本",
              },
            },
          ],
        },
      ],
    });
    expect(stale.ok).toBe(false);
  });
});
