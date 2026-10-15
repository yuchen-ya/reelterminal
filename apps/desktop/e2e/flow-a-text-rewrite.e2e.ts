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
import { connectExternalAgent, type ExternalAgent, type FacadeCallResult } from "./harness/mcp-client";
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
  identity: { projectId: string; workspaceId: string; projectName: string; windowId: string };
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
  let target: { projectId: string; workspaceId: string };

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

    target = { projectId: ctx.identity.projectId, workspaceId: ctx.identity.workspaceId };
    const timeline = await agent.callTool<TimelineView>("timeline_get", target);
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
      ...target,
      ops: [{ op: "text.update", overlayId, text: AGENT_TEXT }],
      expectedContextRevision: firstContext.contextRevision,
    });
    evidence.record("rewrite_result", applied);
    if (!applied.ok) {
      evidence.record("context_at_rejection", (await agent.callTool<EditorContext>("editor_get_context")).value);
      evidence.record("renderer_diagnostics", launched.output.rendererConsole.map(line => line.replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")));
    }
    expect(applied.ok, JSON.stringify(applied.error)).toBe(true);
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
    const beforeContext = await agent.callTool<EditorContext>("editor_get_context");
    const beforeTimeline = await agent.callTool<TimelineView>("timeline_get", target);
    evidence.record("before_human_drag", { context: beforeContext, timeline: beforeTimeline });
    expect(beforeContext.ok).toBe(true);
    expect(beforeTimeline.ok).toBe(true);

    // Observe one unchanged real gesture. Keep evidence before assertions so a
    // missed input, cancellation and pending/failed canonical commit differ.
    await launched.page.evaluate((id) => {
      const host = globalThis as typeof globalThis & {
        __flowADragProbe?: () => unknown;
        __reelterminalPerformanceCapture?: {
          start(request: unknown): unknown;
          stop(): unknown;
        };
      };
      const clip = document.querySelector<HTMLElement>(`[data-live-editor-target-id="${id}"]`);
      const samples: unknown[] = [];
      const started = performance.now();
      const describe = (element: Element | null) => element && ({
        tag: element.tagName,
        targetId: element.closest("[data-live-editor-target-id]")?.getAttribute("data-live-editor-target-id"),
        role: element.getAttribute("role"),
      });
      const sample = (event?: Event) => {
        if (samples.length >= 80) return;
        const mouse = event instanceof MouseEvent ? event : null;
        const box = clip?.getBoundingClientRect();
        samples.push({
          elapsedMs: performance.now() - started, event: event?.type ?? "snapshot",
          trusted: event?.isTrusted, focused: document.hasFocus(), visibility: document.visibilityState,
          x: mouse?.clientX, y: mouse?.clientY, buttons: mouse?.buttons,
          hit: mouse ? describe(document.elementFromPoint(mouse.clientX, mouse.clientY)) : null,
          target: event?.target instanceof Element ? describe(event.target) : null,
          box: box && { x: box.x, y: box.y, width: box.width, height: box.height },
          transform: clip?.style.transform, className: clip?.className,
          notifications: [...document.querySelectorAll('[data-testid="notification-toast"]')].map(node => node.textContent),
        });
      };
      const events = ["mousedown", "mousemove", "mouseup", "blur", "focus", "visibilitychange"];
      for (const event of events) window.addEventListener(event, sample, true);
      const capture = host.__reelterminalPerformanceCapture;
      capture?.start({ mode: "trace", runId: "flow-a-human-drag", budgets: { captureSeconds: 10, eventsCapacity: 4096, criticalEventsCapacity: 1024, memorySampleIntervalSeconds: 0 } });
      sample();
      host.__flowADragProbe = () => {
        for (const event of events) window.removeEventListener(event, sample, true);
        sample();
        delete host.__flowADragProbe;
        return { samples, performance: capture?.stop() };
      };
    }, overlayId);

    let context: FacadeCallResult<EditorContext> | undefined;
    let timeline: FacadeCallResult<TimelineView> | undefined;
    try {
      await dragTextClipViaUI(launched.page, AGENT_TEXT, 100);
      context = await agent.callTool<EditorContext>("editor_get_context");
      timeline = await agent.callTool<TimelineView>("timeline_get", target);
      evidence.record("after_human_drag", { context, timeline });
    } finally {
      evidence.record("human_drag_probe", await launched.page.evaluate(() =>
        (globalThis as typeof globalThis & { __flowADragProbe?: () => unknown }).__flowADragProbe?.(),
      ).catch(error => ({ unavailable: String(error) })));
      await evidence.screenshot("after-human-drag").catch(error =>
        evidence.record("human_drag_screenshot_error", String(error)),
      );
      evidence.flush();
    }
    expect(context?.ok).toBe(true);
    expect(timeline?.ok).toBe(true);
    const ctx = context!.value!;
    // Undo/redo already advanced the revision; compare with the immediate
    // pre-gesture revision so only this human edit can satisfy the handoff.
    expect(ctx.projectRevision).toBeGreaterThan(beforeContext.value!.projectRevision);
    const overlay = timeline!.value!.textOverlays.find((o) => o.text === AGENT_TEXT);
    expect(overlay).toBeDefined();
    expect(overlay!.startTime).toBeGreaterThan(0);

    evidence.record("handoff", {
      revisionAfterAgentEdit,
      revisionBeforeHumanDrag: beforeContext.value!.projectRevision,
      revisionAfterHumanDrag: ctx.projectRevision,
      draggedStartTime: overlay!.startTime,
    });
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
