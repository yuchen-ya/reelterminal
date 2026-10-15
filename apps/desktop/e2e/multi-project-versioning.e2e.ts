/**
 * Multi-project version nodes UX on the real desktop
 * (docs/VERSION-NODES-UX.md 交互验收).
 *
 * The renderer now exposes versions as a compact horizontal node track
 * (VersionNodeTrack), a read-only preview session (VersionPreviewBanner),
 * project-menu retention, close-time retention preferences
 * (CloseRetentionDialog) and the left-top project switcher notification —
 * the old always-visible version toolbar is gone. This spec drives the new
 * UX with real input and verifies the underlying guarantees (immutable node
 * media, fixed export input, restart recovery, durable idempotency) through
 * the same live CLI the Agent channel uses.
 *
 * Session layout (relaunches reuse one isolated run directory):
 *  1. one long first session: empty project, retain, read-only preview,
 *     adopt with draft protection, rename, delete/undo, project switch +
 *     Agent prompt copy, immutable media + fixed-input export;
 *  2-4. short sessions: close-time retention preferences (ask / auto /
 *     skip), restart recovery and replayed node saves.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { hasProcessExited, waitForProcessExit } from "./harness/teardown";
import { DESKTOP_DIR } from "./harness/paths";
import {
  createProjectViaUI,
  createTextClipViaUI,
  dragTextClipViaUI,
  enableAgentSessionViaUI,
  openRecentProjectViaUI,
  selectTextClipViaUI,
  timelineTextClip,
  waitForEditorReady,
} from "./harness/ui";

type Target = { projectId: string; workspaceId: string };

/* en-locale labels exercised through the real UI */
const L = {
  newProject: "New Project",
  openProjectPicker: "Open Project",
  retain: "Create save point",
  recoverMenu: "Recover previous edits",
  copyAgentPrompt: "Copy Agent prompt",
  tryAnotherCut: "Try another cut",
  retainSuccess: /Save point .* created|Current content already has a save point/,
  switchToast: /Switched to /,
  previewReadOnly: "Preview is read-only; changes are not allowed",
  previewSavedToast: "Previewing a saved point; current edits are unchanged.",
  savedToast: "Current edits saved",
  deletedToast: "Save point moved to recycle bin",
  deleteUndo: "Undo",
  adoptUndo: "Undo this switch",
  nextTimeClosing: "Next time when closing:",
  closeRetentionLabel: "Create a save point on close",
  settingsTab: "Projects & Saving",
};

describe("multi-project version nodes UX on the real desktop", () => {
  let launched: LaunchedApp;
  let evidence: string;
  let job: string;
  let a: Target;
  let b: Target;
  let aNodesAtClose: string[] = [];
  let activeProjectName = "Horizontal";
  let ffmpeg = "";
  let replaySaveArgs: Record<string, unknown> | undefined;
  let replayNodeId: string | undefined;
  let exportJobId: string | undefined;
  let exportPath: string | undefined;
  const outcomes: Record<string, unknown> = {};

  /* ------------------------------------------------------------------ */
  /* live CLI channel (same commands an external Agent uses)             */
  /* ------------------------------------------------------------------ */
  async function rawCall(command: string, args: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
    const request = { arguments: args, ...envelope };
    const result = await new Promise<any>((resolve, reject) => {
      const outputArgs = evidence
        ? ["--output-file", path.join(evidence, `cli-${command}-${crypto.randomUUID()}.json`)]
        : [];
      const child = spawn(
        process.execPath,
        [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), "call", command, "--stdin", ...outputArgs],
        {
          env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", () => {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`CLI ${command} did not return JSON: ${stderr}`)); }
      });
      child.stdin.end(JSON.stringify(request));
    });
    if (evidence) {
      appendFileSync(path.join(evidence, "cli-operations.jsonl"), `${JSON.stringify({ command, request, result })}\n`);
    }
    if (result.ok && typeof result.value?.savedTo === "string") {
      return JSON.parse(readFileSync(result.value.savedTo, "utf8"));
    }
    return result;
  }
  async function call(command: string, args: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
    const result = await rawCall(command, args, envelope);
    expect(result.ok, `${command}: ${JSON.stringify(result.error)}`).toBe(true);
    return result.value;
  }
  const state = (target: Target) => call("project.get_state", target);
  const context = (target?: Target) => call("editor.get_context", target ?? {});
  async function edit(target: Target, ops: unknown[], key?: string) {
    const before = await state(target);
    return call("edit.apply", {
      ...target,
      expectedRevision: before.revision,
      ops,
      idempotencyKey: key ?? `accept-edit-${crypto.randomUUID()}`,
    });
  }

  /** Non-recycled node summaries, oldest first. */
  async function liveNodes(projectId: string): Promise<any[]> {
    const nodes = (await call("node.list", { projectId })).nodes as any[];
    return nodes.filter((node) => node.recycledAt === undefined).sort((x, y) => x.createdAt - y.createdAt);
  }
  /** Resolve a project id by name through the CLI (no UI coupling). */
  async function projectIdByName(name: string): Promise<string> {
    const projects = (await call("project.list")).projects as any[];
    const found = projects.find((project) => project.name === name);
    expect(found, `project ${name} exists`).toBeTruthy();
    return found.id;
  }
  async function currentIdentity(): Promise<{ projectId: string; workspaceId: string }> {
    const ctx = await context();
    return { projectId: ctx.identity.projectId, workspaceId: ctx.identity.workspaceId };
  }
  async function displayedProjectIs(projectId: string) {
    await vi.waitFor(async () => expect((await currentIdentity()).projectId).toBe(projectId), {
      timeout: 30_000,
      interval: 300,
    });
  }
  function record(id: string, actual: unknown) {
    outcomes[id] = { status: "passed", actual };
    if (evidence) {
      writeFileSync(path.join(evidence, "acceptance-results.json"), JSON.stringify(outcomes, null, 2));
    }
  }

  /* ------------------------------------------------------------------ */
  /* real-input UI helpers                                               */
  /* ------------------------------------------------------------------ */
  const page = () => launched.page;
  const toastRegion = () => page().getByRole("region", { name: "Notifications" });
  const versionNode = (nodeId: string) => page().getByTestId(`version-node-${nodeId}`);
  const archive = () => page().locator('[data-testid="version-track"]:visible');
  async function openArchive() {
    if (!(await archive().count())) await page().getByTestId("current-archive-entry").click();
    await archive().waitFor();
  }
  async function previewNode(nodeId: string) {
    await openArchive();
    await versionNode(nodeId).dblclick();
  }

  async function waitForToast(text: string | RegExp, timeoutMs = 10_000): Promise<void> {
    // vitest's expect has no Playwright matchers (playwright-core only), so
    // waiting happens through the locator's own waitFor.
    const locator = typeof text === "string"
      ? toastRegion().getByText(text, { exact: true })
      : toastRegion().getByText(text);
    await locator.first().waitFor({ timeout: timeoutMs });
  }
  /** Click the action card of a toast (the card carries the label as title). */
  async function clickToastAction(actionLabel: string): Promise<void> {
    await toastRegion().locator(`[title="${actionLabel}"]`).first().click();
  }
  async function openProjectMenu(projectName: string): Promise<void> {
    if (!(await page().getByTestId("project-switch-menu").isVisible()))
      await page().getByRole("button", { name: projectName, exact: true }).click();
    await page().getByRole("button", { name: L.newProject, exact: true }).waitFor({ timeout: 10_000 });
  }
  /** 留存当前版本 from the left-top project menu. */
  async function retainViaMenu(projectName: string): Promise<void> {
    await openProjectMenu(projectName);
    await page().getByTestId("project-switch-menu").getByRole("button", { name: L.retain, exact: true }).click();
    await page().getByRole("button", { name: L.newProject, exact: true }).waitFor({ state: "detached" });
    await waitForToast(L.retainSuccess);
    await openArchive();
  }
  /** Project switch through the left-top menu (recent projects list). */
  async function switchToProjectViaMenu(projectName: string, projectId: string): Promise<void> {
    if ((await currentIdentity()).projectId === projectId) {
      activeProjectName = projectName;
      return;
    }
    await openProjectMenu(activeProjectName);
    await page().getByRole("button", { name: `Open ${projectName}` }).first().click();
    await displayedProjectIs(projectId);
    activeProjectName = projectName;
  }
  /** Second project created through the project menu's chooser screen. */
  async function createProjectViaSwitcher(formatLabel: string, formatProjectName: string): Promise<void> {
    await openProjectMenu(activeProjectName);
    await page().getByRole("button", { name: L.newProject, exact: true }).click();
    await page().getByLabel(new RegExp(`^${formatLabel} `)).click();
    await waitForEditorReady(page());
    await displayedProjectIs(await projectIdByName(formatProjectName));
    activeProjectName = formatProjectName;
  }
  async function renameNodeViaMenu(nodeId: string, nextName: string): Promise<void> {
    await openArchive();
    await versionNode(nodeId).click({ button: "right" });
    await page().getByTestId("version-node-menu").waitFor({ timeout: 5_000 });
    await page().getByTestId("version-menu-rename").click();
    const input = page().getByTestId("version-rename-input");
    await input.waitFor({ timeout: 5_000 });
    await input.fill(nextName);
    await input.press("Enter");
    await vi.waitFor(async () => {
      expect(await versionNode(nodeId).getAttribute("aria-label")).toBe(nextName);
    }, { timeout: 10_000, interval: 250 });
  }
  async function deleteNodeViaMenu(nodeId: string): Promise<void> {
    await versionNode(nodeId).click({ button: "right" });
    await page().getByTestId("version-node-menu").waitFor({ timeout: 5_000 });
    await page().getByTestId("version-menu-delete").click();
    await waitForToast(L.deletedToast);
    await vi.waitFor(async () => {
      const ids = (await liveNodes(a.projectId)).map((node) => node.id);
      expect(ids).not.toContain(nodeId);
    }, { timeout: 10_000, interval: 250 });
    expect(await versionNode(nodeId).count()).toBe(0);
  }
  async function undoDeleteViaToast(nodeId: string): Promise<void> {
    await clickToastAction(L.deleteUndo);
    await vi.waitFor(async () => {
      const ids = (await liveNodes(a.projectId)).map((node) => node.id);
      expect(ids).toContain(nodeId);
    }, { timeout: 10_000, interval: 250 });
    await versionNode(nodeId).waitFor({ timeout: 10_000 });
  }
  async function ensureSubstantiveEdit(target: Target, text: string, startTime: number): Promise<void> {
    await edit(target, [{ op: "text.create", text, startTime, duration: 2 }]);
    await timelineTextClip(page(), text).waitFor({ timeout: 15_000 });
  }

  /* ------------------------------------------------------------------ */
  /* window-close path (NOT app.exit — the retention guard must run)     */
  /* ------------------------------------------------------------------ */
  async function requestWindowClose(): Promise<void> {
    await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("no Electron window to close");
      win.close();
    });
  }
  async function closeWindowAndAwaitExit(timeoutMs = 40_000): Promise<void> {
    const child = launched.app.process();
    await requestWindowClose();
    await waitForProcessExit(child, timeoutMs);
  }
  /** Relaunch on the SAME run dir and reopen the given project. */
  async function relaunchAndOpen(projectName: string, projectId: string): Promise<void> {
    // The previous session usually exited through the real window-close path
    // (its Electron handle is dead), so launch a fresh app on the same run
    // directory instead of harness relaunch(), which closes the old handle.
    const runDir = launched.runDir;
    launched = await launchApp({ runDir });
    await openRecentProjectViaUI(page(), projectName);
    await enableAgentSessionViaUI(page(), launched.endpointFile);
    activeProjectName = projectName;
    await displayedProjectIs(projectId);
    const hints = page().getByTestId("notification-toast").filter({ hasText: /Copy Agent startup prompt|Switched to / });
    for (const hint of await hints.all()) {
      await hint.getByRole("button", { name: "Dismiss notification", exact: true }).click();
      await hint.waitFor({ state: "detached" });
    }
  }

  /* ------------------------------------------------------------------ */
  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(page());
    await enableAgentSessionViaUI(page(), launched.endpointFile);
    const capabilities = await call("capabilities.get");
    ffmpeg = capabilities.frameTools.ffmpeg.details.ffmpeg;
    // Generated media and evidence stay in the Agent workspace reported by
    // the app itself (docs/AGENT-WORKSPACE.md) — inside the isolated run dir.
    job = path.join(capabilities.mediaImport.recommendedRoot, "jobs", "2026-10-09-version-nodes-ux-e2e");
    for (const entry of ["source", "generated", "work", "project", "output", "evidence"]) {
      mkdirSync(path.join(job, entry), { recursive: true });
    }
    evidence = path.join(job, "evidence");
    writeFileSync(
      path.join(job, "brief.md"),
      "# Version nodes UX acceptance\nDrive the new version track UX (retain, preview, adopt, rename, delete, close preferences, project switch) and keep the CLI guarantees (immutable media, fixed export input, restart recovery).\n",
    );
    writeFileSync(path.join(evidence, "capabilities.json"), JSON.stringify(capabilities, null, 2));
    const startupHint = page().getByTestId("notification-toast").filter({ hasText: "Copy Agent startup prompt" });
    if (await startupHint.count()) {
      await startupHint.getByRole("button", { name: "Dismiss notification", exact: true }).click();
      await startupHint.waitFor({ state: "detached" });
    }
    a = await currentIdentity();
    expect(a.projectId).toBeTruthy();
    expect(a.workspaceId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    if (evidence && launched) {
      await page().screenshot({ path: path.join(evidence, "final-desktop.png") }).catch(() => undefined);
      writeFileSync(path.join(evidence, "renderer-console.txt"), launched.output.rendererConsole.join("\n"));
      writeFileSync(path.join(evidence, "acceptance-results.json"), JSON.stringify(outcomes, null, 2));
    }
    await launched?.close({ keepRunDir: true });
  });

  /* ------------------------------------------------------------------ */
  /* (a) 交互验收 1/2 — empty project: no track, no node from Ctrl+S      */
  /* ------------------------------------------------------------------ */
  test("empty project: the version track stays hidden and Ctrl+S creates no node", async () => {
    expect(await archive().count()).toBe(0);

    await createTextClipViaUI(page());
    await page().keyboard.press("Control+s");
    await waitForToast(L.savedToast);
    await page().waitForTimeout(1_500);

    expect(await archive().count()).toBe(0);
    expect(await liveNodes(a.projectId)).toHaveLength(0);
    record("A-empty-project", { trackRendered: false, nodesAfterCtrlS: 0 });
  });

  /* ------------------------------------------------------------------ */
  /* (b) 留存当前版本 → auto-named base node                              */
  /* ------------------------------------------------------------------ */
  test("retaining a version from the project menu creates the auto-named base node", async () => {
    await retainViaMenu(activeProjectName);

    const nodes = await liveNodes(a.projectId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe("First save point");
    const track = archive();
    await track.waitFor({ timeout: 10_000 });
    expect(await currentIdentity()).toEqual(a);

    const dot = versionNode(nodes[0]!.id);
    await dot.waitFor({ timeout: 10_000 });
    await vi.waitFor(async () => {
      expect(await dot.getAttribute("data-base")).toBe("true");
    }, { timeout: 10_000, interval: 250 });

    // Identical content replays onto the same base node (no duplicate node).
    await retainViaMenu(activeProjectName);
    expect(await liveNodes(a.projectId)).toHaveLength(1);

    record("B-retain", { nodeId: nodes[0]!.id, name: nodes[0]!.name });
  });

  /* ------------------------------------------------------------------ */
  /* (c) 交互验收 3/4 — read-only preview                                 */
  /* ------------------------------------------------------------------ */
  test("read-only preview never modifies history or the current edit", async () => {
    // Second retained version: the current edit gets a second text clip.
    await edit(a, [{ op: "text.create", text: "Second Title", startTime: 3, duration: 2 }]);
    await timelineTextClip(page(), "Second Title").waitFor({ timeout: 15_000 });
    await retainViaMenu(activeProjectName);
    let nodes = await liveNodes(a.projectId);
    expect(nodes).toHaveLength(2);
    const firstNodeId = nodes[0]!.id;
    const secondNodeId = nodes[1]!.id;
    expect(nodes[1]!.name).not.toBe("First save point"); // timestamped auto name

    await vi.waitFor(async () => {
      expect(await versionNode(secondNodeId).getAttribute("data-base")).toBe("true");
    }, { timeout: 10_000, interval: 250 });

    const revisionBeforePreview = (await state(a)).revision;
    await selectTextClipViaUI(page(), "New Title");
    await previewNode(firstNodeId);

    const banner = page().getByTestId("version-preview-banner");
    await banner.waitFor({ timeout: 20_000 });
    await vi.waitFor(async () => {
      expect(await banner.innerText()).toContain("Previewing save point “First save point”");
    }, { timeout: 10_000, interval: 250 });

    // History content: the second clip does not exist in the first version.
    await vi.waitFor(async () => {
      expect(await timelineTextClip(page(), "Second Title").count()).toBe(0);
    }, { timeout: 15_000, interval: 250 });
    await timelineTextClip(page(), "New Title").waitFor({ timeout: 15_000 });

    // Delete key must not modify the previewed history (read-only hint).
    await page().keyboard.press("Delete");
    await waitForToast(L.previewReadOnly);
    await timelineTextClip(page(), "New Title").waitFor({ timeout: 10_000 });

    // A real drag gesture must not move anything either.
    await dragTextClipViaUI(page(), "New Title", 60);
    await timelineTextClip(page(), "New Title").waitFor({ timeout: 10_000 });

    // Ctrl+S in a preview only acknowledges; it must not save the previewed
    // content into the workspace and must not create a node.
    await page().keyboard.press("Control+s");
    await waitForToast(L.previewSavedToast);
    expect(await liveNodes(a.projectId)).toHaveLength(2);

    // Esc returns to current editing with content and revision intact.
    await page().keyboard.press("Escape");
    await banner.waitFor({ state: "detached", timeout: 15_000 });
    await timelineTextClip(page(), "Second Title").waitFor({ timeout: 15_000 });
    await timelineTextClip(page(), "New Title").waitFor({ timeout: 15_000 });
    expect((await state(a)).revision).toBe(revisionBeforePreview);
    expect(await liveNodes(a.projectId)).toHaveLength(2);
    record("C-preview", { firstNodeId, secondNodeId, revisionUnchanged: true });
  });

  /* ------------------------------------------------------------------ */
  /* (d) 交互验收 5 — adopt protects the dirty draft; undo restores       */
  /* ------------------------------------------------------------------ */
  test("continue editing from a version protects the dirty draft and the toast undo restores it", async () => {
    await ensureSubstantiveEdit(a, "Unsaved work", 6);
    const nodes = await liveNodes(a.projectId);
    const firstNodeId = nodes[0]!.id;
    const secondNodeId = nodes[1]!.id;

    await previewNode(firstNodeId);
    await page().getByTestId("version-preview-banner").waitFor({ timeout: 20_000 });
    await page().getByTestId("version-preview-adopt").click();

    // Adoption success toast carries the undo action and stays until used.
    await waitForToast(/Now editing "First save point"/);
    await vi.waitFor(async () => {
      expect(await timelineTextClip(page(), "Unsaved work").count()).toBe(0);
      expect(await timelineTextClip(page(), "Second Title").count()).toBe(0);
    }, { timeout: 20_000, interval: 250 });
    await timelineTextClip(page(), "New Title").waitFor({ timeout: 15_000 });

    // The forked-off later node is still on the track (原后续节点仍在).
    expect(await versionNode(secondNodeId).count()).toBe(1);

    // The pre-adoption edit survives as a recovery draft (找回之前的编辑).
    await openProjectMenu(activeProjectName);
    await page().getByRole("button", { name: L.recoverMenu, exact: true }).click();
    const draftsDialog = page().getByTestId("recovery-drafts-dialog");
    await draftsDialog.waitFor({ timeout: 10_000 });
    await vi.waitFor(async () => {
      expect(await page().getByTestId("recovery-draft-row").count()).toBeGreaterThan(0);
    }, { timeout: 15_000, interval: 250 });
    await page().getByTestId("recovery-drafts-cancel").click();

    // 撤回本次切换 restores the protected draft.
    await clickToastAction(L.adoptUndo);
    await timelineTextClip(page(), "Unsaved work").waitFor({ timeout: 20_000 });
    await timelineTextClip(page(), "Second Title").waitFor({ timeout: 20_000 });

    // Ctrl+S still only flushes the workspace — no node appears.
    await page().keyboard.press("Control+s");
    await waitForToast(L.savedToast);
    expect(await liveNodes(a.projectId)).toHaveLength(2);
    record("D-adopt-draft", { firstNodeId, secondNodeId, draftRestoredByUndo: true });
  });

  /* ------------------------------------------------------------------ */
  /* (e) 交互验收 7 — rename changes metadata only                        */
  /* ------------------------------------------------------------------ */
  test("rename edits display metadata only and keeps the node identity", async () => {
    const nodes = await liveNodes(a.projectId);
    const secondNodeId = nodes[1]!.id;
    await renameNodeViaMenu(secondNodeId, "My cut");

    const renamed = (await liveNodes(a.projectId)).find((node) => node.id === secondNodeId);
    expect(renamed?.name).toBe("My cut");
    // Node identity and parent links untouched by the rename.
    expect(renamed?.parentNodeId).toBe(nodes[1]!.parentNodeId);
    expect(await versionNode(secondNodeId).count()).toBe(1);
    record("E-rename", { nodeId: secondNodeId, name: "My cut" });
  });

  /* ------------------------------------------------------------------ */
  /* (f) 交互验收 6 — delete recycles; undo restores; endpoint appears    */
  /* ------------------------------------------------------------------ */
  test("delete moves the node to the recycle bin with undo; deleting the base shows the edit endpoint", async () => {
    const nodes = await liveNodes(a.projectId);
    const firstNodeId = nodes[0]!.id;
    const secondNodeId = nodes[1]!.id;

    await deleteNodeViaMenu(secondNodeId);
    await undoDeleteViaToast(secondNodeId);
    expect((await liveNodes(a.projectId)).find((node) => node.id === secondNodeId)?.name).toBe("My cut");

    // Deleting the current base node keeps the edit running and shows the
    // lightweight "current editing" endpoint instead of faking a version.
    // (d) undid the adoption, so the workspace is based on the later node.
    await deleteNodeViaMenu(secondNodeId);
    await page().getByTestId("current-edit-endpoint").waitFor({ timeout: 10_000 });
    expect(await versionNode(secondNodeId).count()).toBe(0);

    await undoDeleteViaToast(secondNodeId);
    expect(await page().getByTestId("current-edit-endpoint").count()).toBe(0);
    await vi.waitFor(async () => {
      expect(await versionNode(secondNodeId).getAttribute("data-base")).toBe("true");
    }, { timeout: 10_000, interval: 250 });
    expect(await liveNodes(a.projectId)).toHaveLength(2);
    record("F-delete-undo", { firstNodeId, secondNodeId, endpointWhileBaseDeleted: true });
  });

  /* ------------------------------------------------------------------ */
  /* (h) 交互验收 11 — project switch notification + Agent prompt copy    */
  /* ------------------------------------------------------------------ */
  test("project switch notifies once; the copied prompt carries ids and no token", async () => {
    const notificationsBeforeCreation = await toastRegion().getByText(L.switchToast).allTextContents();
    await createProjectViaSwitcher("Vertical", "Vertical");
    b = await currentIdentity();
    expect(b.projectId).not.toBe(a.projectId);
    // Creation must not add a switch notification. A previous switch's
    // eight-second hint may still exist, so compare the actual messages.
    const notificationsAfterCreation = await toastRegion().getByText(L.switchToast).allTextContents();
    record("H-creation-notifications", { before: notificationsBeforeCreation, after: notificationsAfterCreation });
    expect(notificationsAfterCreation.every(message => notificationsBeforeCreation.includes(message))).toBe(true);
    expect(await liveNodes(b.projectId)).toHaveLength(0);
    expect(await page().locator('[data-testid^="version-node-"]:visible').count()).toBe(0);

    // Switch back to A: exactly one clickable notification.
    await switchToProjectViaMenu("Horizontal", a.projectId);
    await waitForToast(/Switched to "Horizontal"/);
    expect(await toastRegion().getByText(L.switchToast).count()).toBe(1);

    // Copy from the notification: target ids, no credentials.
    await clickToastAction(L.copyAgentPrompt);
    await waitForToast("Agent prompt copied");
    let prompt = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(prompt).toContain(a.projectId);
    expect(prompt).toContain(a.workspaceId);
    expect(prompt).toContain("workspaceId:");
    // Check for credential-shaped content without reading the endpoint secret.
    expect(/\b[a-f0-9]{64}\b/i.test(prompt)).toBe(false);

    // The prompt is recoverable from the project menu after the toast fades.
    await openProjectMenu(activeProjectName);
    await page().getByRole("button", { name: L.copyAgentPrompt, exact: true }).click();
    await waitForToast("Agent prompt copied");
    prompt = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(prompt).toContain(a.projectId);

    // Consecutive switches replace the notification instead of stacking.
    await switchToProjectViaMenu("Vertical", b.projectId);
    await waitForToast(/Switched to "Vertical"/);
    expect(await toastRegion().getByText(L.switchToast).count()).toBe(1);

    // Preview isolation across switches: entering a node preview in A and
    // then switching to B drops the preview without leaking A's nodes.
    await switchToProjectViaMenu("Horizontal", a.projectId);
    const nodes = await liveNodes(a.projectId);
    await previewNode(nodes[0]!.id);
    await page().getByTestId("version-preview-banner").waitFor({ timeout: 20_000 });
    await switchToProjectViaMenu("Vertical", b.projectId);
    await vi.waitFor(async () => {
      expect(await page().getByTestId("version-preview-banner").count()).toBe(0);
      expect(await versionNode(nodes[0]!.id).isVisible()).toBe(false);
    }, { timeout: 15_000, interval: 250 });
    await switchToProjectViaMenu("Horizontal", a.projectId);
    expect(await page().getByTestId("version-preview-banner").count()).toBe(0);
    await timelineTextClip(page(), "Unsaved work").waitFor({ timeout: 15_000 });
    record("H-switch-prompt", { a: a.projectId, b: b.projectId, promptHasToken: false });
  });

  /* ------------------------------------------------------------------ */
  /* A09/A10/A13 port — immutable node media and fixed export input       */
  /* ------------------------------------------------------------------ */
  test("task media stays protected: immutable node media and a fixed-input export", async () => {
    const longPath = path.join(job, "generated", "long-source.mp4");
    execFileSync(ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-t", "12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", longPath,
    ], { windowsHide: true });
    const longMedia = await call("media.import", {
      ...b, path: longPath, expectedRevision: (await state(b)).revision, idempotencyKey: "accept-long-source",
    });
    await edit(b, [
      { op: "track.add", trackType: "video", trackId: "accept-long-track" },
      { op: "clip.add", trackId: "accept-long-track", mediaId: longMedia.mediaId, startTime: 0, duration: 12 },
    ]);
    const longClipId = ((await state(b)).project.timeline.tracks as any[])
      .find((track) => track.id === "accept-long-track").clips[0].id;
    const longNode = await call("node.save", {
      ...b, expectedRevision: (await state(b)).revision, name: "Long original retained",
      idempotencyKey: "accept-replay-save",
    });
    replaySaveArgs = {
      ...b, expectedRevision: longNode.revision, name: "Long original retained",
      idempotencyKey: "accept-replay-save",
    };
    replayNodeId = longNode.node.id;

    const segmentPath = path.join(job, "generated", "independent-selected.mp4");
    execFileSync(ffmpeg, [
      "-v", "error", "-ss", "3", "-i", longPath, "-t", "2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", segmentPath,
    ], { windowsHide: true });
    const segment = await call("media.import", {
      ...b, path: segmentPath, expectedRevision: (await state(b)).revision, idempotencyKey: "accept-independent-segment",
    });
    expect(segment.metadata.durationSec).toBeCloseTo(2, 1);
    await edit(b, [{
      op: "media.replace", mediaId: longMedia.mediaId,
      replacementMediaId: segment.mediaId, scope: "clip", clipId: longClipId,
    }]);
    const segmentNode = await call("node.save", {
      ...b, expectedRevision: (await state(b)).revision, name: "Independent selected segment",
      idempotencyKey: "accept-segment-save",
    });

    // The earlier node keeps its own immutable media; the new media is only
    // referenced by the later node.
    const longNodeMedia = await call("node.media", { projectId: b.projectId, nodeId: longNode.node.id });
    expect(longNodeMedia.media.find((item: any) => item.id === longMedia.mediaId).contentHash)
      .toMatch(/^[a-f0-9]{64}$/);
    const historicalRefs = await call("media.references", { projectId: b.projectId, mediaId: longMedia.mediaId });
    expect(historicalRefs.references.some((reference: any) =>
      reference.kind === "node" && reference.referenceId === longNode.node.id,
    )).toBe(true);
    record("A13-immutable-media", {
      longNode: longNode.node.id, segmentNode: segmentNode.node.id,
      longMediaId: longMedia.mediaId, segmentMediaId: segment.mediaId,
    });

    // Export pins its input to the submitted revision; later edits to the
    // project must not change the delivered artifact.
    const fixed = await state(b);
    const fixedDuration = Math.max(
      ...(fixed.project.timeline.tracks as any[]).flatMap((track) =>
        (track.clips as any[]).map((clip) => clip.startTime + clip.duration),
      ),
    );
    const destination = path.join(job, "output", "fixed-input.mp4");
    const started = await call("export.start", {
      ...b, expectedRevision: fixed.revision,
      settings: { width: 640, height: 360, frameRate: 30, videoBitrateKbps: 800 },
      destinationPath: destination, idempotencyKey: "accept-fixed-export",
    });
    exportJobId = started.jobId;
    exportPath = destination;

    // While the export runs: switch the GUI away, restore the earlier node
    // (rewriting the current workspace) — the export input stays fixed.
    await switchToProjectViaMenu("Horizontal", a.projectId);
    await call("node.restore", { ...b, nodeId: longNode.node.id, expectedRevision: (await state(b)).revision });

    let completed: any;
    await vi.waitFor(async () => {
      completed = await call("job.status", { jobId: started.jobId });
      expect(["done", "error", "cancelled"]).toContain(completed.state);
    }, { timeout: 240_000, interval: 1_000 });
    expect(completed.state, JSON.stringify(completed.error)).toBe("done");
    expect(completed.sourceRevision).toBe(fixed.revision);
    expect(realpathSync.native(completed.deliveredTo)).toBe(realpathSync.native(destination));
    expect(existsSync(destination)).toBe(true);
    expect((await currentIdentity()).projectId).toBe(a.projectId);
    const verified = await call("verify.artifact", {
      path: completed.deliveredTo,
      expect: {
        width: 640, height: 360, durationSec: fixedDuration, durationToleranceSec: 0.1,
        container: "mp4", videoCodec: "h264",
      },
    });
    record("A10-fixed-input-export", {
      jobId: started.jobId, sourceRevision: fixed.revision, fixedDuration, verified,
      visibleProjectUnchanged: true,
    });
  });

  /* ------------------------------------------------------------------ */
  /* (g1) 关闭偏好 ask — dialog cancels; direct close keeps no node       */
  /* ------------------------------------------------------------------ */
  test("close preference ask: dialog cancels, direct close saves without a node", async () => {
    // Make project A retention-worthy: substantive content differs from its
    // base version (media clip + fresh text edit).
    const pngPath = path.join(job, "source", "close-candidate.png");
    copyFileSync(path.join(DESKTOP_DIR, "build", "icon.png"), pngPath);
    const imported = await call("media.import", {
      ...a, path: pngPath, expectedRevision: (await state(a)).revision, idempotencyKey: "accept-close-media",
    });
    const project = (await state(a)).project;
    let trackId = (project.timeline.tracks as any[])[0]?.id;
    const ops: unknown[] = [];
    if (!trackId) {
      ops.push({ op: "track.add", trackType: "video", trackId: "accept-close-track" });
      trackId = "accept-close-track";
    }
    ops.push({ op: "clip.add", trackId, mediaId: imported.mediaId, startTime: 0, duration: 2 });
    await edit(a, ops);
    aNodesAtClose = (await liveNodes(a.projectId)).map((node) => node.id);

    const child = launched.app.process();
    await requestWindowClose();
    const dialog = page().getByTestId("close-retention-dialog");
    await dialog.waitFor({ timeout: 30_000 });
    // One dialog covers every project with retention-worthy changes and must
    // include the project that was just edited.
    await vi.waitFor(async () => {
      expect(await dialog.innerText()).toContain("Horizontal");
    }, { timeout: 10_000, interval: 250 });

    // Cancel keeps the window (and editing) open.
    await page().getByTestId("close-cancel-button").click();
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    await page().waitForTimeout(2_500);
    expect(hasProcessExited(child)).toBe(false);

    // 直接关闭: workspace saved, no version retained, app exits. The click
    // itself closes the window, so Playwright's click promise may reject when
    // the page is torn down mid-action — the process exit is the assertion.
    await requestWindowClose();
    await dialog.waitFor({ timeout: 30_000 });
    await page()
      .getByTestId("close-directly-button")
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await waitForProcessExit(child, 40_000);
    record("G1-ask-close-directly", { cancelledStayedOpen: true, nodesAtClose: aNodesAtClose });
  });

  /* ------------------------------------------------------------------ */
  /* (g2 + A11) auto preference via the dialog; restart recovery; replay  */
  /* ------------------------------------------------------------------ */
  test("close preference auto: dialog retention commits the preference; nodes and drafts survive restart", async () => {
    await relaunchAndOpen("Horizontal", a.projectId);

    // Restart recovery: identical node list, no close-time node invented.
    expect((await liveNodes(a.projectId)).map((node) => node.id)).toEqual(aNodesAtClose);

    // Durable idempotency: the pre-restart node.save replays unchanged.
    const replay = await call("node.save", replaySaveArgs!);
    expect(replay.replayed).toBe(true);
    expect(replay.node.id).toBe(replayNodeId);

    // Fresh retention-worthy change, then close: the ask dialog appears and
    // switching it to "automatically" retains + closes without further asks.
    await ensureSubstantiveEdit(a, "Close edit auto", 9);
    const child = launched.app.process();
    await requestWindowClose();
    const dialog = page().getByTestId("close-retention-dialog");
    await dialog.waitFor({ timeout: 30_000 });
    await page().getByTestId("close-pref-select").getByLabel(L.nextTimeClosing).selectOption("retain");
    await page().getByTestId("close-retain-button").click();
    await waitForProcessExit(child, 40_000);
  });

  test("close preference auto: the next close retains silently with no dialog", async () => {
    await relaunchAndOpen("Horizontal", a.projectId);
    const nodesBefore = await liveNodes(a.projectId);
    const persisted = await page().evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("openreel-settings") ?? "{}") as {
        state?: { closeRetention?: string };
      };
      return raw.state?.closeRetention;
    });
    expect(persisted).toBe("retain");
    // The dialog retention created exactly one auto-named node.
    expect(nodesBefore).toHaveLength(aNodesAtClose.length + 1);
    expect(nodesBefore.at(-1)!.name).toBeTruthy();

    await ensureSubstantiveEdit(a, "Close edit silent", 10);
    await closeWindowAndAwaitExit();
  });

  /* ------------------------------------------------------------------ */
  /* (g3) skip preference — no dialog, no node                            */
  /* ------------------------------------------------------------------ */
  test("close preference skip: settings pick, silent close, no node", async () => {
    await relaunchAndOpen("Horizontal", a.projectId);
    const nodesBefore = await liveNodes(a.projectId);
    expect(nodesBefore).toHaveLength(aNodesAtClose.length + 2);

    // Flip the preference in Settings (项目与保存 → 关闭时留存版本).
    await page().getByRole("button", { name: "Settings", exact: true }).click();
    const settingsDialog = page().getByRole("dialog", { name: "Settings" });
    await settingsDialog.waitFor({ timeout: 10_000 });
    await page().getByRole("radio", { name: L.settingsTab }).click();
    await page().getByLabel(L.closeRetentionLabel).selectOption("skip");
    await page().getByRole("button", { name: "Close dialog" }).click();
    await settingsDialog.waitFor({ state: "detached", timeout: 10_000 });

    await ensureSubstantiveEdit(a, "Close edit skipped", 11);
    // Skip: close runs the mandatory workspace save and exits without ever
    // asking and without creating a node.
    await closeWindowAndAwaitExit();
  });

  test("close preference skip: nothing was retained and the preference persisted", async () => {
    await relaunchAndOpen("Horizontal", a.projectId);
    const nodes = await liveNodes(a.projectId);
    expect(nodes).toHaveLength(aNodesAtClose.length + 2);
    const persisted = await page().evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("openreel-settings") ?? "{}") as {
        state?: { closeRetention?: string };
      };
      return raw.state?.closeRetention;
    });
    expect(persisted).toBe("skip");
    record("G-skip", { nodesAfterSkipClose: nodes.length, preference: persisted });
    writeFileSync(path.join(evidence, "export-pointer.json"), JSON.stringify({ exportJobId, exportPath }));
  });
});
