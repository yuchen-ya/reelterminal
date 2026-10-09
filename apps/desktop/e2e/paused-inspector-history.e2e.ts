import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";
import { enableAgentSessionViaUI } from "./harness/ui";

test("copied acceptance project keeps paused pixels through inspector actions and renders real history", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const runDir = process.env.REELTERMINAL_RECHECK_CLONE_DIR;
  const projectId = process.env.REELTERMINAL_RECHECK_PROJECT_ID;
  if (!job || !runDir || !projectId) throw new Error("Set an external job, copied acceptance profile and project id");
  const evidence = path.join(job, "evidence", process.env.REELTERMINAL_INSPECTOR_BASELINE ? "paused-inspector-before" : "paused-inspector-after");
  mkdirSync(evidence, { recursive: true });
  const launched = await launchApp({ runDir, keepRunDir: true });
  const observations: Record<string, unknown> = {};
  const call = (command: string, args: Record<string, unknown> = {}) => {
    let result = JSON.parse(execFileSync(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), "call", command, "--stdin", "--output-file", path.join(evidence, `${command}-${crypto.randomUUID()}.json`),
      ...(typeof args.projectId === "string" ? ["--project-id", args.projectId] : []),
      ...(typeof args.workspaceId === "string" ? ["--workspace-id", args.workspaceId] : []),
    ], {
      input: JSON.stringify({ arguments: args }), encoding: "utf8", windowsHide: true,
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile },
    }));
    if (result.ok && result.value.savedTo) result = JSON.parse(readFileSync(result.value.savedTo, "utf8"));
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value;
  };
  const measure = (selector = '[data-testid="preview-canvas"]') => launched.page.locator(selector).first().evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * 0.4), Math.floor(canvas.height * 0.2), Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.3)).data;
    let sum = 0;
    for (let index = 0; index < pixels.length; index++) if (index % 4 !== 3) sum += pixels[index]!;
    return { mean: sum / (pixels.length / 4 * 3), width: canvas.width, height: canvas.height };
  });
  const pausedPicture = async (stage: string) => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    observations[stage] = { playhead: call("editor.get_context").playheadSeconds, frame: await measure() };
    await launched.page.screenshot({ path: path.join(evidence, `${stage}.png`) });
    expect((await measure()).mean).toBeGreaterThan(20);
    expect(await launched.page.getByRole("button", { name: "Play", exact: true }).isVisible()).toBe(true);
  };
  try {
    await launched.waitForEndpointFile();
    call("capabilities.get");
    const project = call("project.list").projects.find((entry: any) => entry.id === projectId);
    expect(project).toBeDefined();
    await launched.page.screenshot({ path: path.join(evidence, "copied-profile-start.png") });
    await launched.page.getByRole("button", { name: `Open ${project.name}`, exact: true }).click();
    await launched.page.getByTestId("preview-canvas").waitFor();
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    const identity = call("editor.get_context").identity;
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const state = call("project.get_state", target);
    expect(state.project.mediaLibrary.items.length).toBeGreaterThan(0);
    const points = call("node.list", { projectId: target.projectId }).nodes;
    const trial = points.find((node: any) => node.sourceWorkspaceKind === "trial");
    const ordinary = points.find((node: any) => !node.sourceWorkspaceKind);
    expect(trial).toBeDefined();
    expect(ordinary).toBeDefined();
    call("editor.control", { ...target, action: "seek", timeSeconds: 6.8 });
    await launched.page.getByRole("button", { name: "Play", exact: true }).click();
    await vi.waitFor(() => expect(call("editor.get_context").playheadSeconds).toBeGreaterThanOrEqual(7.27), { timeout: 10_000 });
    await launched.page.getByRole("button", { name: "Pause", exact: true }).click();
    const pausedTime = call("editor.get_context").playheadSeconds;
    observations.pausedTime = pausedTime;
    await vi.waitFor(async () => expect((await measure()).mean).toBeGreaterThan(20), { timeout: 15_000 });
    observations.target = target;
    await pausedPicture("initial-paused");
    await launched.page.getByTestId("current-archive-entry").press("Enter");
    await pausedPicture("archives-open");
    await launched.page.getByTestId(`version-node-${trial.id}`).click({ button: "right" });
    await pausedPicture("trial-context-menu");
    await launched.page.keyboard.press("Escape");
    await launched.page.getByRole("button", { name: "Rename project", exact: true }).press("Enter");
    await pausedPicture("project-rename-open");
    await launched.page.getByRole("textbox", { name: "Project name", exact: true }).press("Escape");
    await launched.page.getByTestId(`version-node-${ordinary.id}`).click({ button: "right" });
    await launched.page.getByTestId("version-menu-rename").click();
    expect(await launched.page.getByTestId("version-rename-input").inputValue()).toBe(ordinary.name);
    await launched.page.getByTestId(`version-node-${trial.id}`).click({ button: "right" });
    observations.staleRenameCount = await launched.page.getByTestId("version-rename-input").count();
    if (!process.env.REELTERMINAL_INSPECTOR_BASELINE) expect(observations.staleRenameCount).toBe(0);
    await launched.page.getByTestId("version-menu-preview").click();
    await launched.page.getByTestId("version-preview-banner").waitFor();
    await vi.waitFor(async () => expect((await measure()).mean).toBeGreaterThan(20), { timeout: 15_000 });
    await launched.page.getByTestId("version-preview-return").click();
    await launched.page.getByTestId(`version-node-${trial.id}`).click();
    await launched.page.getByRole("button", { name: "Compare with current edit", exact: true }).click();
    await launched.page.getByTestId("reference-comparison-viewport").waitFor();
    call("editor.control", { ...target, action: "seek", timeSeconds: 0.5 });
    const historySelector = '[data-testid="comparison-surfaces"] canvas';
    await vi.waitFor(async () => expect((await measure(historySelector)).mean).toBeGreaterThan(20), { timeout: 15_000 });
    observations.historyAtStart = await measure(historySelector);
    await vi.waitFor(async () => expect(Math.abs((await measure()).mean - (await measure(historySelector)).mean)).toBeLessThan(10), { timeout: 15_000 });
    observations.currentAtStart = await measure();
    await launched.page.screenshot({ path: path.join(evidence, "real-history-compare-start.png") });
    expect(call("editor.get_context").playheadSeconds).toBe(0.5);
  } finally {
    try {
      if (await launched.page.getByTestId("preview-canvas").count()) observations.finalFrame = await measure();
      await launched.page.screenshot({ path: path.join(evidence, "final.png") });
      writeFileSync(path.join(evidence, "paused-inspector.json"), JSON.stringify(observations, null, 2));
    } finally {
      await launched.close({ keepRunDir: true });
    }
  }
}, 180_000);
