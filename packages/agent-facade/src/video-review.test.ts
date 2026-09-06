import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { analyzeLocalAudio } from "./audio-analysis";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { reviewVideo, readReviewStream, videoReviewConfig, videoReviewPreflight, videoReviewProvider, VIDEO_REVIEW_LIMITS } from "./video-review";

function response(finish = "stop") {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "0–1s: static bars; no audible evidence. Inconclusive sync." }, finish_reason: finish }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n`);
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("Alibaba video review", () => {
  it("requires a user key and prevents credential forwarding; preflight makes no paid probe", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    expect((await videoReviewPreflight()).available).toBe(false);
    expect(() => videoReviewConfig({ DASHSCOPE_API_KEY: "test", REELTERMINAL_QWEN_BASE_URL: "https://example.com/compatible-mode/v1" })).toThrow("official Alibaba");
    expect(videoReviewConfig({ DASHSCOPE_API_KEY: "test" }).endpoint).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-only");
    expect(JSON.stringify(await videoReviewPreflight())).not.toContain("unit-test-only");
  });
  it("keeps incomplete responses inconclusive and bounds streams without exposing provider errors", async () => {
    expect(await readReviewStream(response("length"))).toMatchObject({ status: "inconclusive", finishReason: "length" });
    await expect(readReviewStream(new Response("sensitive diagnostic", { status: 401 }))).rejects.toThrow("HTTP 401");
    await expect(readReviewStream(new Response("x".repeat(VIDEO_REVIEW_LIMITS.maxResponseBytes + 1)))).rejects.toThrow("resource limit");
    await expect(readReviewStream(new Response('data: {"error":{"message":"sensitive"}}\n'))).rejects.toThrow("stream error");
  });
  it("prepares a real bounded video, runs through jobs once, preserves state and removes inspection copies", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-only");
    const network = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string);
      expect(request.model).toBe("qwen3.5-omni-flash");
      expect(request.modalities).toEqual(["text"]);
      expect(request.max_tokens).toBe(1200);
      const encoded = request.messages[1].content[0].video_url.url.split(",")[1];
      const video = Buffer.from(encoded, "base64");
      expect(video.subarray(4, 8).toString()).toBe("ftyp");
      expect(video.length).toBeLessThan(VIDEO_REVIEW_LIMITS.maxUploadBytes);
      return response();
    });
    vi.stubGlobal("fetch", network);
    const root = await mkdtemp(join(tmpdir(), "rt-review-test-"));
    try {
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: root });
      await facade["project.create"]({ name: "Review" });
      const imported = await facade["media.import"]({ path: writeTinyMp4(root) });
      if (!imported.ok) throw new Error(imported.error.message);
      const before = await facade["project.get_state"]();
      const args = { mediaId: imported.value.mediaId, analysisTypes: ["videoReview"] as const, startSec: 1, endSec: 3, cloudUpload: true, idempotencyKey: "review-once" };
      expect(await facade["media.analyze_start"]({ ...args, cloudUpload: false })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      expect(await facade["media.analyze_start"]({ ...args, endSec: 30 })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      expect(await facade["media.analyze_start"]({ ...args, expectedRevision: 99 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(network).not.toHaveBeenCalled();
      const started = await facade["media.analyze_start"](args);
      if (!started.ok) throw new Error(started.error.message);
      let status;
      for (let i = 0; i < 200; i++) {
        status = await facade["job.status"]({ jobId: started.value.jobId });
        if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toMatchObject({ ok: true, value: { state: "done", sourceRevision: 1, result: { summary: { videoReview: { status: "opinion", coordinateSpace: "source", startSec: 1, endSec: 3, timeMapping: { offsetSec: 1 }, usage: { total_tokens: 120 } } } } } });
      vi.stubEnv("DASHSCOPE_API_KEY", ""); // Replays do not require a new credential or network access.
      expect(await facade["media.analyze_start"](args)).toMatchObject({ ok: true, value: { jobId: started.value.jobId, replayed: true } });
      expect(await facade["media.analyze_start"]({ ...args, reviewQuestion: "different" })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(network).toHaveBeenCalledTimes(1);
      expect(await facade["project.get_state"]()).toEqual(before);
      // The inspection copy is cached (not deleted) under artifactRoot, keyed
      // by source fingerprint + range; no partial files remain.
      const cacheFiles = await readdir(join(root, "video-review-cache"));
      expect(cacheFiles.filter((name) => name.endsWith(".mp4"))).toHaveLength(1);
      expect(cacheFiles.filter((name) => name.endsWith(".json"))).toHaveLength(1);
      expect(cacheFiles.some((name) => name.includes(".part."))).toBe(false);
      vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-only");
      // A DIFFERENT range so cancellation races a real transcode, not a cache hit.
      const cancelled = await facade["media.analyze_start"]({ ...args, startSec: 0, idempotencyKey: "cancel" });
      if (!cancelled.ok) throw new Error(cancelled.error.message);
      await facade["job.cancel"]({ jobId: cancelled.value.jobId });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await facade["job.status"]({ jobId: cancelled.value.jobId })).toMatchObject({ ok: true, value: { state: "cancelled" } });
      expect(network).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
});


it("preserves audible transient offsets in the actual uploaded excerpt and aborts in-flight requests", async () => {
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-only");
  const root = await mkdtemp(join(tmpdir(), "rt-review-av-"));
  const source = join(root, "fixture.mp4");
  const execute = promisify(execFile);
  try {
    await execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=4", "-f", "lavfi", "-i", "aevalsrc='if(between(t,2.2,2.4),0.5*sin(2*PI*880*t),0)':s=48000:d=4", "-vf", "drawbox=x=80:y=40:w=80:h=80:color=white:t=fill:enable='between(t,1.5,1.7)'", "-c:v", "libx264", "-c:a", "aac", "-y", source]);
    const uploaded = join(root, "uploaded.mp4");
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      await writeFile(uploaded, Buffer.from(request.messages[1].content[0].video_url.url.split(",")[1], "base64"));
      return response();
    }));
    const result = await reviewVideo(source, { startSec: 1, endSec: 3 }, root, new AbortController().signal);
    expect(result.preparation).toMatchObject({ audioPresent: true, audioChannels: 1, audioSampleRate: 48000, encodedAverageFps: 30 });
    expect(result.preparation.durationSec).toBeCloseTo(2, 1);
    const audio = await analyzeLocalAudio(uploaded, { startSec: 0, endSec: 2 }, new AbortController().signal);
    expect(audio.onsets[0]).toBeCloseTo(1.2, 1);
    const dark = await execute("ffmpeg", ["-v", "error", "-ss", "0.2", "-i", uploaded, "-frames:v", "1", "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
    const flash = await execute("ffmpeg", ["-v", "error", "-ss", "0.6", "-i", uploaded, "-frames:v", "1", "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
    expect(flash.stdout[0]).toBeGreaterThan(dark.stdout[0] + 15);
    const controller = new AbortController();
    const pendingNetwork = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      controller.abort();
    }));
    vi.stubGlobal("fetch", pendingNetwork);
    await expect(reviewVideo(source, { startSec: 1, endSec: 3 }, root, controller.signal)).rejects.toThrow("Cancelled");
    expect(pendingNetwork).toHaveBeenCalledTimes(1);
    // Second call hit the preparation cache (same source + range): no partial
    // files remain in the cache directory.
    const cacheFiles = await readdir(join(root, "video-review-cache"));
    expect(cacheFiles.some((name) => name.includes(".part."))).toBe(false);
    expect(cacheFiles.filter((name) => name.endsWith(".mp4"))).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

it("decodes split UTF-8 SSE chunks without changing evidence text", async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"画面证据"},"finish_reason":"stop"}]}\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  expect(await readReviewStream(new Response(stream))).toMatchObject({ text: "画面证据", status: "opinion" });
});

describe("video review provider seam and preparation cache", () => {
  it("selects providers through the host environment and refuses unknown ids", () => {
    expect(videoReviewProvider().id).toBe("qwen3.5-omni-flash");
    expect(videoReviewProvider({ REELTERMINAL_VIDEO_REVIEW_PROVIDER: "qwen3.5-omni-flash" }).id).toBe("qwen3.5-omni-flash");
    expect(() => videoReviewProvider({ REELTERMINAL_VIDEO_REVIEW_PROVIDER: "gpt-5-video" })).toThrow(/Unknown video review provider/);
  });

  it("reuses the cached inspection copy for the same source range and reports it", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-only");
    const root = await mkdtemp(join(tmpdir(), "rt-review-cache-"));
    const source = join(root, "fixture.mp4");
    const execute = promisify(execFile);
    const calls: number[] = [];
    const network = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string);
      calls.push(request.messages[1].content[0].video_url.url.length);
      return response();
    });
    vi.stubGlobal("fetch", network);
    try {
      await execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=4", "-c:v", "libx264", "-y", source]);
      const first = await reviewVideo(source, { startSec: 1, endSec: 3 }, root, new AbortController().signal);
      expect(first.preparation.cached).toBe(false);
      // Different range → different cache key → fresh transcode.
      const second = await reviewVideo(source, { startSec: 2, endSec: 3 }, root, new AbortController().signal);
      expect(second.preparation.cached).toBe(false);
      // Same range as the first → cache hit, identical evidence copy.
      const third = await reviewVideo(source, { startSec: 1, endSec: 3 }, root, new AbortController().signal);
      expect(third.preparation.cached).toBe(true);
      expect(third.preparation.sha256).toBe(first.preparation.sha256);
      // Every review still uploads once to the provider.
      expect(network).toHaveBeenCalledTimes(3);
      const cacheFiles = await readdir(join(root, "video-review-cache"));
      expect(cacheFiles.filter((name) => name.endsWith(".mp4"))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  }, 15000);
});
