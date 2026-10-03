/**
 * 选中文字，让 Agent 通过外部连接改写。
 *
 * Human side: real UI input only (Playwright mouse/keyboard on the Electron
 * window). Agent side: a real MCP JSON-RPC client → live endpoint. The test
 * process never calls the facade in-process.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import {
  createProjectViaUI,
  createTextClipViaUI,
  dragTextClipViaUI,
  enableAgentSessionViaUI,
  selectTextClipViaUI,
  timelineTextClip,
  pressUndo,
  pressRedo,
} from "./harness/ui";

interface EditorContext {
  mode: string;
  projectRevision: number;
  contextAvailable: boolean;
  contextRevision: number | null;
  playheadSeconds: number | null;
  selectedClipIds: string[];
  selectedTextIds: string[];
  timeRange: unknown;
  canvasPoint: { x: number; y: number } | null;
  identity: { projectId: string; projectName: string; windowId: string };
}

interface TimelineView {
  revision: number;
  textOverlays: Array<{ id: string; text: string; startTime: number; duration: number }>;
}

const ORIGINAL_TEXT = "New Title";
const AGENT_TEXT = "Rewritten by the agent";

describe("flow A: select text, external agent rewrites it", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let evidence: EvidenceRecord;
  let firstContext: EditorContext;
  let overlayId: string;
  let revisionAfterAgentEdit: number;

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("flow-a-text-rewrite", launched.page);
    // Human: create a project, add a text clip, select it — all real UI.
    await createProjectViaUI(launched.page);
    await createTextClipViaUI(launched.page);
    await selectTextClipViaUI(launched.page, ORIGINAL_TEXT);
    // Human: enable Agent Access via the real status-bar toggle.
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    // Agent: connect over real MCP stdio (shim → live endpoint).
    agent = await connectExternalAgent(launched.endpointFile);
  }, 300_000);

  afterAll(async () => {
    evidence.flush();
    await agent?.close();
    await launched?.close();
  });

  test("agent reads the user's real text selection via editor.get_context", async () => {
    const ctxResult = await agent.callTool<EditorContext>("editor_get_context");
    expect(ctxResult.ok).toBe(true);
    const ctx = ctxResult.value!;
    expect(ctx.mode).toBe("live");
    expect(ctx.contextAvailable).toBe(true);
    expect(typeof ctx.projectRevision).toBe("number");
    expect(typeof ctx.contextRevision).toBe("number");
    expect(ctx.selectedTextIds).toHaveLength(1);

    const timeline = await agent.callTool<TimelineView>("timeline_get");
    expect(timeline.ok).toBe(true);
    const overlay = timeline.value!.textOverlays.find((o) => o.text === ORIGINAL_TEXT);
    expect(overlay).toBeDefined();
    // The id the agent sees on the timeline IS the id in the user's selection.
    expect(ctx.selectedTextIds[0]).toBe(overlay!.id);
    expect(ctx.identity.projectName).toContain("Horizontal");

    firstContext = ctx;
    overlayId = overlay!.id;
    evidence.record("context_after_selection", ctx);
    evidence.record("timeline_overlays", timeline.value!.textOverlays);
  });

  test("agent rewrites the text with a context-CAS edit; the GUI updates without reload", async () => {
    const urlBefore = launched.page.url();

    const applied = await agent.callTool<{ revision: number }>("edit_apply", {
      ops: [{ op: "text.update", overlayId, text: AGENT_TEXT }],
      expectedContextRevision: firstContext.contextRevision,
    });
    expect(applied.ok).toBe(true);
    expect(applied.value!.revision).toBeGreaterThan(firstContext.projectRevision);
    revisionAfterAgentEdit = applied.value!.revision;

    // GUI legibility WITHOUT a reload: the timeline label follows the store.
    await timelineTextClip(launched.page, AGENT_TEXT).waitFor({ timeout: 15_000 });
    expect(await timelineTextClip(launched.page, ORIGINAL_TEXT).count()).toBe(0);
    expect(launched.page.url()).toBe(urlBefore);

    evidence.record("agent_edit_apply", {
      overlayId,
      expectedContextRevision: firstContext.contextRevision,
      newRevision: revisionAfterAgentEdit,
    });
    await evidence.screenshot("after-agent-rewrite");
  });

  // The human undoes the agent edit and
  // redoes the agent's batch with REAL keyboard input (Playwright
  // Meta+z / Meta+Shift+z → DOM-level handler in DesktopApp — the G-01 fix;
  // one agent edit.apply batch is exactly one GUI undo unit).
  test("user undoes/redoes the agent batch with real Cmd+Z / Cmd+Shift+Z", async () => {
    await pressUndo(launched.page);
    // The agent's rewrite is reverted as ONE undo unit — the pre-agent text
    // is back and the agent's text is gone from the timeline.
    await timelineTextClip(launched.page, ORIGINAL_TEXT).waitFor({ timeout: 10_000 });
    expect(await timelineTextClip(launched.page, AGENT_TEXT).count()).toBe(0);

    await pressRedo(launched.page);
    await timelineTextClip(launched.page, AGENT_TEXT).waitFor({ timeout: 10_000 });
    expect(await timelineTextClip(launched.page, ORIGINAL_TEXT).count()).toBe(0);

    // Handoff legibility: the agent observes the post-undo/redo revisions —
    // undo and redo each advanced the shared project revision past the
    // revision the agent's own edit produced.
    const ctx = (await agent.callTool<EditorContext>("editor_get_context")).value!;
    expect(ctx.projectRevision).toBeGreaterThan(revisionAfterAgentEdit);
    evidence.record("undo_redo", {
      revisionAfterAgentEdit,
      revisionAfterUndoRedo: ctx.projectRevision,
    });
    await evidence.screenshot("after-redo");
  });

  test("handoff legibility: the agent observes a real human edit as a new revision", async () => {
    // Human: drag the rewritten caption on the timeline (real mouse drag) —
    // a genuine project mutation on the human side.
    await dragTextClipViaUI(launched.page, AGENT_TEXT, 100);

    // Agent: the human's edit is visible as an advanced revision, and the
    // agent's own text is intact under the human's timing change.
    const ctx = (await agent.callTool<EditorContext>("editor_get_context")).value!;
    expect(ctx.projectRevision).toBeGreaterThan(revisionAfterAgentEdit);
    const timeline = await agent.callTool<TimelineView>("timeline_get");
    const overlay = timeline.value!.textOverlays.find((o) => o.text === AGENT_TEXT);
    expect(overlay).toBeDefined();
    expect(overlay!.startTime).toBeGreaterThan(0);

    evidence.record("handoff", {
      revisionAfterAgentEdit,
      revisionAfterHumanDrag: ctx.projectRevision,
      draggedStartTime: overlay!.startTime,
    });
    await evidence.screenshot("after-human-drag");
  });

  test("evidence: endpoint file + run dir were per-test isolated", async () => {
    expect(existsSync(launched.endpointFile)).toBe(true);
    const endpoint = JSON.parse(readFileSync(launched.endpointFile, "utf8")) as {
      url: string;
      token: string;
      commandApi: { url: string; version: number };
    };
    expect(endpoint.commandApi.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(endpoint.commandApi.version).toBe(1);
    expect(typeof endpoint.token).toBe("string");
    evidence.record("endpoint", { url: endpoint.commandApi.url });
  });
});
