import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentFacade } from "@openreel/agent-facade";
import { createChromiumProviders } from "./node/providers";
import { resolveFfmpegBinaries, runProcess, extractFrameRgba } from "./node/ffmpeg";

it("reveals a brief detail with dense source sampling and a real ROI crop", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-detail-fixture-"));
  const providers = createChromiumProviders();
  try {
    const binaries = await resolveFfmpegBinaries();
    if (!binaries) throw new Error("ffmpeg required");
    const source = join(root, "event.mp4");
    await runProcess(binaries.ffmpeg, ["-y", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=2", "-vf", "drawbox=x=256:y=0:w=64:h=36:color=white:t=fill:enable='between(t,0.99,1.05)'", "-c:v", "libvpx-vp9", "-an", source]);
    const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts"), renderProvider: providers.renderProvider });
    await facade["project.create"]({ name: "Source evidence" });
    const imported = await facade["media.import"]({ path: source });
    if (!imported.ok) throw new Error(imported.error.message);
    const before = await facade["project.get_state"]();
    const overview = await facade["media.inspect"]({ mediaId: imported.value.mediaId, startSec: .2, endSec: 1.8, sampleCount: 2, width: 320 });
    const detail = await facade["media.inspect"]({ mediaId: imported.value.mediaId, startSec: .98, endSec: 1.06, timesSec: [1], roi: { x: .8, y: 0, width: .2, height: .2 }, width: 320 });
    if (!overview.ok || !detail.ok) throw new Error(JSON.stringify({ overview, detail }));
    const average = async (path: string) => {
      const data = await extractFrameRgba(binaries.ffmpeg, path, 0, 320, 180, { scale: { width: 32, height: 18 } });
      let sum = 0; for (let i = 0; i < data.length; i += 4) sum += data[i];
      return sum / (data.length / 4);
    };
    expect(await average(overview.value.frames[0].artifact.path)).toBeLessThan(5);
    expect(await average(detail.value.frames[0].regionArtifact!.path)).toBeGreaterThan(230);
    expect(await facade["project.get_state"]()).toEqual(before);
    // Complete the evidence → audio anchor → canonical edit → pixel check loop.
    const music = join(root, "anchor.wav");
    await runProcess(binaries.ffmpeg, ["-y", "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,1.5\\,1.52)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=2", "-c:a", "pcm_s16le", music]);
    const audioImport = await facade["media.import"]({ path: music });
    if (!audioImport.ok) throw new Error(audioImport.error.message);
    const job = await facade["media.analyze_start"]({ mediaId: audioImport.value.mediaId, analysisTypes: ["audioSummary"], startSec: 0, endSec: 2 });
    if (!job.ok) throw new Error(job.error.message);
    let anchor: number | undefined;
    for (let i = 0; i < 200; i++) {
      const status = await facade["job.status"]({ jobId: job.value.jobId });
      if (!status.ok) throw new Error(status.error.message);
      if (status.value.state === "error") throw new Error(status.value.error?.message);
      if (status.value.state === "done") { anchor = (status.value.result!.summary.audioSummary as { onsets: number[] }).onsets[0]; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(anchor).toBeCloseTo(1.5, 2);
    const placement = await facade["edit.apply"]({ ops: [
      { op: "track.add", trackType: "video", trackId: "v1" },
      { op: "track.add", trackType: "audio", trackId: "a1" },
      { op: "clip.add", mediaId: imported.value.mediaId, trackId: "v1", startTime: 0, inPoint: .2, outPoint: 1.8, clipId: "event" },
      { op: "clip.setSpeed", clipId: "event", speed: 2 },
      { op: "clip.add", mediaId: audioImport.value.mediaId, trackId: "a1", startTime: 0 },
    ] });
    if (!placement.ok) throw new Error(placement.error.message);
    const ops = [{ op: "clip.move" as const, clipId: "event", startTime: anchor! - (1.02 - .2) / 2 },
      { op: "marker.add" as const, target: { kind: "timeRange" as const, start: anchor!, end: anchor! }, label: "Measured transient; visual event uncertainty ±1 frame" }];
    expect(await facade["edit.validate"]({ ops, expectedRevision: placement.value.revision })).toMatchObject({ ok: true });
    expect(await facade["edit.apply"]({ ops, expectedRevision: placement.value.revision, idempotencyKey: "align-fixture" })).toMatchObject({ ok: true });
    const aligned = await facade["preview.render_frame"]({ timeSec: anchor!, width: 320, height: 180 });
    if (!aligned.ok) throw new Error(aligned.error.message);
    expect(await average(aligned.value.artifact.path)).toBeGreaterThan(5);

  } finally { await providers.close(); await rm(root, { recursive: true, force: true }); }
});
