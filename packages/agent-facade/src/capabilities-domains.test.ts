/**
 * AUD-04: capabilities.get domain-scoped lazy probing.
 *
 * A domain-filtered query runs only that domain's probes; every
 * probe-dependent status outside the requested domain reports
 * `probed: false` and is never `available: true`. A query without the
 * filter runs all probes as before. The filter only scopes probing —
 * the verbs' real pre-execution checks are covered elsewhere
 * (capabilities.test.ts pins the analyze_start gate).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { makeTempDir, removeTempDir } from "./test-helpers";
import { setAudioModelsProbeForTests } from "./media/audio-models-runner";

// Match the mocked preflight fixtures below instead of importing a local
// Python model environment when the audio domain is selected.
beforeEach(() => setAudioModelsProbeForTests(async () => ({ available: false, reason: "No optional audio models in the domain-filter unit fixture" })));
afterEach(() => setAudioModelsProbeForTests(null));

const probes = vi.hoisted(() => ({
  audioAnalysisPreflight: vi.fn(),
  speechVadPreflight: vi.fn(),
  videoReviewPreflight: vi.fn(),
  ffmpegToolPreflight: vi.fn(),
  probeLabelFont: vi.fn(),
  opencvToolPreflight: vi.fn(),
}));

vi.mock("./audio-analysis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio-analysis")>()),
  audioAnalysisPreflight: probes.audioAnalysisPreflight,
}));
vi.mock("./speech-vad", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./speech-vad")>()),
  speechVadPreflight: probes.speechVadPreflight,
}));
vi.mock("./video-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./video-review")>()),
  videoReviewPreflight: probes.videoReviewPreflight,
}));
vi.mock("./media/ffmpeg-bin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media/ffmpeg-bin")>()),
  ffmpegToolPreflight: probes.ffmpegToolPreflight,
  probeLabelFont: probes.probeLabelFont,
}));
vi.mock("./media/opencv-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media/opencv-runner")>()),
  opencvToolPreflight: probes.opencvToolPreflight,
}));

describe("capabilities.get domain-scoped probing", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("caps-domains-media");
    artifactRoot = await makeTempDir("caps-domains-artifacts");
    // The speechActivity capability reads details.model from the VAD
    // preflight, so the placeholder mirrors that shape.
    probes.audioAnalysisPreflight.mockReset().mockResolvedValue({ available: true });
    probes.speechVadPreflight.mockReset().mockResolvedValue({
      available: true,
      details: { model: { file: "silero-vad.onnx" } },
    });
    probes.videoReviewPreflight.mockReset().mockResolvedValue({ available: true });
    probes.ffmpegToolPreflight.mockReset().mockResolvedValue({ available: true });
    probes.opencvToolPreflight.mockReset().mockResolvedValue({ available: true });
    probes.probeLabelFont.mockReset().mockResolvedValue("DejaVuSans.ttf");
    facade = createAgentFacade({ mediaRoots: [mediaRoot], artifactRoot });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
    await removeTempDir(artifactRoot);
  });

  it("an audio-domain query runs only the audio probes", async () => {
    const res = await facade["capabilities.get"]({ domain: "audio" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.audioAnalysisPreflight).toHaveBeenCalledTimes(1);
    expect(probes.speechVadPreflight).toHaveBeenCalledTimes(1);
    // Unrelated model / video / frame / motion / provider probes never start.
    expect(probes.videoReviewPreflight).not.toHaveBeenCalled();
    expect(probes.ffmpegToolPreflight).not.toHaveBeenCalled();
    expect(probes.probeLabelFont).not.toHaveBeenCalled();
    expect(probes.opencvToolPreflight).not.toHaveBeenCalled();
  });

  it("unprobed statuses are never available and carry the probed:false marker", async () => {
    const res = await facade["capabilities.get"]({ domain: "audio" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const caps = res.value;

    expect(caps.mediaAnalysis.types.videoReview).toMatchObject({
      available: false,
      probed: false,
    });
    expect(caps.frameTools.ffmpeg).toMatchObject({ available: false, probed: false });
    expect(caps.frameTools.contactSheetLabelFont).toEqual({ path: null, probed: false });
    expect(caps.motionTools.opencv).toMatchObject({ available: false, probed: false });
    expect(caps.motionTools.align).toMatchObject({ available: false, probed: false });
    expect(caps.motionTools.track).toMatchObject({ available: false, probed: false });
    expect(caps.motionTools.maskRefine).toMatchObject({ available: false, probed: false });
    expect(caps.motionTools.patchPropagate).toMatchObject({ available: false, probed: false });
    expect(caps.preview).toMatchObject({ available: false, probed: false });
    expect(caps.export).toMatchObject({ available: false, probed: false });
    expect(caps.verify).toMatchObject({ available: false, probed: false });
    // The not-probed reason explains how to probe for real.
    expect(caps.frameTools.ffmpeg.reason).toContain("Not probed");
    // A not-probed render never leaks availability into dependent claims.
    expect(caps.textOverlay.pixelRendering).toBe(false);
    const renderPlugin = Object.values(caps.pluginTools).find((tool) => !tool.available);
    expect(renderPlugin?.probed).toBe(false);
  });

  it("probed statuses in the requested domain carry no probed marker", async () => {
    const res = await facade["capabilities.get"]({ domain: "audio" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const type of ["audioSummary", "silence", "beatGrid", "speechActivity"] as const) {
      const status = res.value.mediaAnalysis.types[type];
      expect(status.available).toBe(true);
      expect(status.probed).toBeUndefined();
    }
    expect(res.value.audioNormalize.available).toBe(true);
    expect(res.value.audioNormalize.probed).toBeUndefined();
  });

  it("a video-domain query runs the video probes and the shared ffmpeg preflight, not audio or models", async () => {
    const res = await facade["capabilities.get"]({ domain: "video" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.videoReviewPreflight).toHaveBeenCalledTimes(1);
    // sceneCuts/blackFrames/duplicateFrames consume this shared preflight.
    expect(probes.ffmpegToolPreflight).toHaveBeenCalledTimes(1);
    expect(probes.audioAnalysisPreflight).not.toHaveBeenCalled();
    expect(probes.speechVadPreflight).not.toHaveBeenCalled();
    expect(probes.opencvToolPreflight).not.toHaveBeenCalled();
    expect(res.value.mediaAnalysis.types.audioSummary).toMatchObject({ available: false, probed: false });
    expect(res.value.audioNormalize).toMatchObject({ available: false, probed: false });
  });

  it("a motion-domain query runs the opencv probes and the shared ffmpeg preflight", async () => {
    const res = await facade["capabilities.get"]({ domain: "motion" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.opencvToolPreflight).toHaveBeenCalledTimes(3);
    expect(probes.ffmpegToolPreflight).toHaveBeenCalledTimes(1);
    expect(probes.probeLabelFont).not.toHaveBeenCalled();
    expect(probes.speechVadPreflight).not.toHaveBeenCalled();
    expect(res.value.frameTools.contactSheetLabelFont).toEqual({ path: null, probed: false });
  });

  it("a frames-domain query probes ffmpeg and the label font only", async () => {
    const res = await facade["capabilities.get"]({ domain: "frames" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.ffmpegToolPreflight).toHaveBeenCalledTimes(1);
    expect(probes.probeLabelFont).toHaveBeenCalledTimes(1);
    expect(probes.audioAnalysisPreflight).not.toHaveBeenCalled();
    expect(probes.speechVadPreflight).not.toHaveBeenCalled();
    expect(probes.videoReviewPreflight).not.toHaveBeenCalled();
    expect(probes.opencvToolPreflight).not.toHaveBeenCalled();
    expect(res.value.frameTools.ffmpeg.available).toBe(true);
    expect(res.value.frameTools.contactSheetLabelFont).toEqual({ path: "DejaVuSans.ttf" });
    expect(res.value.mediaAnalysis.types.audioSummary).toMatchObject({ available: false, probed: false });
    expect(res.value.motionTools.opencv).toMatchObject({ available: false, probed: false });
  });

  it("a render-domain query probes only the render provider", async () => {
    const res = await facade["capabilities.get"]({ domain: "render" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.audioAnalysisPreflight).not.toHaveBeenCalled();
    expect(probes.speechVadPreflight).not.toHaveBeenCalled();
    expect(probes.videoReviewPreflight).not.toHaveBeenCalled();
    expect(probes.ffmpegToolPreflight).not.toHaveBeenCalled();
    expect(probes.probeLabelFont).not.toHaveBeenCalled();
    expect(probes.opencvToolPreflight).not.toHaveBeenCalled();
    // No provider is injected, so preview is a real probe result (not a
    // scoped-out one); the other domains stay explicitly not-probed.
    expect(res.value.preview).toMatchObject({ available: false });
    expect(res.value.preview.probed).toBeUndefined();
    expect(res.value.export).toMatchObject({ available: false, probed: false });
    expect(res.value.frameTools.ffmpeg).toMatchObject({ available: false, probed: false });
    expect(res.value.mediaAnalysis.types.audioSummary).toMatchObject({ available: false, probed: false });
  });

  it("an export-domain query probes only the delivery chain", async () => {
    const res = await facade["capabilities.get"]({ domain: "export" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.audioAnalysisPreflight).not.toHaveBeenCalled();
    expect(probes.speechVadPreflight).not.toHaveBeenCalled();
    expect(probes.videoReviewPreflight).not.toHaveBeenCalled();
    expect(probes.ffmpegToolPreflight).not.toHaveBeenCalled();
    expect(probes.probeLabelFont).not.toHaveBeenCalled();
    expect(probes.opencvToolPreflight).not.toHaveBeenCalled();
    // The export chain is probed for real (no provider injected here), while
    // preview and the shared ffmpeg preflight are outside this domain.
    expect(res.value.export.probed).toBeUndefined();
    expect(res.value.verify.probed).toBeUndefined();
    expect(res.value.preview).toMatchObject({ available: false, probed: false });
    expect(res.value.frameTools.ffmpeg).toMatchObject({ available: false, probed: false });
    expect(res.value.audioNormalize).toMatchObject({ available: false, probed: false });
    expect(res.value.mediaAnalysis.types.videoReview).toMatchObject({ available: false, probed: false });
  });

  it("without the filter every probe runs and no status is marked not-probed", async () => {
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(probes.audioAnalysisPreflight).toHaveBeenCalledTimes(1);
    expect(probes.speechVadPreflight).toHaveBeenCalledTimes(1);
    expect(probes.videoReviewPreflight).toHaveBeenCalledTimes(1);
    expect(probes.ffmpegToolPreflight).toHaveBeenCalledTimes(1);
    expect(probes.probeLabelFont).toHaveBeenCalledTimes(1);
    expect(probes.opencvToolPreflight).toHaveBeenCalledTimes(3);

    expect(res.value.frameTools.ffmpeg.probed).toBeUndefined();
    expect(res.value.frameTools.contactSheetLabelFont.probed).toBeUndefined();
    expect(res.value.motionTools.opencv.probed).toBeUndefined();
    expect(res.value.preview.probed).toBeUndefined();
    expect(res.value.export.probed).toBeUndefined();
    expect(res.value.verify.probed).toBeUndefined();
    expect(res.value.mediaAnalysis.types.videoReview.probed).toBeUndefined();
  });

  it("rejects an unknown domain before any probe starts", async () => {
    const res = await facade["capabilities.get"]({ domain: "nope" as "audio" });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "INVALID_PARAMS", message: expect.stringContaining("domain") },
    });
    expect(probes.audioAnalysisPreflight).not.toHaveBeenCalled();
    expect(probes.opencvToolPreflight).not.toHaveBeenCalled();
  });
});
