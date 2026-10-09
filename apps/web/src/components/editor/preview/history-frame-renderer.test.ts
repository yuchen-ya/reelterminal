// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Track } from "@reelterminal/core";
import type { ProjectNodeRecord } from "../../../services/workspace-manager";
import type { HistoryFrameRendererOptions } from "./history-frame-renderer";

const fixture = vi.hoisted(() => ({
  mediaRecords: [] as Array<{ id: string; blob: Blob }>,
  installedFonts: [] as string[],
  releasedFonts: [] as string[],
}));

vi.mock("../../../services/media-storage", () => ({
  loadProjectMedia: vi.fn(async () => fixture.mediaRecords),
}));

vi.mock("../../../services/project-render-dependencies", () => ({
  installProjectRenderFonts: vi.fn(async (_project: unknown, ownerId: string) => {
    fixture.installedFonts.push(ownerId);
  }),
  releaseProjectRenderFonts: vi.fn((ownerId: string) => {
    fixture.releasedFonts.push(ownerId);
  }),
}));

import { createHistoryFrameRenderer } from "./history-frame-renderer";

interface RecordedCalls {
  drawImage: unknown[][];
  clearRect: number[][];
  fillRect: number[][];
}

function recordingContext(): { ctx: CanvasRenderingContext2D; calls: RecordedCalls } {
  const calls: RecordedCalls = { drawImage: [], clearRect: [], fillRect: [] };
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: (...args: number[]) => calls.clearRect.push(args),
    fillRect: (...args: number[]) => calls.fillRect.push(args),
    drawImage: (...args: unknown[]) => calls.drawImage.push(args),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawFrameWithTransformMarker: true,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function recordingCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

interface FakeVideo extends HTMLVideoElement {
  dispatch(type: string): void;
  releaseCalls: number;
  readyState: number;
}

function fakeVideo(): FakeVideo {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    muted: false,
    preload: "",
    currentTime: 0,
    videoWidth: 320,
    videoHeight: 240,
    readyState: 0,
    src: "",
    releaseCalls: 0,
    addEventListener: ((type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
      // A decoder that reports its metadata as soon as anyone listens keeps
      // the seek path deterministic without real media.
      if (type === "loadeddata") queueMicrotask(() => video.dispatch("loadeddata"));
    }),
    removeEventListener: ((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    pause: vi.fn(() => {
      video.releaseCalls += 1;
    }),
    load: vi.fn(() => {
      video.releaseCalls += 1;
    }),
    removeAttribute: vi.fn(),
    dispatch(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  } as unknown as FakeVideo;
  // Setting currentTime fires "seeked" synchronously like a real decoder would.
  let currentTimeValue = 0;
  Object.defineProperty(video, "currentTime", {
    get: () => currentTimeValue,
    set: (value: number) => {
      currentTimeValue = value;
      video.readyState = 2;
      video.dispatch("seeked");
    },
  });
  return video;
}

function projectFixture(overrides?: {
  duration?: number;
  clip?: Partial<Record<string, unknown>>;
  tracks?: Track[];
}): Project {
  return {
    id: "p1",
    name: "Snapshot",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 320, height: 240, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: {
      tracks: overrides?.tracks ?? [
        {
          id: "t1",
          type: "video",
          name: "V1",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [{
            id: "c1",
            mediaId: "m1",
            trackId: "t1",
            startTime: 0,
            duration: 10,
            inPoint: 0,
            outPoint: 10,
            ...(overrides?.clip ?? {}),
          }],
        },
      ],
      subtitles: [],
      duration: overrides?.duration ?? 10,
      markers: [],
    },
  } as unknown as Project;
}

function nodeFixture(project: Project): ProjectNodeRecord {
  return {
    id: "node-1",
    projectId: "p1",
    parentNodeId: null,
    name: "初剪",
    summary: "",
    createdAt: 0,
    formatVersion: 1,
    project,
    mediaIds: ["m1"],
    missingDependencies: [],
  };
}

function rendererOptions(
  video: FakeVideo,
  urls: { created: string[]; revoked: string[] },
): HistoryFrameRendererOptions {
  return {
    createVideoElement: () => video,
    createObjectUrl: () => {
      const url = `blob:fixture-${urls.created.length}`;
      urls.created.push(url);
      return url;
    },
    revokeObjectUrl: (url: string) => {
      urls.revoked.push(url);
    },
    videoCacheSize: 2,
  };
}

describe("history frame renderer", () => {
  beforeEach(() => {
    fixture.mediaRecords = [{ id: "m1", blob: new Blob(["bytes"]) }];
    fixture.installedFonts = [];
    fixture.releasedFonts = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a frame at the mapped time and sizes the canvas to the snapshot", async () => {
    const video = fakeVideo();
    const urls = { created: [], revoked: [] as string[] };
    const renderer = await createHistoryFrameRenderer(
      "p1",
      nodeFixture(projectFixture()),
      rendererOptions(video, urls),
    );
    const { ctx, calls } = recordingContext();
    const canvas = recordingCanvas(ctx);

    await expect(renderer.renderAt(2.5, canvas)).resolves.toBe("frame");
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(240);
    expect(video.currentTime).toBe(2.5);
    expect(calls.drawImage.some((args) => args[0] === video)).toBe(true);
    renderer.dispose();
  });

  it("maps clip local time through inPoint, speed and the out-point clamp", async () => {
    const video = fakeVideo();
    const urls = { created: [], revoked: [] as string[] };
    const renderer = await createHistoryFrameRenderer(
      "p1",
      nodeFixture(projectFixture({ clip: { inPoint: 1, outPoint: 4, speed: 2 } })),
      rendererOptions(video, urls),
    );
    const canvas = recordingCanvas(recordingContext().ctx);

    await renderer.renderAt(2, canvas);
    // sourceTime = inPoint 1 + (2 - 0) * speed 2 = 5, clamped to outPoint 4.
    expect(video.currentTime).toBe(4);
    renderer.dispose();
  });

  it("reports no-frame beyond the snapshot duration and clears the canvas", async () => {
    const video = fakeVideo();
    const urls = { created: [], revoked: [] as string[] };
    const renderer = await createHistoryFrameRenderer(
      "p1",
      nodeFixture(projectFixture({ duration: 6 })),
      rendererOptions(video, urls),
    );
    const { ctx, calls } = recordingContext();
    const canvas = recordingCanvas(ctx);

    await expect(renderer.renderAt(6.5, canvas)).resolves.toBe("no-frame");
    expect(calls.clearRect.length).toBeGreaterThan(0);
    expect(calls.drawImage).toHaveLength(0);
    renderer.dispose();
  });

  it("still returns a frame when no clip covers the time inside the duration", async () => {
    const video = fakeVideo();
    const urls = { created: [], revoked: [] as string[] };
    const renderer = await createHistoryFrameRenderer(
      "p1",
      nodeFixture(projectFixture({ clip: { startTime: 0, duration: 2, outPoint: 2 } })),
      rendererOptions(video, urls),
    );
    const { ctx, calls } = recordingContext();
    const canvas = recordingCanvas(ctx);

    await expect(renderer.renderAt(5, canvas)).resolves.toBe("frame");
    expect(calls.drawImage).toHaveLength(0);
    expect(calls.fillRect.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it("computes the duration from clips when the snapshot timeline duration is absent", async () => {
    const video = fakeVideo();
    const urls = { created: [], revoked: [] as string[] };
    const renderer = await createHistoryFrameRenderer(
      "p1",
      nodeFixture(projectFixture({ duration: 0 })),
      rendererOptions(video, urls),
    );
    expect(renderer.durationSec).toBe(10);
    const { ctx, calls } = recordingContext();
    await expect(renderer.renderAt(10.5, recordingCanvas(ctx))).resolves.toBe("no-frame");
    expect(calls.drawImage).toHaveLength(0);
    renderer.dispose();
  });

  it("dispose revokes blob urls, releases decoders and stops rendering", async () => {
    const video = fakeVideo();
    const urls = { created: [] as string[], revoked: [] as string[] };
    const renderer = await createHistoryFrameRenderer(
      "p1",
      nodeFixture(projectFixture()),
      rendererOptions(video, urls),
    );
    expect(urls.created).toHaveLength(1);

    // One render acquires the decoder that dispose must release.
    await renderer.renderAt(1, recordingCanvas(recordingContext().ctx));
    renderer.dispose();
    expect(urls.revoked).toEqual(urls.created);
    expect(video.releaseCalls).toBeGreaterThan(0);
    expect(renderer.isDisposed()).toBe(true);
    expect(fixture.releasedFonts).toHaveLength(1);

    const { ctx, calls } = recordingContext();
    await expect(renderer.renderAt(1, recordingCanvas(ctx))).resolves.toBe("no-frame");
    expect(calls.drawImage).toHaveLength(0);
  });
});
