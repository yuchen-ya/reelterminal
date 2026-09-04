/**
 * Opt-in real-Codex acceptance test.
 *
 * Unlike the deterministic external-conversation fixture, this launches the
 * installed Codex app-server, creates a Codex-owned thread configured with the
 * shipped openreel-live-mcp connector, sends the prompt through the real
 * ReelTerminal conversation panel, and requires Codex itself to mutate the
 * visible canonical project. It is intentionally opt-in because it uses the
 * signed-in Codex account and a live model turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { DESKTOP_DIR } from "./harness/paths";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  pressRedo,
  pressUndo,
  timelineTextClip,
} from "./harness/ui";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
// Provider adapter is plain ESM so it remains usable outside the workspace.
// @ts-expect-error JavaScript reference module intentionally has no TS surface.
import { startCodexConversationAdapter } from "../../../scripts/conversation-adapter/codex-adapter.mjs";

interface CodexAdapterHandle {
  readonly threadId: string;
  close(): Promise<void>;
}

interface EditorContext {
  projectRevision: number;
}

const REAL_CODEX = process.env.OPENREEL_REAL_CODEX_E2E === "1";
const TITLE = `CODEX-LIVE-${Date.now()}`;

describe.skipIf(!REAL_CODEX)("real Codex conversation → MCP → GUI", () => {
  let launched: LaunchedApp;
  let adapter: CodexAdapterHandle;
  let observer: ExternalAgent;
  let evidence: EvidenceRecord;
  const codexUpdates: unknown[] = [];

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("real-codex-conversation", launched.page);
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    observer = await connectExternalAgent(launched.endpointFile);
    adapter = await startCodexConversationAdapter({
      createThread: true,
      cwd: path.resolve(DESKTOP_DIR, "../.."),
      descriptorPath: launched.conversationEndpointFile,
      env: {
        ...process.env,
        OPENREEL_LIVE_ENDPOINT_FILE: launched.endpointFile,
      },
      onDisplayUpdate: (event: unknown) => {
        codexUpdates.push(event);
      },
    });
  }, 300_000);

  afterAll(async () => {
    evidence?.flush({ codexThreadId: adapter?.threadId, codexUpdates });
    await observer?.close();
    await adapter?.close();
    await launched?.close();
  });

  test("Codex autonomously edits the live project and the GUI undoes it once", async () => {
    const before = await observer.callTool<EditorContext>("editor_get_context");
    expect(before.ok).toBe(true);

    const page = launched.page;
    await page.getByRole("button", { name: "Open external agent panel" }).click();
    await page.getByRole("button", { name: "Connect external Agent" }).click();
    await page.getByText("External Agent connected", { exact: true }).waitFor({ timeout: 30_000 });

    const composer = page.getByRole("textbox", { name: "Message the external Agent" });
    await composer.fill(
      `Use only the configured ReelTerminal openreel_live MCP tools. ` +
        `Read the current editor/timeline, then add one text overlay with the exact text ` +
        `"${TITLE}" at 0 seconds for 3 seconds. Do not run shell commands and do not edit files. ` +
        `After the GUI edit succeeds, reply with exactly "${TITLE} complete".`,
    );
    await composer.press("Enter");

    let approvalCount = 0;
    const titleClip = timelineTextClip(page, TITLE);
    const approvalDeadline = Date.now() + 240_000;
    while (Date.now() < approvalDeadline && !(await titleClip.isVisible().catch(() => false))) {
      const approve = page.getByRole("button", { name: "Approve" });
      if (await approve.isVisible().catch(() => false)) {
        await approve.click();
        approvalCount += 1;
      }
      await page.waitForTimeout(250);
    }
    evidence.record("codex_host_approvals", {
      approvalCount,
      reelTerminalMcpPreapprovedByAdapter: true,
    });
    await titleClip.waitFor({ timeout: 30_000 });
    await page.getByText(`${TITLE} complete`, { exact: true }).waitFor({ timeout: 240_000 });
    const safeUpdates = JSON.stringify(codexUpdates);
    expect(safeUpdates).not.toMatch(
      /"(?:authorization|arguments|result|command|cwd|path|url|rawReasoning)"\s*:/i,
    );
    expect(safeUpdates).not.toMatch(/Bearer\s+|\b[a-f0-9]{64}\b|raw chain of thought/i);
    const after = await observer.callTool<EditorContext>("editor_get_context");
    expect(after.ok).toBe(true);
    expect(after.value!.projectRevision).toBe(before.value!.projectRevision + 1);
    await evidence.screenshot("codex-edit-visible");

    // The composer intentionally owns Cmd+Z while focused. Move focus back to
    // the canonical editor before exercising the application's undo history.
    await titleClip.click();
    await pressUndo(page);
    await timelineTextClip(page, TITLE).waitFor({ state: "detached", timeout: 30_000 });
    const undone = await observer.callTool<EditorContext>("editor_get_context");
    expect(undone.value!.projectRevision).toBe(after.value!.projectRevision + 1);

    await pressRedo(page);
    await timelineTextClip(page, TITLE).waitFor({ timeout: 30_000 });
    const redone = await observer.callTool<EditorContext>("editor_get_context");
    expect(redone.value!.projectRevision).toBe(undone.value!.projectRevision + 1);
    await evidence.screenshot("codex-edit-redone");
    evidence.record("revision_and_undo_contract", {
      before: before.value!.projectRevision,
      afterEdit: after.value!.projectRevision,
      afterUndo: undone.value!.projectRevision,
      afterRedo: redone.value!.projectRevision,
      titleVisibleAfterEdit: true,
      titleDetachedAfterUndo: true,
      titleVisibleAfterRedo: true,
    });
  }, 600_000);
});
