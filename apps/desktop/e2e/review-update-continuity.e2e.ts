import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";
import { createRepairAcceptanceFixture, decodeRgbaPng } from "./harness/repair-acceptance-fixtures";

// The gate changes browser decode timing only. All resources and versions are
// produced by fresh reelctl processes against this test's isolated Electron.
async function installDecodeGate(page: Page) {
  await page.evaluate(() => {
    const nativeDecode = HTMLImageElement.prototype.decode;
    const gate = { hold: false, rejectNext: false, decodes: 0, waiting: [] as Array<{ url: string; release: () => void }> };
    Object.assign(window, { reviewDecodeGate: gate });
    HTMLImageElement.prototype.decode = async function () {
      await nativeDecode.call(this);
      if (this.dataset.testid !== "image-stage-pending-image") return;
      gate.decodes++;
      if (!gate.hold) return;
      if (gate.rejectNext) { gate.rejectNext = false; throw new DOMException("Synthetic decode failure", "EncodingError"); }
      await new Promise<void>(release => gate.waiting.push({ url: this.src, release }));
    };
  });
}

test("CLI image revisions retain decoded pixels, view state and explicit failure through bounded updates", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const page = launched.page;
  const baseline = process.env.REELTERMINAL_CONTINUITY_BASELINE === "1";
  const evidence = createEvidence(baseline ? "review-continuity-baseline" : "review-continuity-fixed", page);
  const calls: Array<{ name: string; ok: boolean }> = [];
  const call = async <T = unknown>(name: string, args: Record<string, unknown> = {}) => {
    const reply = await agent.callCommand<T>(name, args);
    calls.push({ name, ok: reply.ok });
    return reply;
  };
  try {
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Image continuity isolated acceptance");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await call<ReviewContext>("review.context"));
    const node = value(await call<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    const target = { ...context.target, nodeId: node.id };
    await page.evaluate(() => {
      const state = window as unknown as { reviewObservedEvents: unknown[]; reviewObservedUiStates: string[] };
      state.reviewObservedEvents = [];
      state.reviewObservedUiStates = [];
      window.reelterminal!.liveEvents!.onEvent(event => {
        if (event.type === "action") state.reviewObservedEvents.push(event);
      });
      new MutationObserver(() => {
        const text = `${document.querySelector('[data-testid="review-command-current"]')?.textContent}|${document.querySelector('[data-testid="review-command-current-status"]')?.textContent}`;
        if (state.reviewObservedUiStates.at(-1) !== text) state.reviewObservedUiStates.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "continuity-fixture"));
    const itemId = randomUUID();
    const secondId = randomUUID();
    const sourceId = randomUUID();
    const secondMediaId = randomUUID();
    const videoId = randomUUID();
    const videoMediaId = randomUUID();
    const videoPath = path.join(launched.runDir, "continuity-video.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=256x192:r=12:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", videoPath], { windowsHide: true });
    value(await call("review.ingest", { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "Two synthetic images",
      files: [{ resourceId: sourceId, sourcePath: fixture.damagedPath, mime: "image/png" }, { resourceId: secondMediaId, sourcePath: fixture.cleanPath, mime: "image/png" },
        { resourceId: videoMediaId, sourcePath: videoPath, mime: "video/mp4" }],
      items: [{ id: itemId, title: "Continuity house", type: "image", content: { type: "image", mediaId: sourceId, naturalWidth: fixture.width, naturalHeight: fixture.height } },
        { id: secondId, title: "Clean second item", type: "image", content: { type: "image", mediaId: secondMediaId, naturalWidth: fixture.width, naturalHeight: fixture.height } },
        { id: videoId, title: "Synthetic capture source", type: "video", content: { type: "video", mediaId: videoMediaId } }] }));
    await page.getByTestId("workbench-tree-panel").getByText("Continuity house", { exact: true }).click();
    const image = () => page.locator('[data-testid="image-stage"] > img').first();
    await vi.waitFor(async () => expect(await image().evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(fixture.width));
    await page.getByTestId("image-mode-navigate").click();
    await page.getByTestId("image-toolbar").getByRole("button", { name: "放大 (支持滚轮缩放)", exact: true }).click();
    const surface = page.getByTestId("image-stage-pointer-surface");
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2 + 12, { steps: 3 });
    await page.mouse.up();
    await surface.focus();
    await page.mouse.move(10, 90);
    const oldUrl = await image().getAttribute("src");
    const transform = await page.getByTestId("image-stage").getAttribute("style");
    const imageBox = (await image().boundingBox())!;
    const clip = { x: Math.ceil(imageBox.x + imageBox.width * 0.3), y: Math.ceil(imageBox.y + imageBox.height * 0.3), width: Math.floor(imageBox.width * 0.4), height: Math.floor(imageBox.height * 0.4) };
    const beforeFile = evidence.writePng("before-image-region", await page.screenshot({ clip }));
    const beforePixels = decodeRgbaPng(beforeFile).pixels;
    await installDecodeGate(page);
    await page.evaluate(() => {
      const state = window as unknown as { reviewDecodeGate: { hold: boolean }; continuityFrames: unknown[]; continuitySampling: boolean };
      state.reviewDecodeGate.hold = true;
      state.continuityFrames = [];
      state.continuitySampling = true;
      const sample = () => {
        const image = document.querySelector('[data-testid="image-stage"] > img') as HTMLImageElement | null;
        const rect = image?.getBoundingClientRect();
        state.continuityFrames.push({ time: performance.now(), url: image?.src, width: rect?.width ?? 0, height: rect?.height ?? 0, opacity: image ? getComputedStyle(image).opacity : null });
        if (state.continuitySampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const read = async () => value(await call<{ item: WorkbenchItem; node: ReviewNode }>("review.get", { target, itemId }));
    const apply = async (color: string) => {
      const current = await read();
      const request = { target, expectedNodeRevision: current.node.revision, itemId, expectedItemVersion: current.item.version, requestId: randomUUID(),
        region: { space: "source-pixels", x: 0, y: 0, width: fixture.width, height: fixture.height },
        operations: [{ kind: "brush", color, size: 18, points: [{ x: 126, y: 90, pressure: 1 }] }] };
      value(await call("review.repair.apply", request));
      return { request, item: (await read()).item };
    };
    const first = await apply("#ff2040");
    if (baseline) {
      await evidence.screenshot("after-first-cli-update");
      const frames = await page.evaluate(() => {
        const state = window as unknown as { continuitySampling: boolean; continuityFrames: unknown[] };
        state.continuitySampling = false;
        return state.continuityFrames;
      });
      evidence.record("frames", frames);
      evidence.record("blankFrames", frames.filter(frame => (frame as { width: number }).width < 10));
      // Baseline records the actual pre-fix disappearance without imposing the new decode contract.
      expect(frames.some(frame => (frame as { width: number }).width < 10)).toBe(true);
      return;
    }
    await vi.waitFor(async () => expect(await page.getByTestId("image-stage-pending-image").count()).toBe(1));
    await vi.waitFor(async () => expect(await page.evaluate(() => (window as unknown as { reviewDecodeGate: { waiting: unknown[] } }).reviewDecodeGate.waiting.length)).toBe(1));
    for (let index = 0; index < 4; index++) {
      const file = evidence.writePng(`pending-frame-${index}`, await page.screenshot({ clip }));
      expect(decodeRgbaPng(file).pixels.equals(beforePixels), `pending frame ${index} must retain exact old image pixels`).toBe(true);
      expect(await image().getAttribute("src")).toBe(oldUrl);
      expect(await surface.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await page.getByTestId("image-stage").getAttribute("style")).toBe(transform);
    }
    const pendingBox = (await surface.boundingBox())!;
    const pointer = { x: pendingBox.x + pendingBox.width / 2, y: pendingBox.y + pendingBox.height / 2 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.move(pointer.x + 12, pointer.y + 6, { steps: 2 });
    await page.mouse.up();
    expect(await page.getByTestId("image-stage").getAttribute("style")).not.toBe(transform);
    await page.mouse.down();
    await page.mouse.move(pointer.x, pointer.y, { steps: 2 });
    await page.mouse.up();
    expect(await page.getByTestId("image-stage").getAttribute("style")).toBe(transform);
    await page.mouse.wheel(0, 100);
    await vi.waitFor(async () => expect(await page.getByTestId("image-stage").getAttribute("style")).not.toBe(transform));
    await page.mouse.wheel(0, -100);
    await vi.waitFor(async () => expect(await page.getByTestId("image-stage").getAttribute("style")).toBe(transform));
    expect(await surface.evaluate(element => element === document.activeElement)).toBe(true);
    await page.mouse.move(10, 90);
    await evidence.screenshot("delayed-first-update");
    await page.evaluate(() => (window as unknown as { reviewDecodeGate: { waiting: Array<{ release: () => void }> } }).reviewDecodeGate.waiting.shift()!.release());
    const firstRepairId = first.item.revisions.at(-1)!.mediaId;
    await vi.waitFor(async () => expect(await image().getAttribute("src")).toContain(firstRepairId));
    expect(await page.getByTestId("image-stage").getAttribute("style")).toBe(transform);
    const afterFile = evidence.writePng("after-image-region", await page.screenshot({ clip }));
    expect(decodeRgbaPng(afterFile).pixels.equals(beforePixels)).toBe(false);
    const second = await apply("#2040ff");
    await vi.waitFor(async () => expect(await page.evaluate(() => (window as unknown as { reviewDecodeGate: { waiting: unknown[] } }).reviewDecodeGate.waiting.length)).toBe(1));
    const third = await apply("#20ff40");
    await vi.waitFor(async () => expect(await page.evaluate(() => (window as unknown as { reviewDecodeGate: { waiting: unknown[] } }).reviewDecodeGate.waiting.length)).toBe(2));
    await page.evaluate(() => (window as unknown as { reviewDecodeGate: { waiting: Array<{ release: () => void }> } }).reviewDecodeGate.waiting.pop()!.release());
    await vi.waitFor(async () => expect(await image().getAttribute("src")).toContain(third.item.revisions.at(-1)!.mediaId));
    await page.evaluate(() => (window as unknown as { reviewDecodeGate: { waiting: Array<{ release: () => void }> } }).reviewDecodeGate.waiting.shift()!.release());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await image().getAttribute("src")).toContain(third.item.revisions.at(-1)!.mediaId);
    await page.evaluate(() => { (window as unknown as { reviewDecodeGate: { hold: boolean } }).reviewDecodeGate.hold = false; });
    await page.getByTestId("image-display-original").click();
    await vi.waitFor(async () => expect(await image().getAttribute("src")).toContain(sourceId));
    const fourth = await apply("#ffcc20");
    expect(await image().getAttribute("data-display-mode")).toBe("original");
    expect(await image().getAttribute("src")).toContain(sourceId);
    await page.evaluate(() => {
      const gate = (window as unknown as { reviewDecodeGate: { hold: boolean; rejectNext: boolean } }).reviewDecodeGate;
      gate.hold = true; gate.rejectNext = true;
    });
    await page.getByTestId("image-display-repaired").click();
    await vi.waitFor(async () => expect(await page.getByTestId("image-update-status").textContent()).toMatch(/失败|不可用|未载入/));
    expect(await image().getAttribute("src")).toContain(sourceId);
    await evidence.screenshot("failed-new-image-explicit");
    const sameItemFrames = await page.evaluate(() => (window as unknown as { continuityFrames: Array<{ width: number; height: number; opacity: string }> }).continuityFrames.slice());
    expect(sameItemFrames.length).toBeGreaterThan(10);
    expect(sameItemFrames.filter(frame => frame.width < 10 || frame.height < 10 || frame.opacity !== "1")).toEqual([]);
    evidence.record("sameItemFrames", sameItemFrames);
    expect(value(await call<{ replayed: boolean }>("review.repair.apply", fourth.request)).replayed).toBe(true);
    expect((await read()).item.version).toBe(5);
    const failure = await call("review.repair.apply", { ...fourth.request, requestId: randomUUID() });
    expect(failure.ok).toBe(false);
    expect(failure.error?.code).toBe("CONFLICT");
    await page.evaluate(() => { (window as unknown as { reviewDecodeGate: { hold: boolean } }).reviewDecodeGate.hold = false; });
    await page.getByTestId("workbench-tree-panel").getByText("Clean second item", { exact: true }).click();
    await vi.waitFor(async () => expect(await image().getAttribute("src")).toContain(secondMediaId));
    expect(await page.getByTestId("image-stage-pending-image").count()).toBe(0);
    await page.getByTestId("workbench-tree-panel").getByText("Continuity house", { exact: true }).click();
    await vi.waitFor(async () => expect(await image().getAttribute("src")).toContain(fourth.item.revisions.at(-1)!.mediaId));
    expect(await image().getAttribute("src")).not.toContain(second.item.revisions.at(-1)!.mediaId);
    await evidence.screenshot("final-restored-image");
    const current = await read();
    value(await call("review.repair.inspect", { target, itemId, expectedNodeRevision: current.node.revision, expectedItemVersion: current.item.version,
      region: { space: "source-pixels", x: 110, y: 70, width: 32, height: 32 } }));
    const activity = page.getByTestId("review-command-activity");
    expect(await activity.getAttribute("open")).toBeNull();
    expect(await page.getByTestId("review-command-current").textContent()).toBe("review.repair.inspect");
    expect(await page.getByTestId("review-command-current-status").textContent()).toContain("成功");
    const decodeCount = await page.evaluate(() => (window as unknown as { reviewDecodeGate: { decodes: number } }).reviewDecodeGate.decodes);
    await page.getByTestId("review-command-toggle").click();
    const applyEntries = page.getByTestId("review-command-entry").filter({ has: page.locator('code', { hasText: "review.repair.apply" }) });
    expect(await applyEntries.count()).toBe(6);
    expect(await applyEntries.filter({ hasText: "复用回执" }).count()).toBe(1);
    const failedEntry = page.locator('[data-testid="review-command-entry"][data-verb="review.repair.apply"][data-state="failed"]');
    await failedEntry.locator("summary").click();
    expect(await failedEntry.textContent()).toMatch(/CONFLICT|版本|revision/i);
    expect(await failedEntry.getByTestId("review-command-arguments").textContent()).toContain(itemId);
    await evidence.screenshot("actual-cli-error-expanded");
    const successEntry = page.locator('[data-testid="review-command-entry"][data-verb="review.repair.apply"][data-state="success"]').last();
    expect(await successEntry.getAttribute("open")).toBeNull();
    await successEntry.locator("summary").click();
    expect(await successEntry.getByTestId("review-command-arguments").textContent()).toContain(target.nodeId);
    await evidence.screenshot("actual-cli-activity-expanded");
    expect(await page.evaluate(() => (window as unknown as { reviewDecodeGate: { decodes: number } }).reviewDecodeGate.decodes)).toBe(decodeCount);
    const beforeCapture = await read();
    value(await call("review.frames.capture", { target, expectedNodeRevision: beforeCapture.node.revision, requestId: randomUUID(), itemId: videoId, expectedItemVersion: 1, frameIndex: 2 }));
    await vi.waitFor(async () => expect(await page.locator('[data-testid="review-command-entry"][data-verb="review.frames.capture"][data-state="success"]').count()).toBe(1));
    await evidence.screenshot("actual-capture-command");
    const newContext = value(await call<ReviewContext>("review.context"));
    const empty = value(await call<ReviewNode>("review.nodes.create", { target: newContext.target, expectedWorkspaceRevision: newContext.revision, requestId: randomUUID(), name: "Empty command isolation target" }));
    await page.getByTestId("review-node-list").getByText(empty.name, { exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-command-current").count()).toBe(0));
    expect(await page.getByTestId("review-command-entry").count()).toBe(0);
    expect(await page.getByTestId("image-stage-image").count()).toBe(0);
    await page.getByTestId("review-node-list").getByText(node.name, { exact: true }).click();
    await vi.waitFor(async () => expect(await page.locator('[data-testid="review-command-entry"][data-verb="review.repair.apply"]').count()).toBe(6));
    const observedEvents = await page.evaluate(() => (window as unknown as { reviewObservedEvents: Array<{ verb: string; phase: string; callId?: string }> }).reviewObservedEvents);
    const applyEvents = observedEvents.filter(event => event.verb === "review.repair.apply");
    expect(applyEvents.filter(event => event.phase === "start")).toHaveLength(6);
    expect(applyEvents.filter(event => event.phase === "end")).toHaveLength(6);
    expect(new Set(applyEvents.map(event => event.callId)).size).toBe(6);
    evidence.record("actualActionEvents", observedEvents);
    const uiStates = await page.evaluate(() => (window as unknown as { reviewObservedUiStates: string[] }).reviewObservedUiStates);
    expect(uiStates.some(text => text.includes("review.repair.apply|运行中"))).toBe(true);
    expect(uiStates.some(text => text.includes("review.repair.apply|成功"))).toBe(true);
    expect(uiStates.some(text => text.includes("review.repair.apply|失败"))).toBe(true);
    evidence.record("actualUiCommandStates", uiStates);
    const frames = await page.evaluate(() => {
      const state = window as unknown as { continuitySampling: boolean; continuityFrames: unknown[] };
      state.continuitySampling = false;
      return state.continuityFrames;
    });
    evidence.record("frames", frames);
    evidence.record("versions", [first.item.version, second.item.version, third.item.version, fourth.item.version]);
  } finally {
    evidence.flush({ calls, console: launched.output.rendererConsole });
    await agent.close();
    await launched.close();
  }
}, 180_000);
