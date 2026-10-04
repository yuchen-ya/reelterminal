import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { createEmptyProject } from "./project-factory";
import { opToCoreActions } from "./ops";
import type { MediaItem } from "@reelterminal/core/types/project";
import type { MediaProduction } from "@reelterminal/core/types/media-production";

const production: MediaProduction = {
  status: "pending",
  notes: "Check eye movement",
  steps: [
    {
      operation: "generation",
      tool: "external",
      model: "declared-model",
      inputMediaIds: [],
      range: { startFrame: 0, endFrame: 4 },
    },
    {
      operation: "resize",
      tool: "ffmpeg",
      inputMediaIds: [],
      range: { startFrame: 4, endFrame: 8 },
    },
  ],
};

const executeFile = promisify(execFile);

describe("production records", () => {
  let root: string;
  let facade: AgentFacade;
  let mediaId: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "production-"));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: root });
    await facade["project.create"]({ name: "Production" });
    const imported = await facade["media.import"]({ path: writeTinyMp4(root) });
    if (!imported.ok) throw new Error(imported.error.message);
    mediaId = imported.value.mediaId;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs and checkpoints an actual local analysis job through the facade batch commands", async () => {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    const started = await facade["batch.start"]({
      batchId: "actual",
      mediaIds: [mediaId],
      analysisTypes: ["technicalQuality"],
      expectedRevision: state.value.revision,
    });
    expect(started.ok).toBe(true);
    let done = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const batch = await facade["batch.get"]({ batchId: "actual" });
      if (!batch.ok) throw new Error(batch.error.message);
      const status = batch.value.items[0].status;
      if (status?.state === "error") throw new Error(status.error?.message);
      if (status?.state === "done") {
        done = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(done).toBe(true);
    const resumed = await facade["batch.resume"]({ batchId: "actual" });
    expect(resumed.ok && resumed.value.items[0].jobId).toBe(
      started.ok && started.value.items[0].jobId,
    );
  });

  it("strict replacement rejects a missing decoded frame without importing a candidate", async () => {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    const file = join(root, "short-candidate.mp4");
    await executeFile("ffmpeg", [
      "-v",
      "error",
      "-i",
      state.value.project.mediaLibrary.items[0].originalUrl!,
      "-frames:v",
      "59",
      "-an",
      "-c:v",
      "libx264",
      file,
    ]);
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "media.replace",
          mediaId,
          filePath: file,
          scope: "project",
          preserveFrames: true,
        },
      ],
    });
    expect(!result.ok && result.error.message).toMatch(/frame count/);
    const after = await facade["project.get_state"]();
    expect(after.ok && after.value.project.mediaLibrary.items).toHaveLength(1);
  });

  it("shares records, supports mixed-source filtering and keeps unrecorded media unknown", async () => {
    expect(
      (await facade["media.production_list"]({ operation: "original" })).ok,
    ).toBe(true);
    const saved = await facade["edit.apply"]({
      ops: [{ op: "media.setProduction", mediaId, production }],
    });
    expect(saved.ok).toBe(true);
    const filtered = await facade["media.production_list"]({
      operation: "generation",
      status: "pending",
    });
    expect(filtered.ok && filtered.value.items[0].production).toEqual(
      production,
    );
    const enhanced = await facade["media.production_list"]({
      operation: "modelEnhancement",
    });
    expect(enhanced.ok && enhanced.value.items).toEqual([]);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    const project = structuredClone(state.value.project);
    const executor = new ActionExecutor();
    const [action] = opToCoreActions(
      {
        op: "media.setProduction",
        mediaId,
        production: { ...production, status: "adopted" },
      },
      project,
    );
    expect((await executor.execute(action!, project)).success).toBe(true);
    expect((await executor.undo(project)).success).toBe(true);
    expect(project.mediaLibrary.items[0].production).toEqual(production);
    expect((await executor.redo(project)).success).toBe(true);
    expect(project.mediaLibrary.items[0].production?.status).toBe("adopted");
  });

  it("rejects invalid model claims, frame ranges and missing input versions without changing records", async () => {
    for (const step of [
      { operation: "modelEnhancement", tool: "external", inputMediaIds: [] },
      {
        operation: "redraw",
        tool: "paint",
        inputMediaIds: [],
        range: { startFrame: 4, endFrame: 4 },
      },
      { operation: "composite", tool: "ffmpeg", inputMediaIds: ["missing"] },
    ]) {
      const result = await facade["edit.apply"]({
        ops: [
          {
            op: "media.setProduction",
            mediaId,
            production: { ...production, steps: [step] },
          },
        ],
      } as never);
      expect(result.ok).toBe(false);
    }
    const list = await facade["media.production_list"]({});
    expect(list.ok && list.value.items[0].production).toBeNull();
  });

  it("strict replacement verifies actual frames and leaves timing untouched", async () => {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    const file = join(root, "候选 version.mp4");
    await copyFile(
      state.value.project.mediaLibrary.items[0].originalUrl!,
      file,
    );
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackId: "v", trackType: "video" },
        {
          op: "clip.add",
          trackId: "v",
          mediaId,
          clipId: "c",
          startTime: 0,
          duration: 2,
          inPoint: 0,
          outPoint: 2,
        },
      ],
    });
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "media.replace",
          mediaId,
          filePath: file,
          scope: "project",
          preserveFrames: true,
        },
      ],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = await facade["project.get_state"]();
    expect(
      after.ok && after.value.project.timeline.tracks[0].clips[0],
    ).toMatchObject({ duration: 2, outPoint: 2 });
  });
});

it("undo removes newly introduced production metadata from legacy media", async () => {
  const project = createEmptyProject("Legacy");
  project.mediaLibrary.items.push({
    id: "m",
    name: "old",
    type: "image",
    metadata: { duration: 0 },
    blob: null,
  } as MediaItem);
  const executor = new ActionExecutor();
  const [action] = opToCoreActions(
    { op: "media.setProduction", mediaId: "m", production },
    project,
  );
  expect((await executor.execute(action!, project)).success).toBe(true);
  expect((await executor.undo(project)).success).toBe(true);
  expect(project.mediaLibrary.items[0]).not.toHaveProperty("production");
});
