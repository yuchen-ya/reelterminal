import { value } from "./harness/cli-client";
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright-core";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchHandoff, WorkbenchItem, WorkbenchVideoContent } from "@reelterminal/core/types/workbench";
import { launchApp } from "./harness/launch";
import { connectExternalAgent } from "./harness/cli-client";
import { createReviewVideoFixtures, VIDEO_SAMPLE_POINTS, type ReviewVideoFixture } from "./harness/review-video-fixtures";
import { ARTIFACTS_DIR } from "./harness/paths";
import { evidenceJsonReplacer } from "./harness/evidence";


async function readFrame(video: Locator) {
  return video.evaluate((element: HTMLVideoElement, points) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth; canvas.height = element.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(element, 0, 0);
    const signature = points.flatMap(([x, y]) => [...context.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data].slice(0, 3));
    return { currentTime: element.currentTime, duration: element.duration, width: element.videoWidth, height: element.videoHeight, signature,
      mediaTime: (element as HTMLVideoElement & { a7MediaTime?: number }).a7MediaTime };
  }, VIDEO_SAMPLE_POINTS);
}

function matchFrame(fixture: ReviewVideoFixture, signature: number[]) {
  const errors = fixture.signatures.map(expected => expected.reduce((sum, channel, index) => sum + Math.abs(channel - signature[index]), 0) / expected.length);
  const index = errors.indexOf(Math.min(...errors));
  expect(errors[index], `${fixture.name}: browser RGB differs from decoded FFmpeg frames`).toBeLessThan(5);
  return index;
}

test("A7 actual VFR, rotation and nonzero container start: GUI anchors, versions, reopen and mapped comparisons", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  const evidence: Record<string, unknown> = { clockContract: "Stored startPtsSec is browser currentTime, not an assumed zero-based container PTS. This offset MP4 retains its 5-second empty edit in Chromium: first playable currentTime=5, presented frame mediaTime=5, container PTS=5. The sampled displayed frame is independently matched against FFmpeg RGB, and its source PTS comes from ffprobe. Spatial coordinates use the autorotated displayed picture. No frame index is inferred." };
  const evidencePath = path.join(ARTIFACTS_DIR, "review-video-a7.json");
  try {
    let page = launched.page;
    evidence.runtime = await launched.app.evaluate(({ app }) => ({ appVersion: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome }));
    evidence.executable = process.env.REELTERMINAL_E2E_APP_EXECUTABLE ?? "development build";
    const fixtures = createReviewVideoFixtures(launched.runDir);
    evidence.fixtures = fixtures;
    const deltas = fixtures[0].probe.frames.slice(1).map((frame, index) => Number(frame.best_effort_timestamp_time) - Number(fixtures[0].probe.frames[index].best_effort_timestamp_time));
    expect(new Set(deltas.map(delta => delta.toFixed(3))).size).toBeGreaterThan(3);
    expect(Number(fixtures[2].probe.streams[0].start_time)).toBe(5);
    expect(fixtures[1].probe.streams[0].side_data_list?.some(data => Math.abs(data.rotation ?? 0) === 90)).toBe(true);
    await page.getByRole("tab", { name: /Review Workspace/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("Task name").fill("A7 decoded video acceptance");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    let target = { ...context.target, nodeId: node.id };
    const items = fixtures.map(fixture => ({ fixture, id: randomUUID(), resourceId: randomUUID() }));
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "A7 real media",
      files: items.map(({ fixture, resourceId }) => ({ resourceId, sourcePath: fixture.file, mime: "video/mp4" })),
      items: items.map(({ fixture, id, resourceId }) => ({ id, title: fixture.name, type: "video", content: { type: "video", mediaId: resourceId, durationSec: Number(fixture.probe.streams[0].duration), resolution: `${fixture.width}x${fixture.height}` } })) }));
    const readItem = async (id: string) => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId: id })).item;
    const select = async (title: string) => page.getByTestId("workbench-tree-panel").getByText(title, { exact: true }).click();
    const player = () => page.locator("[data-workbench-player='true'] video");
    const attachFrameObserver = async (video: Locator) => {
      await vi.waitFor(async () => expect(await video.evaluate((el: HTMLVideoElement) => el.readyState >= 2 && el.videoWidth > 0)).toBe(true), { timeout: 20_000 });
      await video.evaluate((el: HTMLVideoElement) => {
        const record = (_: number, metadata: VideoFrameCallbackMetadata) => {
          (el as HTMLVideoElement & { a7MediaTime?: number }).a7MediaTime = metadata.mediaTime;
          if (el.isConnected) el.requestVideoFrameCallback(record);
        };
        el.requestVideoFrameCallback(record);
      });
    };
    const seek = async (seconds: number) => {
      const duration = await player().evaluate((el: HTMLVideoElement) => el.duration);
      const box = (await page.locator("[title='点击/拖动跳转播放位置']").boundingBox())!;
      await page.mouse.click(box.x + box.width * seconds / duration, box.y + box.height / 2);
      await vi.waitFor(async () => {
        expect(await player().evaluate((el: HTMLVideoElement) => el.seeking)).toBe(false);
        expect((await readFrame(player())).currentTime).toBeCloseTo(seconds, 2);
      });
    };
    const retained: WorkbenchItem[] = [];
    const observations = [];
    for (const { fixture, id } of items.slice(0, 3)) {
      const inspectedNode = value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node;
      const inspected = value(await agent.callCommand<{ resource: { metadata: { width: number; height: number } } }>("review.media.inspect", { target,
        expectedNodeRevision: inspectedNode.revision, reference: { nodeId: node.id, itemId: id, version: 1, role: "source" } }));
      expect(inspected.resource.metadata.width).toBe(fixture.width); expect(inspected.resource.metadata.height).toBe(fixture.height);
      await select(fixture.name);
      await attachFrameObserver(player());
      expect(await page.locator("[data-workbench-player='true']").textContent()).toContain("帧索引不可用(无解码映射)");
      // Exercise the actual GUI play/pause controls before seeking and marking.
      await page.locator("button:has(svg.lucide-play)").click();
      await vi.waitFor(async () => expect((await readFrame(player())).currentTime).toBeGreaterThan(0.1));
      await page.locator("button:has(svg.lucide-pause)").click();
      const samples = [];
      const firstPts = Number(fixture.probe.frames[0].best_effort_timestamp_time);
      const markerTime = firstPts + 2.65;
      for (const offset of [0.67, 1.53, 2.65]) {
        const seconds = firstPts + offset;
        await seek(seconds);
        let frame: Awaited<ReturnType<typeof readFrame>>;
        const expectedIndex = fixture.probe.frames.findLastIndex(entry => Number(entry.best_effort_timestamp_time) <= seconds + 0.001);
        await vi.waitFor(async () => {
          frame = await readFrame(player());
          expect(matchFrame(fixture, frame.signature)).toBe(expectedIndex);
          expect(frame.mediaTime).toBeCloseTo(Number(fixture.probe.frames[expectedIndex].best_effort_timestamp_time), 3);
        }, { timeout: 15_000 });
        expect(frame!.width).toBe(fixture.width); expect(frame!.height).toBe(fixture.height);
        samples.push({ expectedContainerPts: fixture.probe.frames[expectedIndex].best_effort_timestamp_time, expectedIndex, browser: frame! });
      }
      await page.getByRole("button", { name: /标问题帧/ }).click();
      const panel = page.getByTestId("workbench-issue-panel");
      await panel.getByTestId("workbench-issue-card").first().waitFor();
      await panel.getByTestId("workbench-issue-card").first().click();
      await panel.getByLabel("问题建议").fill(`${fixture.name}: browser ${markerTime.toFixed(3)} seconds`);
      await panel.getByTestId("workbench-issue-save").click();
      await vi.waitFor(async () => expect(((await readItem(id)).content as WorkbenchVideoContent).markers[0].note).toContain(`browser ${markerTime.toFixed(3)}`), { timeout: 15_000 });
      await panel.getByTestId("workbench-issue-card").first().click();
      await vi.waitFor(async () => expect((await readFrame(player())).currentTime).toBeCloseTo(markerTime, 2));
      // Browser SVG matrix supplies screen coordinates independently of the product's pointer normalization math.
      const points = await player().evaluate((video, dimension) => {
        const svg = video.parentElement!.querySelector("svg")!;
        const matrix = svg.getScreenCTM()!;
        return [[0.25, 0.4], [0.45, 0.6]].map(([x, y]) => { const point = new DOMPoint(x * dimension.width, y * dimension.height).matrixTransform(matrix); return { x: point.x, y: point.y }; });
      }, { width: fixture.width, height: fixture.height });
      await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 8 }); await page.mouse.up();
      await vi.waitFor(async () => expect(((await readItem(id)).content as WorkbenchVideoContent).markers[0].annotations).toHaveLength(1));
      const item = await readItem(id);
      const marker = (item.content as WorkbenchVideoContent).markers[0];
      expect(marker.version).toBe(1); expect(marker.startFrameIndex).toBeUndefined();
      expect(marker.startPtsSec).toBeCloseTo(markerTime, 2);
      const annotation = marker.annotations[0];
      expect(annotation.x).toBeCloseTo(0.25, 2); expect(annotation.y).toBeCloseTo(0.4, 2);
      expect(annotation.w).toBeCloseTo(0.2, 2); expect(annotation.h).toBeCloseTo(0.2, 2);
      expect(annotation.ptsSec).toBe(marker.startPtsSec);
      await seek(firstPts + 0.35);
      await panel.getByTestId("workbench-issue-card").first().click();
      await vi.waitFor(async () => expect((await readFrame(player())).currentTime).toBeCloseTo(marker.startPtsSec, 2));
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `review-video-a7-${fixture.name.replaceAll(" ", "-")}.png`) });
      retained.push(item); observations.push({ name: fixture.name, samples, marker });
      evidence.observations = observations;
    }
    // Preserve v1 issue anchors across a genuine content v2, then reopen the profile.
    for (const original of retained) {
      await select(original.title);
      await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "返工", exact: true }).click();
      const reworkDialog = page.getByRole("dialog");
      await reworkDialog.getByLabel(/共同修改要求/).fill("保留现有圈注并提交更新的视频版本");
      await reworkDialog.getByRole("button", { name: "确认返工", exact: true }).click();
      await vi.waitFor(async () => expect((await readItem(original.id)).status).toBe("rework"));
    }
    await page.getByTitle("预览本轮已处理结果，确认后发布给 Agent 读取", { exact: true }).click();
    await page.getByRole("button", { name: /发布交接结果|更新交接结果/ }).click();
    await page.getByText(/等待 Agent 读取/).first().waitFor();
    await page.keyboard.press("Escape");
    const changes = value(await agent.callCommand<{ entries: Array<{ handoffIds?: string[] }> }>("review.changes", { target, afterSequence: 0 }));
    const handoffId = changes.entries.flatMap(entry => entry.handoffIds ?? []).at(-1)!;
    const published = value(await agent.callCommand<{ handoff: WorkbenchHandoff }>("review.handoff.get", { target, handoffId })).handoff;
    for (const original of retained) {
      const entry = published.items.find(item => item.itemId === original.id)!;
      expect(entry.videoMarkers).toEqual((original.content as WorkbenchVideoContent).markers);
      expect(entry.videoTimeBasis).toBe("browser-current-time");
    }
    evidence.published = published;
    const apply = async (ops: unknown[]) => {
      const current = value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target }));
      return value(await agent.callCommand("review.apply", { target, expectedNodeRevision: current.node.revision, requestId: randomUUID(), ops }));
    };
    await apply([{ op: "workbench.handoff.ack", handoffId }]);
    await apply([{ op: "workbench.rework", handoffId, results: [{ sourceItemId: items[0].id, previousVersion: 1, content: { type: "video", mediaId: items[3].resourceId, durationSec: Number(fixtures[3].probe.streams[0].duration) } }] }]);
    expect((await readItem(items[0].id)).version).toBe(2);
    await agent.close(); launched = await launched.relaunch(); agent = await connectExternalAgent(launched.endpointFile); page = launched.page;
    let reopened: ReviewContext;
    await vi.waitFor(async () => { reopened = value(await agent.callCommand<ReviewContext>("review.context")); }, { timeout: 15_000 });
    target = { ...reopened!.target, nodeId: node.id };
    for (const original of retained) {
      const item = await readItem(original.id);
      if (original.id === items[0].id) {
        expect((item.content as WorkbenchVideoContent).markers).toEqual([]);
        const archived = value(await agent.callCommand<{ content: WorkbenchVideoContent }>("review.versions.get", { target, itemId: original.id, version: 1 }));
        // Content bodies are immutable; mutable review geometry is retained in the v1 publication/feedback, not baked into media bytes.
        expect(archived.content.mediaId).toBe(items[0].resourceId);
        const history = value(await agent.callCommand<{ feedback: Array<{ itemVersion: number }> }>("review.get", { target, itemId: original.id }));
        expect(history.feedback.every(feedback => feedback.itemVersion === 1)).toBe(true);
        continue;
      }
      expect((item.content as WorkbenchVideoContent).markers).toEqual((original.content as WorkbenchVideoContent).markers);
      await select(original.title);
      await attachFrameObserver(player());
      await page.getByTestId("workbench-issue-card").first().click();
      await vi.waitFor(async () => expect((await readFrame(player())).currentTime).toBeCloseTo((original.content as WorkbenchVideoContent).markers[0].startPtsSec, 2));
    }
    evidence.reopened = await Promise.all(retained.map(item => readItem(item.id)));
    const reopenedHandoff = value(await agent.callCommand<{ handoff: WorkbenchHandoff }>("review.handoff.get", { target, handoffId })).handoff;
    expect(reopenedHandoff.items).toEqual(published.items);
    await select(fixtures[0].name);
    await attachFrameObserver(player());
    await seek(1.53);
    await page.getByRole("button", { name: /标问题帧/ }).click();
    await vi.waitFor(async () => expect(((await readItem(items[0].id)).content as WorkbenchVideoContent).markers[0]?.version).toBe(2));
    evidence.v2Marker = ((await readItem(items[0].id)).content as WorkbenchVideoContent).markers[0];
    await page.getByTestId("review-access-toggle").click();
    // Same decoded source and actual 2x setpts output: known time mapping, then an explicitly unmapped report.
    for (const mapped of [true, false]) {
      const stepId = randomUUID();
      const outputId = randomUUID();
      const nodeNow = value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node;
      const input = { nodeId: node.id, itemId: items[0].id, version: 1, role: "source", range: { startSec: 0, endSec: 3.6 } };
      const output = { nodeId: node.id, itemId: outputId, version: 1, role: "result", range: { startSec: 0, endSec: 7.2 } };
      value(await agent.callCommand("review.steps.start", { target, expectedNodeRevision: nodeNow.revision, requestId: randomUUID(), stepId, runId: randomUUID(), label: mapped ? "A7 mapped 2x" : "A7 unmapped", inputs: [input], method: { kind: "algorithm", name: "FFmpeg setpts" }, parameters: { filter: "setpts=2*(PTS-STARTPTS)" }, ...(mapped ? { mapping: { kind: "time-range", inputIndex: 0, outputIndex: 0 } } : {}) }));
      value(await agent.callCommand("review.steps.complete", { target, expectedNodeRevision: nodeNow.revision + 1, requestId: randomUUID(), stepId,
        ingest: { batchId: randomUUID(), name: mapped ? "Mapped output" : "Unmapped output", items: [{ id: outputId, title: "Actual slowed output", type: "video", content: { type: "video", mediaId: items[3].resourceId, durationSec: Number(fixtures[3].probe.streams[0].duration) } }] }, outputs: [output] }));
      await page.getByTestId("review-process-tab").click();
      await page.getByTestId("review-step-card").filter({ hasText: mapped ? "A7 mapped 2x" : "A7 unmapped" }).getByTestId("review-step-compare").click();
      const videos = page.getByTestId("review-comparison").locator("video");
      await vi.waitFor(async () => {
        expect(await videos.count()).toBe(2);
        expect(await videos.evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).readyState >= 2))).toBe(true);
      });
      await videos.evaluateAll(elements => {
        const state = window as unknown as { comparisonTrace?: Array<{ index: number; event: string; time: number }> };
        state.comparisonTrace = [];
        elements.forEach((element, index) => {
          const video = element as HTMLVideoElement;
          for (const event of ["seeking", "seeked", "timeupdate", "play"]) video.addEventListener(event, () => {
            state.comparisonTrace?.push({ index, event, time: video.currentTime });
          });
        });
      });
      await videos.nth(0).evaluate((el: HTMLVideoElement) => { el.currentTime = 1.53; });
      await vi.waitFor(async () => expect((await readFrame(videos.nth(0))).currentTime).toBeCloseTo(1.53, 2));
      if (mapped) {
        await vi.waitFor(async () => expect((await readFrame(videos.nth(1))).currentTime).toBeCloseTo(3.06, 1));
        await vi.waitFor(async () => {
          expect(matchFrame(fixtures[0], (await readFrame(videos.nth(0))).signature))
            .toBe(matchFrame(fixtures[3], (await readFrame(videos.nth(1))).signature));
        }, { timeout: 10_000 });
        await page.getByRole("button", { name: "Play mapped pair" }).click();
        await vi.waitFor(async () => expect((await readFrame(videos.nth(0))).currentTime).toBeGreaterThan(1.7));
        const rates = await videos.evaluateAll(elements => elements.map(el => (el as HTMLVideoElement).playbackRate));
        expect(rates).toEqual([1, 2]);
        await videos.evaluateAll(elements => elements.forEach(el => (el as HTMLVideoElement).pause()));
      } else {
        expect(await page.getByRole("button", { name: "Play mapped pair" }).count()).toBe(0);
        expect(await page.getByTestId("review-comparison").textContent()).toContain("No correspondence was recorded");
        expect((await readFrame(videos.nth(1))).currentTime).toBe(0);
      }
      evidence[mapped ? "mappedPair" : "unmappedPair"] = await Promise.all([readFrame(videos.nth(0)), readFrame(videos.nth(1))]);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `review-video-a7-${mapped ? "mapped" : "unmapped"}.png`) });
    }
  } finally {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    evidence.console = launched.output.rendererConsole;
    evidence.comparisonTrace = await launched.page.evaluate(() => (window as unknown as { comparisonTrace?: unknown }).comparisonTrace).catch(() => undefined);
    if (!launched.page.isClosed()) await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-video-a7-terminal.png") });
    await writeFile(evidencePath, JSON.stringify(evidence, evidenceJsonReplacer, 2));
    await agent.close(); await launched.close();
  }
}, 240_000);
