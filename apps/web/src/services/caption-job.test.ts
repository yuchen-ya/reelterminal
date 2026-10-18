import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ state: {} as any, samples: new Float32Array(16000 * 5), decode: vi.fn() }));
vi.mock("../stores/project-store", () => ({ useProjectStore: { getState: () => fixture.state } }));
vi.mock("../utils/load-audio-buffer", () => ({ loadAudioBuffer: fixture.decode }));
vi.mock("../utils/whisper-audio", () => ({ audioBufferToWhisperSamples: () => fixture.samples }));
import { captionChunkEnd, startCaptionJob, cancelCaptionJob, useCaptionJob } from "./caption-job";

beforeEach(() => {
  fixture.samples = new Float32Array(16000 * 5);
  const clip = { id: "clip", mediaId: "media", inPoint: 30, outPoint: 35, startTime: 10, duration: 2.5, speed: 2, audioTrackIndex: 1 };
  const media = { id: "media", blob: new Blob(["audio"]) };
  fixture.state = {
    hasOpenProject: true, project: { id: "project" }, actionExecutor: {},
    getClip: () => clip, getMediaItem: () => media,
    executeActionBatch: vi.fn(() => ({ result: { success: true } })),
  };
  fixture.decode.mockResolvedValue({ duration: 300 });
  Object.defineProperty(window, "reelterminal", { configurable: true, value: { captions: {
    transcribe: vi.fn(async () => [{ text: "hello", startSec: 1, endSec: 3 }]), cancel: vi.fn(async () => {}),
  } } });
  useCaptionJob.setState({ id: null, state: "idle", error: "", progress: 0 });
});

describe("caption job", () => {
  it("uses the selected stream, maps speed and trim, and publishes one undo batch on a fresh track", async () => {
    await startCaptionJob("clip", "auto", "default", 2);
    expect(fixture.decode.mock.lastCall?.[2]).toMatchObject({ audioTrackIndex: 2, respectNoAudioStream: true });
    expect(fixture.state.executeActionBatch).toHaveBeenCalledTimes(1);
    const [actions, options] = fixture.state.executeActionBatch.mock.calls[0];
    expect(actions.map((action: any) => action.type)).toEqual(["track/add", "track/rename", "text/createMany"]);
    expect(actions[2].params.clips[0]).toMatchObject({ startTime: 10.5, duration: 1, metadata: { captionSourceClipId: "clip" } });
    expect(options.historyOwner).toBe("human");
    expect(useCaptionJob.getState().state).toBe("done");
  });

  it("splits long audio into contiguous bounded chunks without losing the tail", async () => {
    fixture.samples = new Float32Array(245 * 16000).fill(0.1);
    fixture.samples.fill(0, 116 * 16000, 117 * 16000);
    expect(captionChunkEnd(fixture.samples, 0)).toBeGreaterThanOrEqual(116 * 16000);
    await startCaptionJob("clip", "auto", "default");
    const calls = vi.mocked(window.reelterminal!.captions!.transcribe).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call[1].length <= 120 * 16000)).toBe(true);
    expect(calls.reduce((sum, call) => sum + call[1].length, 0)).toBe(fixture.samples.length);
  });

  it("does not publish after cancellation during inference", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(window.reelterminal!.captions!.transcribe).mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = startCaptionJob("clip", "auto", "default");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await cancelCaptionJob(); resolve([{ text: "late", startSec: 0, endSec: 2 }]); await pending;
    expect(fixture.state.executeActionBatch).not.toHaveBeenCalled();
    expect(useCaptionJob.getState().state).toBe("cancelled");
  });

  it("rejects a changed project even when inference succeeds", async () => {
    vi.mocked(window.reelterminal!.captions!.transcribe).mockImplementation(async () => {
      fixture.state = { ...fixture.state, project: { id: "other" } };
      return [{ text: "hello", startSec: 0, endSec: 2 }] as any;
    });
    await startCaptionJob("clip", "auto", "default");
    expect(fixture.state.executeActionBatch).not.toHaveBeenCalled();
    expect(useCaptionJob.getState().error).toContain("project changed");
  });

  it("keeps previous captions untouched when a later chunk fails", async () => {
    fixture.samples = new Float32Array(125 * 16000);
    vi.mocked(window.reelterminal!.captions!.transcribe).mockResolvedValueOnce([{ text: "first", startSec: 0, endSec: 2 }] as any).mockRejectedValueOnce(new Error("worker failed"));
    await startCaptionJob("clip", "auto", "default");
    expect(fixture.state.executeActionBatch).not.toHaveBeenCalled();
    expect(useCaptionJob.getState().state).toBe("error");
  });
});
