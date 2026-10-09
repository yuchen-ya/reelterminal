import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

test("a small timeline viewport reaches all twelve tracks with ordinary wheels and fixed ruler", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const launched = await launchApp({ runDir: job ? path.join(job, "work", `scroll-profile-${crypto.randomUUID()}`) : undefined, keepRunDir: true });
  const observations: Record<string, unknown> = {};
  let evidence: string | undefined;
  const call = (command: string, args: Record<string, unknown> = {}) => {
    const result = JSON.parse(execFileSync(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), "call", command, "--stdin"], {
      input: JSON.stringify({ arguments: args }), encoding: "utf8", windowsHide: true,
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile },
    }));
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value;
  };
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    const capabilities = call("capabilities.get");
    evidence = path.join(job ?? capabilities.mediaImport.recommendedRoot, "evidence", process.env.REELTERMINAL_SCROLL_BASELINE ? "scroll-before" : "scroll-after");
    mkdirSync(evidence, { recursive: true });
    const identity = call("editor.get_context").identity;
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    call("edit.apply", { ...target, expectedRevision: call("project.get_state", target).revision, idempotencyKey: "twelve-tracks", ops: Array.from({ length: 12 }, (_, index) => ({
      op: "track.add", trackType: ["video", "audio", "text", "graphics"][index % 4], trackId: `scroll-track-${index}`,
    })) });
    call("edit.apply", { ...target, expectedRevision: call("project.get_state", target).revision, idempotencyKey: "scroll-title", ops: [
      { op: "text.create", trackId: "scroll-track-2", text: "Scroll proof", startTime: 0, duration: 30 },
    ] });
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 720));
    const handle = launched.page.locator('[role="separator"][aria-orientation="horizontal"]');
    const rect = (await handle.boundingBox())!;
    await launched.page.mouse.move(rect.x + rect.width / 2, rect.y + 3);
    await launched.page.mouse.down();
    await launched.page.mouse.move(rect.x + rect.width / 2, rect.y + 180, { steps: 10 });
    await launched.page.mouse.up();
    const tracks = launched.page.getByTestId("timeline-tracks-scroll");
    const headers = launched.page.getByTestId("timeline-track-headers-scroll");
    const measure = () => tracks.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, bottom: element.getBoundingClientRect().bottom }));
    observations.beforeWheel = await measure();
    const rulerTop = (await launched.page.getByTestId("timeline-time-ruler").boundingBox())!.y;
    const box = (await tracks.boundingBox())!;
    await launched.page.mouse.move(box.x + 30, Math.min(box.y + 30, 680));
    await launched.page.mouse.wheel(0, 2000);
    await vi.waitFor(async () => expect((await measure()).scrollTop).toBeGreaterThan(0), { timeout: 5_000 });
    observations.afterWheel = await measure();
    expect((await measure()).bottom).toBeLessThanOrEqual(721);
    expect(await headers.evaluate((element) => element.scrollTop)).toBeCloseTo((await measure()).scrollTop, 0);
    const headerBox = (await headers.boundingBox())!;
    await launched.page.mouse.move(headerBox.x + 40, headerBox.y + 25);
    await launched.page.mouse.wheel(0, -2000);
    await vi.waitFor(async () => expect((await measure()).scrollTop).toBe(0));
    observations.headerWheelReturnsTop = true;
    expect((await launched.page.getByTestId("timeline-time-ruler").boundingBox())!.y).toBeCloseTo(rulerTop, 1);
    await launched.page.mouse.move(box.x + 30, box.y + 25);
    await launched.page.mouse.wheel(0, 128);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const clip = launched.page.getByRole("button", { name: "Select text clip Scroll proof", exact: true });
    const clipBox = (await clip.boundingBox())!;
    await launched.page.mouse.move(clipBox.x + 20, Math.max(box.y + 2, Math.min(clipBox.y + clipBox.height / 2, box.y + box.height - 5)));
    await launched.page.mouse.wheel(0, 2000);
    await vi.waitFor(async () => expect((await measure()).scrollTop).toBeGreaterThan(300));
    observations.clipWheelReachesBottom = true;
    const widthBeforeZoom = await tracks.evaluate((element) => element.scrollWidth);
    await launched.page.keyboard.down("Control");
    await launched.page.mouse.wheel(0, -100);
    await launched.page.keyboard.up("Control");
    await vi.waitFor(async () => expect(await tracks.evaluate((element) => element.scrollWidth)).toBeGreaterThan(widthBeforeZoom));
    const leftBefore = await tracks.evaluate((element) => element.scrollLeft);
    await launched.page.keyboard.down("Shift");
    await launched.page.mouse.wheel(0, 200);
    await launched.page.keyboard.up("Shift");
    await vi.waitFor(async () => expect(await tracks.evaluate((element) => element.scrollLeft)).toBeGreaterThan(leftBefore));
    observations.zoomAndHorizontalWheel = true;
    expect(call("editor.get_context").playheadSeconds).toBe(0);
    await launched.page.getByRole("button", { name: "Play", exact: true }).click();
    await vi.waitFor(() => expect(call("editor.get_context").playheadSeconds).toBeGreaterThan(0));
    await launched.page.getByRole("button", { name: "Pause", exact: true }).click();
    observations.playbackStillWorks = true;
  } finally {
    if (evidence) {
      observations.final = await launched.page.getByTestId("timeline-tracks-scroll").evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, bottom: element.getBoundingClientRect().bottom }));
      await launched.page.screenshot({ path: path.join(evidence, "timeline.png") });
      writeFileSync(path.join(evidence, "scroll.json"), JSON.stringify(observations, null, 2));
    }
    await launched.close({ keepRunDir: true });
  }
}, 120_000);
