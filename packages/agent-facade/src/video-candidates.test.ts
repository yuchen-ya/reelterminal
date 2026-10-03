/**
 * M1 video candidate analyses through the real headless facade job system:
 * sceneCuts / blackFrames / duplicateFrames produce bounded candidate lists
 * on the known-content sample (cuts at frames 20/40/45/55, black 45–54,
 * frozen tail 65–74), with durable analysis records, cooperative
 * cancellation, and honest UNSUPPORTED when ffmpeg is absent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createAgentFacade, type AgentFacade } from "./index";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

const binaries = await resolveToolFfmpeg();
const hasFfmpeg = binaries !== null;
const skip = () => (hasFfmpeg ? undefined : true);

let root = "";
let facade: AgentFacade | undefined;
let mediaId = "";

async function waitForJob(jobId: string) {
  let status = await facade!["job.status"]({ jobId });
  for (let attempt = 0; status.ok && !["done", "error", "cancelled"].includes(status.value.state) && attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = await facade!["job.status"]({ jobId });
  }
  return status;
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  root = await mkdtemp(path.join(tmpdir(), "reelterminal-video-candidates-"));
  const source = path.join(root, "candidates.mp4");
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "smptebars=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "color=white:size=320x180:rate=10:duration=0.5",
    "-f", "lavfi", "-i", "color=black:size=320x180:rate=10:duration=1",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1",
    "-filter_complex",
    "[4:v]tpad=stop_mode=clone:stop_duration=1[frozen];[0:v][1:v][2:v][3:v][frozen]concat=n=5:v=1:a=0[v]",
    "-map", "[v]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", source,
  ]);
  facade = createAgentFacade({ mediaRoots: [root], artifactRoot: path.join(root, "artifacts") });
  await facade!["project.create"]({ name: "candidates" });
  const imported = await facade!["media.import"]({ path: source });
  if (!imported.ok) throw new Error(imported.error.message);
  mediaId = imported.value.mediaId;
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("media.analyze_start video candidate types", () => {
  it.skipIf(skip())("returns shot, black and freeze candidates with parameters and limitations", async () => {
    const started = await facade!["media.analyze_start"]({
      mediaId,
      analysisTypes: ["sceneCuts", "blackFrames", "duplicateFrames"],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    const status = await waitForJob(started.value.jobId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.state).toBe("done");
    if (status.value.state !== "done") return;
    const summary = status.value.result!.summary as Record<string, {
      candidates?: { frameIndex: number | null; startFrameIndex: number | null }[];
      parameters?: unknown; limitations?: string[]; frameTiming?: { timing: string };
    }>;
    const sceneFrames = summary.sceneCuts!.candidates!.map((candidate) => candidate.frameIndex);
    for (const expected of [20, 40, 45, 55]) expect(sceneFrames).toContain(expected);
    expect(summary.sceneCuts!.parameters).toEqual({ threshold: 0.25 });
    expect(summary.sceneCuts!.frameTiming!.timing).toBe("cfr");
    expect(summary.sceneCuts!.limitations!.join(" ")).toMatch(/Candidates/i);

    expect(summary.blackFrames!.candidates!.map((candidate) => candidate.startFrameIndex)).toContain(45);

    const freezeStarts = summary.duplicateFrames!.candidates!.map((candidate) => candidate.startFrameIndex);
    expect(freezeStarts.some((start) => start !== null && start >= 60)).toBe(true);
    expect(summary.duplicateFrames!.limitations!.join(" ")).toMatch(/never failures|intentional/i);
  });

  it.skipIf(skip())("enriches technicalQuality with frame facts (count, time base, CFR verdict)", async () => {
    const started = await facade!["media.analyze_start"]({ mediaId, analysisTypes: ["technicalQuality"] });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    const status = await waitForJob(started.value.jobId);
    if (!status.ok || status.value.state !== "done") throw new Error("job did not finish");
    const technical = (status.value.result!.summary as { technicalQuality: { frames: { decodedFrameCount: number | null; headerFrameCount: number | null; timeBase: string | null; frameTiming: { timing: string; fps: number | null } } | null } }).technicalQuality;
    expect(technical.frames).not.toBeNull();
    expect(technical.frames!.decodedFrameCount ?? technical.frames!.headerFrameCount).toBe(75);
    expect(technical.frames!.timeBase).toBe("1/10240");
    expect(technical.frames!.frameTiming.timing).toBe("cfr");
    expect(technical.frames!.frameTiming.fps).toBeCloseTo(10, 5);
  });

  it.skipIf(skip())("persists a durable record with provenance and observations for the new types", async () => {
    const started = await facade!["media.analyze_start"]({ mediaId, analysisTypes: ["sceneCuts"] });
    if (!started.ok) throw new Error(started.error.message);
    const status = await waitForJob(started.value.jobId);
    if (!status.ok || status.value.state !== "done") throw new Error("job did not finish");
    const recordRef = (status.value.result!.summary as { analysisRecord: { id: string; recordPath: string } }).analysisRecord;
    const record = JSON.parse(await readFile(recordRef.recordPath, "utf8"));
    expect(record.provenance).toContainEqual(
      expect.objectContaining({ kind: "local-measurement", provider: "local-ffmpeg-scene-score", analysisType: "sceneCuts" }),
    );
    expect(record.observations.map((observation: { source: string }) => observation.source)).toContain("sceneCuts");
    // Query verbs see the same record.
    const listed = await facade!["analysis.list"]({ mediaId });
    expect(listed.ok && listed.value.some((entry) => entry.id === recordRef.id)).toBe(true);
  });

  it.skipIf(skip())("cancels a candidate analysis job cooperatively", async () => {
    const started = await facade!["media.analyze_start"]({ mediaId, analysisTypes: ["sceneCuts", "blackFrames", "duplicateFrames"] });
    if (!started.ok) throw new Error(started.error.message);
    await facade!["job.cancel"]({ jobId: started.value.jobId });
    const status = await waitForJob(started.value.jobId);
    if (!status.ok) return;
    expect(["cancelled", "done"]).toContain(status.value.state);
    if (status.value.state === "cancelled") {
      expect(status.value.result).toBeNull();
    }
  });

  it.skipIf(skip())("still rejects genuinely unavailable types", async () => {
    const result = await facade!["media.analyze_start"]({ mediaId, analysisTypes: ["motion"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED");
    expect(result.error.message).toMatch(/unavailable analysis types: motion/);
  });

  it("fails UNSUPPORTED without ffmpeg (fresh module, bogus binary path)", async () => {
    vi.resetModules();
    process.env.REELTERMINAL_FFMPEG_PATH = "C:/definitely/no/ffmpeg.exe";
    try {
      const { createAgentFacade: freshCreate } = await import("./index");
      const { writeTinyMp4 } = await import("./media/fixtures/tiny-mp4");
      const freshFacade = freshCreate({ mediaRoots: [root] });
      await freshFacade["project.create"]({ name: "no-ffmpeg" });
      const imported = await freshFacade["media.import"]({ path: writeTinyMp4(root) });
      if (!imported.ok) throw new Error(imported.error.message);
      const result = await freshFacade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["sceneCuts"] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("UNSUPPORTED");
    } finally {
      delete process.env.REELTERMINAL_FFMPEG_PATH;
      vi.resetModules();
    }
  });
});
