/**
 * Cross-cutting (C) — shared revision/CAS against real human edits, session
 * disable/reconnect, save→reopen recovery, and the token security boundary
 * (ADR 0004 Decisions 3, 6, 9).
 *
 * Human side: real UI input only. External agent: authenticated live endpoint.
 */
import { expect, test, describe, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import {
  createProjectViaUI,
  disableAgentSessionViaUI,
  dragTextClipViaUI,
  enableAgentSessionViaUI,
  openRecentProjectViaUI,
  timelineTextClip,
  waitForEditorReady,
} from "./harness/ui";

interface EditorContext {
  projectRevision: number;
  contextRevision: number | null;
}

interface TimelineView {
  revision: number;
  textOverlays: Array<{ id: string; text: string; startTime: number; duration: number }>;
}

const CAPTION_TEXT = "DRAG-ME-CAPTION";

async function postJson(
  url: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.text() };
}

describe("cross-cutting: revisions, sessions, lease, security", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent | null = null;
  let evidence: EvidenceRecord;
  let revisionAfterAgentCreate: number;
  let revisionAfterHumanDrag: number;

  const readContext = async (): Promise<EditorContext> => {
    const result = await agent!.callTool<EditorContext>("editor_get_context");
    expect(result.ok).toBe(true);
    return result.value!;
  };

  const readTimeline = async (): Promise<TimelineView> => {
    const result = await agent!.callTool<TimelineView>("timeline_get");
    expect(result.ok).toBe(true);
    return result.value!;
  };

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("cross-cutting", launched.page);
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);

    // Agent creates the caption the later tests work on.
    const applied = await agent.callTool<{ revision: number }>("edit_apply", {
      ops: [
        { op: "track.add", trackType: "text" },
        { op: "text.create", text: CAPTION_TEXT, startTime: 2, duration: 3 },
      ],
    });
    expect(applied.ok).toBe(true);
    revisionAfterAgentCreate = applied.value!.revision;
    await timelineTextClip(launched.page, CAPTION_TEXT).waitFor({ timeout: 15_000 });
  }, 300_000);

  afterAll(async () => {
    evidence.flush();
    await agent?.close();
    await launched?.close();
  });

  test("shared revision: a real UI edit bumps the revision the agent CAS-guards", async () => {
    // Human: drag the caption on the timeline (real mouse drag).
    await dragTextClipViaUI(launched.page, CAPTION_TEXT, 100); // ≈ +2s at 50px/s

    const ctx = await readContext();
    expect(ctx.projectRevision).toBeGreaterThan(revisionAfterAgentCreate);
    revisionAfterHumanDrag = ctx.projectRevision;

    const timeline = await readTimeline();
    const overlay = timeline.textOverlays.find((o) => o.text === CAPTION_TEXT);
    expect(overlay).toBeDefined();
    // The drag moved the clip (tolerance: snap/rounding, ±0.8s).
    expect(overlay!.startTime).toBeGreaterThan(2.5);

    // Agent replays an edit against the PRE-human-edit revision → CONFLICT.
    const stale = await agent!.callTool("edit_apply", {
      ops: [{ op: "text.update", overlayId: overlay!.id, text: "SHOULD-NOT-LAND" }],
      expectedRevision: revisionAfterAgentCreate,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error!.code).toBe("CONFLICT");

    const after = await readTimeline();
    expect(after.textOverlays.some((o) => o.text === "SHOULD-NOT-LAND")).toBe(false);

    evidence.record("shared_revision", {
      revisionAfterAgentCreate,
      revisionAfterHumanDrag,
      draggedStartTime: overlay!.startTime,
      staleConflict: stale.error,
    });
    await evidence.screenshot("after-human-drag");
  });

  test("disable mid-connection fails MCP calls cleanly; re-enable reconnects with state intact", async () => {
    // Human: disable the Agent Session via the real toggle. Both main's
    // endpoint lifecycle and the renderer's sequenced status must converge.
    await disableAgentSessionViaUI(launched.page, launched.endpointFile);
    expect(existsSync(launched.endpointFile)).toBe(false);

    const uiState = await launched.page.evaluate(() => ({
      ariaChecked: document.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
      showsExternalConnected: document.body.innerText.includes("External agent connected"),
    }));
    expect(uiState).toEqual({
      ariaChecked: "false",
      showsExternalConnected: false,
    });
    evidence.record("g04_store_vs_main_after_disable", {
      mainDisabled: true,
      rendererShows: uiState,
      statusSequenceContract: "renderer rejects status snapshots older than the disable acknowledgement",
    });

    // Subsequent MCP calls fail cleanly (a surfaced error, never a hang).
    await expect(agent!.callTool("editor_get_context")).rejects.toThrow();

    // Human: re-enable via the real toggle; a NEW endpoint file appears.
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    await agent!.close();
    agent = await connectExternalAgent(launched.endpointFile);

    const ctx = await readContext();
    expect(ctx.projectRevision).toBe(revisionAfterHumanDrag);
    const timeline = await readTimeline();
    expect(timeline.textOverlays.some((o) => o.text === CAPTION_TEXT)).toBe(true);

    evidence.record("disable_reconnect", {
      revisionBeforeDisable: revisionAfterHumanDrag,
      revisionAfterReconnect: ctx.projectRevision,
      overlaysAfterReconnect: timeline.textOverlays.length,
    });
  });

  test("save → full relaunch → project recovered with the agent's text; context works again", async () => {
    const saved = await agent!.callTool<{ revision: number }>("project_save");
    expect(saved.ok).toBe(true);

    // Full app relaunch (new _electron.launch, SAME userData dir).
    launched = await launched.relaunch();
    evidence.bindPage(launched.page);

    // Human: open the recovered project from the start screen (real click).
    await openRecentProjectViaUI(launched.page, "Horizontal");
    await timelineTextClip(launched.page, CAPTION_TEXT).waitFor({ timeout: 15_000 });

    // Agent channel works again after re-enable.
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    await agent?.close();
    agent = await connectExternalAgent(launched.endpointFile);
    const ctx = await readContext();
    expect(typeof ctx.projectRevision).toBe("number");
    const timeline = await readTimeline();
    expect(timeline.textOverlays.some((o) => o.text === CAPTION_TEXT)).toBe(true);

    evidence.record("save_reopen", {
      savedRevision: saved.value!.revision,
      overlaysAfterReopen: timeline.textOverlays.length,
    });
    await evidence.screenshot("after-reopen");
  });

  test("security: the live token never leaves the main process; endpoint enforces auth", async () => {
    const endpoint = JSON.parse(readFileSync(launched.endpointFile, "utf8")) as {
      url: string;
      port: number;
      token: string;
    };

    // 1. No token accessor on the renderer bridge (top-level key scan).
    const bridgeKeys = await launched.page.evaluate(() =>
      Object.keys((window as unknown as { openreel: object }).openreel),
    );
    expect(bridgeKeys.filter((k) => /token/i.test(k))).toEqual([]);

    // 2. Renderer-reachable values never contain the live token.
    const statusJson = await launched.page.evaluate(() =>
      (
        window as unknown as {
          openreel: { collabControl: { getStatus(): Promise<unknown> } };
        }
      ).openreel.collabControl.getStatus().then((s) => JSON.stringify(s)),
    );
    expect(statusJson).not.toContain(endpoint.token);
    // 3. The endpoint file is mode 0600.
    const mode = statSync(launched.endpointFile).mode & 0o777;
    expect(mode.toString(8)).toBe("600");

    // 4. The renderer cannot use the endpoint without the token (fetch with
    // no Authorization either rejects — CORS — or is answered 401).
    const rendererFetch = await launched.page.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        });
        return { status: response.status };
      } catch (error) {
        return { error: String(error) };
      }
    }, endpoint.url);
    if ("status" in rendererFetch) {
      expect(rendererFetch.status).toBe(401);
    } else {
      expect(rendererFetch.error).toBeTruthy();
    }

    // 5. Auth is actually enforced server-side (loopback, token-compared).
    const noToken = await postJson(endpoint.url, null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(noToken.status).toBe(401);
    const wrongToken = await postJson(endpoint.url, "0".repeat(64), {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(wrongToken.status).toBe(401);
    const withToken = await postJson(endpoint.url, endpoint.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(withToken.status).toBe(200);

    // 6. Token hygiene across every captured process output.
    const outputs = {
      mainStdout: launched.output.mainStdout.join(""),
      mainStderr: launched.output.mainStderr.join(""),
      rendererConsole: launched.output.rendererConsole.join("\n"),
      shimStderr: agent?.shimStderr() ?? "",
    };
    for (const [channel, text] of Object.entries(outputs)) {
      expect(text, `live token leaked into ${channel}`).not.toContain(endpoint.token);
    }

    evidence.record("security", {
      bridgeKeys,
      endpointFileMode: mode.toString(8),
      rendererFetchResult: rendererFetch,
      noTokenStatus: noToken.status,
      wrongTokenStatus: wrongToken.status,
      withTokenStatus: withToken.status,
      scannedChannels: Object.fromEntries(
        Object.entries(outputs).map(([k, v]) => [k, { bytes: v.length, tokenPresent: false }]),
      ),
    });
  });
});
