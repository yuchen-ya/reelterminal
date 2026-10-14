import { test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPerformanceFixture } from "./fixtures";
import { prepareProfile } from "../harness/performance/driver";
import { runReleaseFeature } from "../harness/performance/release-feature";

const enabled = process.env.REELTERMINAL_RELEASE_FEATURE === "assets";
(enabled ? test : test.skip)("large asset/node browsing and atomic subtitle imports", async () => {
  const mediaCount = Number(process.env.REELTERMINAL_FEATURE_MEDIA_COUNT ?? 1000);
  const nodeCount = Number(process.env.REELTERMINAL_FEATURE_NODE_COUNT ?? 1000);
  const samples = Number(process.env.REELTERMINAL_FEATURE_SAMPLES ?? 100);
  const cues = Number(process.env.REELTERMINAL_FEATURE_CUES ?? 1000);
  if (![mediaCount, samples, cues].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid feature scale");
  const base = createPerformanceFixture({ scenarioId: "H01", seed: "release-assets-v1", parameters: { nodeCount } });
  const fixture = structuredClone(base) as any;
  const original = fixture.project.mediaLibrary.items[0];
  const currentAsset = fixture.assets.find((a: any) => a.assetId === original.id);
  if (!currentAsset) throw new Error("fixture media asset unavailable");
  const items = Array.from({ length: mediaCount }, (_, i) => ({ ...original, id: i === 0 ? original.id : "asset-pressure-" + i, name: "Item " + String(i).padStart(4, "0"), displayName: "Item " + String(i).padStart(4, "0") }));
  fixture.project.mediaLibrary.items = items;
  fixture.records.workspaces[0].project = fixture.project;
  fixture.assets.push(...items.slice(1).map((item: any) => ({ ...currentAsset, assetId: item.id, fileName: item.id + ".png" })));
  fixture.manifest.parameters = { ...fixture.manifest.parameters, mediaCount, samples, cues, reusedImageContent: true };
  const runDir = await prepareProfile(fixture);
  await runReleaseFeature("assets", async c => {
    const page = c.app.page;
    const browser = page.getByTestId("project-asset-browser");
    const types = browser.getByRole("group", { name: "Media type" });
    const search = browser.getByLabel("Search project assets", { exact: true });
    const cells = browser.locator("[data-live-media-id]");
    const waitCount = async (selector: string, expected: number) => page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected }, { timeout: 120_000 });
    const currentCount = (expected: number) => waitCount('[data-testid="project-asset-browser"] [data-live-media-id]', expected);
    const measure = async (kind: string, index: number, work: () => Promise<void>) => {
      expect(await page.evaluate(() => !document.hidden)).toBe(true);
      const start = performance.now(); await work();
      c.record.operations.push({ kind, index, elapsed_ms: performance.now() - start, verified: true });
    };
    c.record.scale = { mediaCount, nodeCount, samples_per_kind: samples, cues_per_format: cues, image_content_reused: true, video_decode_stress: false };
    const initial = await c.call("project_get_state");
    expect(initial.project.mediaLibrary.items).toHaveLength(mediaCount);
    await currentCount(mediaCount);
    for (let i = 0; i < samples; i++) {
      await measure("type", i, async () => {
        const label = ["Images", "Audio", "Video", "All"][i % 4]!;
        await types.getByRole("button", { name: label, exact: true }).click();
        await currentCount(["Images", "All"].includes(label) ? mediaCount : 0);
        await types.getByRole("button", { name: "All", exact: true }).click(); await currentCount(mediaCount);
      });
      await measure("search", i, async () => {
        const name = "Item " + String(i % mediaCount).padStart(4, "0");
        await search.fill(name); await currentCount(1);
        expect(await cells.first().getAttribute("data-live-media-id")).toBe(items[i % mediaCount]!.id);
        await search.fill(""); await currentCount(mediaCount);
      });
      await measure("sort", i, async () => {
        const descending = i % 2 === 0;
        await browser.getByRole("combobox", { name: "Sort media" }).selectOption(descending ? "nameDesc" : "nameAsc");
        const id = items[descending ? mediaCount - 1 : 0]!.id;
        await page.waitForFunction(id => document.querySelector('[data-testid="project-asset-browser"] [data-live-media-id]')?.getAttribute("data-live-media-id") === id, id);
      });
      const node = fixture.records.nodes[i % nodeCount];
      await measure("node", i, async () => {
        await browser.getByRole("button", { name: "By save point", exact: true }).click();
        await waitCount('[data-testid^="asset-node-"]', nodeCount);
        await browser.getByTestId("asset-node-" + node.id).click();
        await browser.getByTestId("node-assets").waitFor();
        await waitCount('[data-testid="node-assets"] [data-node-media-id]', node.project.mediaLibrary.items.length);
        expect(await browser.locator("[data-node-media-id]").first().getAttribute("data-node-media-id")).toBe(node.project.mediaLibrary.items[0].id);
        expect(await browser.locator("[data-node-media-id] button").count()).toBe(node.project.mediaLibrary.items.length);
        expect(await page.getByTestId("version-preview-banner").count()).toBe(0);
      });
      await measure("clear_node", i, async () => {
        await browser.getByRole("button", { name: "Clear save-point filter" }).click(); await currentCount(mediaCount);
      });
      if (i % 10 === 0) { await c.sample(); await c.flush(); console.info("ASSET_PRESSURE_PROGRESS", { completed_each: i + 1, samples }); }
    }
    const unchanged = await c.call("project_get_state");
    expect(unchanged.revision).toBe(initial.revision);
    expect(unchanged.project.timeline).toEqual(initial.project.timeline);
    const timestamp = (seconds: number, vtt: boolean) => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":") + (vtt ? ".000" : ",000");
    for (const format of ["srt", "vtt"]) {
      const vtt = format === "vtt";
      const content = (vtt ? "WEBVTT\n\n" : "\uFEFF") + Array.from({ length: cues }, (_, i) => String(i + 1) + "\n" + timestamp(i * 2, vtt) + " --> " + timestamp(i * 2 + 1, vtt) + "\nCue " + i + " 中文字幕\n").join("\n");
      const file = path.join(c.app.runDir, "pressure." + format); await writeFile(file, content);
      const before = await c.call("project_get_state");
      const beforeResources = await c.sample();
      const start = performance.now();
      await page.locator('input[type="file"][aria-label="Import media"]').setInputFiles(file);
      await waitCount('[data-testid="project-subtitles"] > div.rounded', cues);
      const after = await c.call("project_get_state");
      expect(after.project.textClips).toHaveLength(cues);
      const ordered = [...after.project.textClips].sort((a: any, b: any) => a.startTime - b.startTime);
      ordered.forEach((clip: any, i: number) => { expect(clip.startTime).toBe(i * 2); expect(clip.duration).toBe(1); expect(clip.text).toBe("Cue " + i + " 中文字幕"); });
      const afterResources = await c.sample();
      // actionUndo counts retained actions, not atomic user-visible groups.
      // One real undo/redo below must restore all cues and the created track.
      await c.call("history_control", { action: "undo", expectedRevision: after.revision });
      const undone = await c.call("project_get_state");
      expect(undone.project.textClips).toEqual(before.project.textClips);
      expect(undone.project.timeline).toEqual(before.project.timeline);
      await c.call("history_control", { action: "redo", expectedRevision: undone.revision });
      const redone = await c.call("project_get_state");
      expect(redone.project.textClips).toEqual(after.project.textClips);
      await page.screenshot({ path: path.join(c.evidence, "captions-" + format + ".png") });
      await c.call("history_control", { action: "undo", expectedRevision: redone.revision });
      c.record.operations.push({ kind: "subtitle_" + format, cues, elapsed_ms: performance.now() - start, final_content_verified: true, single_undo_group_verified: true, retained_actions_before: beforeResources.resources.history.actionUndo, retained_actions_after: afterResources.resources.history.actionUndo });
      await types.getByRole("button", { name: "All", exact: true }).click(); await currentCount(mediaCount);
      await c.flush();
    }
    await c.sample();
    await page.screenshot({ path: path.join(c.evidence, "large-assets.png") });
  }, { runDir, createProject: false, setup: async app => { await app.page.getByRole("button", { name: "Open " + fixture.project.name, exact: true }).click(); } });
}, 7_200_000);
