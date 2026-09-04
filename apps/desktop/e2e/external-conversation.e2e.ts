import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { createProjectViaUI, createTextClipViaUI } from "./harness/ui";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
// The reference kit is plain ESM so external Agent hosts can copy it without
// taking a workspace dependency.
// @ts-expect-error JavaScript reference module intentionally has no TS surface.
import { startConversationAdapter } from "../../../scripts/conversation-adapter/adapter-kit.mjs";

interface AdapterHandle {
  close(): Promise<void>;
}

describe("external Agent conversation panel", () => {
  let launched: LaunchedApp;
  let adapter: AdapterHandle;
  let evidence: EvidenceRecord;
  let remoteSequence = 0;
  let approvalDecision: string | null = null;
  const visualStates: Array<Record<string, unknown>> = [];
  const queuedNotifications: Array<Record<string, unknown>> = [];
  const pollWaiters = new Set<() => void>();

  const pushUpdate = (update: Record<string, unknown>): void => {
    remoteSequence += 1;
    queuedNotifications.push({
      method: "session/update",
      params: {
        sessionId: "e2e-external-session",
        sequence: remoteSequence,
        update,
      },
    });
    for (const resolve of pollWaiters) resolve();
    pollWaiters.clear();
  };

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("external-conversation", launched.page);
    adapter = await startConversationAdapter({
      sessionId: "e2e-external-session",
      agent: { name: "E2E Editing Agent", version: "1.0" },
      adapter: { name: "e2e-adapter", capabilityLevel: "observable" },
      descriptorPath: launched.conversationEndpointFile,
      onPrompt: (params: {
        prompt: Array<{ text: string }>;
        visualState?: Record<string, unknown>;
      }) => {
        const prompt = params.prompt.map((part) => part.text).join("");
        if (params.visualState) visualStates.push(params.visualState);
        pushUpdate({
          sessionUpdate: "user_message",
          messageId: "user-1",
          content: [{ type: "text", text: prompt }],
        });
        pushUpdate({
          sessionUpdate: "reasoning_summary",
          summary: "Checking the marked clips before applying the edit.",
        });
        pushUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Inspect timeline",
          status: "running",
          summary: "Reading the canonical ReelTerminal timeline through MCP.",
          arguments: { hidden: "must not render" },
        });
        pushUpdate({
          sessionUpdate: "tool_result",
          toolCallId: "tool-1",
          title: "Inspect timeline",
          status: "completed",
          summary: "The marked clips are ready.",
          result: { hidden: "must not render" },
        });
        pushUpdate({
          sessionUpdate: "agent_message",
          messageId: "agent-1",
          content: [{ type: "text", text: "I can join #2 and #3 now." }],
        });
        pushUpdate({
          sessionUpdate: "approval_request",
          requestId: "approval-1",
          title: "Apply the edit?",
          summary: "The external Agent is waiting for your decision.",
        });
        pushUpdate({ sessionUpdate: "state_update", state: "idle" });
        return {};
      },
      onApproval: (params: { requestId: string; decision: string }) => {
        approvalDecision = params.decision;
        pushUpdate({
          sessionUpdate: "approval_resolution",
          requestId: params.requestId,
          outcome: params.decision === "approved" ? "approved" : "rejected",
        });
        return {};
      },
      onUpdates: async () => {
        if (queuedNotifications.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pollWaiters.delete(done);
              resolve();
            }, 100);
            const done = (): void => {
              clearTimeout(timer);
              resolve();
            };
            pollWaiters.add(done);
          });
        }
        return {
          cursor: String(remoteSequence),
          notifications: queuedNotifications.splice(0),
        };
      },
    });
    await createProjectViaUI(launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush({
      approvalDecision,
      visualStates: visualStates.map((state) => {
        const image = state.image as
          | { width?: unknown; height?: unknown; regions?: unknown }
          | undefined;
        return {
          stateRef: state.stateRef,
          baseRef: state.baseRef,
          kind: state.kind,
          projectRevision: state.projectRevision,
          contextRevision: state.contextRevision,
          changed: state.changed,
          imageAttached: Boolean(image),
          imageWidth: image?.width,
          imageHeight: image?.height,
          regions: image?.regions,
        };
      }),
    });
    await launched?.close();
    await adapter?.close();
  });

  test("attaches the same remote session and renders its chronological work log", async () => {
    const page = launched.page;
    await page.getByRole("button", { name: "Open external agent panel" }).click();
    await page.getByRole("button", { name: "Connect external Agent" }).click();
    await page.getByText("External Agent connected", { exact: true }).waitFor();

    const composer = page.getByRole("textbox", { name: "Message the external Agent" });
    await composer.fill("Join #2 and #3");
    await composer.press("Enter");

    await page.getByText("Join #2 and #3", { exact: true }).waitFor();
    await page.getByText("Inspect timeline", { exact: true }).waitFor();
    await page.getByText("I can join #2 and #3 now.", { exact: true }).waitFor();
    await page.getByText("Apply the edit?", { exact: true }).waitFor();
    expect(visualStates).toHaveLength(1);
    expect(visualStates[0]).toMatchObject({
      version: 1,
      kind: "keyframe",
      projectRevision: expect.any(Number),
      contextRevision: expect.any(Number),
      image: {
        type: "localImage",
        width: 960,
        height: 540,
      },
    });
    const image = visualStates[0]!.image as { path: string };
    expect(path.relative(launched.conversationVisualStateRoot, image.path)).not.toMatch(/^\.\./);
    expect((await readFile(image.path)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(await page.getByText("must not render", { exact: false }).count()).toBe(0);
    await evidence.screenshot("observable-work-log");

    await page.getByRole("button", { name: /Thinking summary/ }).click();
    await page
      .getByText("Checking the marked clips before applying the edit.", { exact: true })
      .waitFor();

    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByText("Approved", { exact: true }).waitFor();
    expect(approvalDecision).toBe("approved");

    // A second turn with no editor change reuses the prior keyframe and sends
    // only exact metadata, so the image input does not accumulate every turn.
    await composer.fill("Second turn without editor changes");
    await composer.press("Enter");
    await page.getByText("Second turn without editor changes", { exact: true }).waitFor();
    expect(visualStates).toHaveLength(2);
    expect(visualStates[1]).toMatchObject({
      version: 1,
      kind: "metadata",
      baseRef: visualStates[0]!.stateRef,
    });
    expect(visualStates[1]!.image).toBeUndefined();

    const secondApproval = page.getByRole("button", { name: "Approve" });
    if (await secondApproval.isVisible().catch(() => false)) {
      await secondApproval.click();
    }
    await createTextClipViaUI(page);
    await composer.fill("Third turn after a small visual edit");
    await composer.press("Enter");
    await page.getByText("Third turn after a small visual edit", { exact: true }).waitFor();
    expect(visualStates).toHaveLength(3);
    expect(visualStates[2]).toMatchObject({
      version: 1,
      kind: "delta",
      baseRef: visualStates[1]!.stateRef,
      changed: expect.arrayContaining(["timeline", "selection"]),
      image: { type: "localImage", regions: expect.any(Array) },
    });
    const deltaImage = visualStates[2]!.image as {
      width: number;
      height: number;
      regions: unknown[];
    };
    expect(deltaImage.regions.length).toBeGreaterThan(0);
    expect(deltaImage.regions.length).toBeLessThanOrEqual(4);
    expect(deltaImage.width * deltaImage.height).toBeLessThan(960 * 540);
    await evidence.screenshot("approval-resolved");
  });
});
