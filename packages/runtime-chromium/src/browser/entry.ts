/**
 * Browser-side entry for the Chromium render runtime (ADR 0002 #2).
 *
 * This file is bundled to a single ESM by esbuild (node/bundle.ts) and loaded
 * into a bare Playwright page. It is the ONLY browser-side code Slice 1b
 * adds: a minimal render worker that reuses the existing core engines —
 * VideoEngine (OffscreenCanvas compositor), TitleEngine (text rasterizer),
 * ExportEngine + WebCodecsBackend + mediabunny (MP4 muxing).
 *
 * Hydration contract: the canonical serialized Project is the authority.
 * `hydrate()` rebuilds engine-side overlay state (titleEngine.loadTextClips,
 * graphicsEngine.loadSVGClips) from `project.textClips` / `project.svgClips`
 * and re-attaches media as disk-backed File objects
 * (assigned by Playwright to the page's file input — videos are NEVER pushed
 * through evaluate/base64).
 *
 * Node ↔ page bridge (injected via page.exposeFunction by the host):
 *   __exportSeek(position) / __exportWrite(base64) / __exportClose()
 *   __exportAbort() / __exportProgress(json)
 * All output bytes flow OUT through these bindings as bounded chunks and are
 * written to disk by the Node host.
 */
import { getSpeedEngine } from "@openreel/core/video/speed-engine";
import { getVideoEngine } from "@openreel/core/video/video-engine";
import { getExportEngine } from "@openreel/core/export/export-engine";
import { DEFAULT_UPSCALING_SETTINGS } from "@openreel/core/export/types";
import { titleEngine } from "@openreel/core/text/title-engine";
import { graphicsEngine } from "@openreel/core/graphics/graphics-engine";
import type { Project } from "@openreel/core/types/project";

declare global {
  interface Window {
    __openreelRender: OpenreelRenderApi;
    __exportSeek?: (position: number) => Promise<void>;
    __exportWrite?: (base64: string) => Promise<void>;
    __exportClose?: () => Promise<void>;
    __exportAbort?: () => Promise<void>;
    __exportProgress?: (json: string) => Promise<void>;
  }
}

const MEDIA_INPUT_ID = "__openreel-media";

interface HydrateReport {
  ok: boolean;
  mediaAttached: number;
  mediaMissing: string[];
  textClipsLoaded: number;
  svgClipsLoaded: number;
  error?: string;
}

let currentProject: Project | null = null;

/* ------------------------------ utilities ------------------------------ */

function u8ToBase64(u8: Uint8Array): string {
  // Chunked to avoid call-stack limits on multi-MB buffers.
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return u8ToBase64(buf);
}

function mediaInput(): HTMLInputElement | null {
  return document.getElementById(MEDIA_INPUT_ID) as HTMLInputElement | null;
}

/* ------------------------------ hydrate ------------------------------ */

/**
 * Rebuild render state from the canonical project. `mediaIds` is the ordered
 * list of mediaIds whose disk-backed Files were assigned to the page's file
 * input by the host (order matches the input's FileList).
 */
async function hydrate(
  projectJson: string,
  mediaIds: string[],
): Promise<HydrateReport> {
  try {
    const project = JSON.parse(projectJson) as Project;
    const input = mediaInput();
    const files = input?.files ? Array.from(input.files) : [];
    const missing: string[] = [];
    let attached = 0;

    mediaIds.forEach((id, index) => {
      const item = project.mediaLibrary.items.find((m) => m.id === id);
      const file = files[index] as File | undefined;
      if (item && file) {
        // Disk-backed File: the browser reads slices on demand; the video
        // is never buffered wholesale into page memory.
        (item as { blob: Blob | null }).blob = file;
        attached += 1;
      } else {
        missing.push(id);
      }
    });

    // Canonical overlay hydration: project.textClips is the authority; the
    // render path reads ONLY the titleEngine singleton.
    titleEngine.loadTextClips(project.textClips ?? []);
    titleEngine.initialize(project.settings.width, project.settings.height);

    // Same canonical hydration for SVG overlays: the VideoEngine compositor
    // reads SVG clips ONLY from the graphicsEngine singleton
    // (getActiveSVGClips), so without this load every preview frame and
    // export rendered by this headless page silently dropped all SVG
    // overlays even though they exist in the canonical project.
    graphicsEngine.loadSVGClips(project.svgClips ?? []);

    getSpeedEngine().loadClips(project.timeline.tracks.flatMap((track) => track.clips));
    const videoEngine = getVideoEngine();
    await videoEngine.initialize();
    // Drop every cached decode: mediaIds repeat across projects, and a stale
    // cached frame would silently serve the previous project's pixels.
    videoEngine.clearCache();
    videoEngine.clearVideoElementCache();

    currentProject = project;
    return {
      ok: missing.length === 0,
      mediaAttached: attached,
      mediaMissing: missing,
      textClipsLoaded: (project.textClips ?? []).length,
      svgClipsLoaded: (project.svgClips ?? []).length,
    };
  } catch (error) {
    currentProject = null;
    return {
      ok: false,
      mediaAttached: 0,
      mediaMissing: [],
      textClipsLoaded: 0,
      svgClipsLoaded: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------ render ------------------------------ */

/** Render one composited frame and return it as PNG bytes (base64). */
async function renderPngBase64(
  timeSec: number,
  width: number,
  height: number,
  region?: { x: number; y: number; width: number; height: number },
): Promise<string> {
  if (!currentProject) throw new Error("hydrate() must be called first");
  const engine = getVideoEngine();
  if (region && (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1)) throw new Error("Invalid normalized region");
  const scale = Math.min(1, 4096 / Math.max(currentProject.settings.width, currentProject.settings.height));
  const rw = region ? Math.max(2, Math.round(currentProject.settings.width * scale)) : width;
  const rh = region ? Math.max(2, Math.round(currentProject.settings.height * scale)) : height;
  const rendered = await engine.renderFrame(currentProject, timeSec, rw, rh);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context on OffscreenCanvas");
    if (region) {
      const sw = rw * region.width, sh = rh * region.height;
      const fit = Math.min(width / sw, height / sh);
      ctx.drawImage(rendered.image, rw * region.x, rh * region.y, sw, sh, (width - sw * fit) / 2, (height - sh * fit) / 2, sw * fit, sh * fit);
    } else ctx.drawImage(rendered.image, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await blobToBase64(blob);
  } finally {
    rendered.image.close();
  }
}

/** Compose a bounded real PNG contact sheet from the same rendered frames. */
async function renderContactSheetBase64(request: {
  samples: Array<{ timeSec: number; label: string }>;
  width: number;
  height: number;
}): Promise<string> {
  if (!currentProject) throw new Error("hydrate() must be called first");
  if (request.samples.length < 1 || request.samples.length > 12) {
    throw new Error("contact sheet sample count must be in [1, 12]");
  }
  const padding = 8;
  const labelHeight = 28;
  const columns = Math.min(4, request.samples.length);
  const rows = Math.ceil(request.samples.length / columns);
  const sheetWidth = columns * (request.width + padding) + padding;
  const sheetHeight = rows * (request.height + labelHeight + padding) + padding;
  // Keep browser canvas allocation bounded even if a provider caller is
  // bypassed. The facade enforces the same budget before invoking us.
  if (sheetWidth * sheetHeight > 24_000_000) {
    throw new Error("contact sheet exceeds the 24-megapixel runtime budget");
  }
  const canvas = new OffscreenCanvas(sheetWidth, sheetHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context on OffscreenCanvas");
  ctx.fillStyle = "#101318";
  ctx.fillRect(0, 0, sheetWidth, sheetHeight);
  ctx.font = "14px sans-serif";
  ctx.textBaseline = "top";
  for (const [index, sample] of request.samples.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = padding + column * (request.width + padding);
    const y = padding + row * (request.height + labelHeight + padding);
    const label = sample.label.length > 72 ? `${sample.label.slice(0, 69)}…` : sample.label;
    ctx.fillStyle = "#f5f7fa";
    ctx.fillText(label, x, y);
    const frameBase64 = await renderPngBase64(sample.timeSec, request.width, request.height);
    const binary = atob(frameBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      ctx.drawImage(bitmap, x, y + labelHeight, request.width, request.height);
    } finally {
      bitmap.close();
    }
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToBase64(blob);
}

/* ------------------------------ export (WebCodecs route) ------------------------------ */

/**
 * A FileSystemWritableFileStream-shaped shim: WebCodecsBackend only needs
 * seek/write/close/abort. Every chunk is forwarded to the Node host, which
 * writes it to disk at the tracked position (bounded 4 MiB chunks — the
 * whole MP4 never accumulates in page memory).
 */
function makeStreamingWritable() {
  return {
    async seek(position: number): Promise<void> {
      if (!window.__exportSeek) throw new Error("host binding __exportSeek missing");
      await window.__exportSeek(position);
    },
    async write(data: ArrayBuffer | ArrayBufferView): Promise<void> {
      if (!window.__exportWrite) throw new Error("host binding __exportWrite missing");
      const u8 =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      await window.__exportWrite(u8ToBase64(u8));
    },
    async close(): Promise<void> {
      if (!window.__exportClose) throw new Error("host binding __exportClose missing");
      await window.__exportClose();
    },
    async abort(): Promise<void> {
      if (window.__exportAbort) await window.__exportAbort();
    },
  };
}

export interface WebcodecsExportOutcome {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  framesRendered?: number;
  bytesWritten?: number;
}

/** Drive the existing ExportEngine over the streaming shim. */
async function exportToMp4Webcodecs(settings: {
  width: number;
  height: number;
  frameRate: number;
  videoBitrateKbps: number;
  upscaling?: {
    enabled: boolean;
    quality?: "fast" | "balanced" | "quality";
  };
}): Promise<WebcodecsExportOutcome> {
  if (!currentProject) throw new Error("hydrate() must be called first");
  const engine = getExportEngine();
  await engine.initialize();

  const writable = makeStreamingWritable();
  const generator = engine.exportVideo(
    currentProject,
    {
      format: "mp4",
      codec: "h264",
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      bitrate: settings.videoBitrateKbps,
      // Spread straight into the core VideoExportSettings merge — the
      // engine consumes upscaling natively; when WebGPU is unavailable the
      // pass is skipped and the host discloses that on the job (the engine
      // never fails the export over it). sharpening is not part of the
      // agent-facing settings surface; the shared engine default applies.
      ...(settings.upscaling !== undefined
        ? {
            upscaling: {
              enabled: settings.upscaling.enabled,
              quality: settings.upscaling.quality ?? "balanced",
              sharpening: DEFAULT_UPSCALING_SETTINGS.sharpening,
            },
          }
        : {}),
    },
    writable as unknown as FileSystemWritableFileStream,
  );

  let step = await generator.next();
  while (!step.done) {
    if (window.__exportProgress) {
      await window.__exportProgress(JSON.stringify(step.value));
    }
    step = await generator.next();
  }
  const result = step.value;
  return {
    success: result.success,
    ...(result.error
      ? { errorCode: result.error.code, errorMessage: result.error.message }
      : {}),
    ...(result.stats
      ? { framesRendered: result.stats.framesRendered, bytesWritten: result.stats.fileSize }
      : {}),
  };
}

/** Cooperative cancellation: the engine checks the flag between frames. */
function abortExport(): void {
  getExportEngine().cancel();
}

/* ------------------------------ probe ------------------------------ */

const DECODE_CODECS = [
  "avc1.42001f",
  "avc1.4d0028",
  "avc1.640028",
  "vp8",
  "vp09.00.10.08",
  "av01.0.04M.08",
] as const;

const ENCODE_CODECS = ["avc1.42001f", "avc1.640028", "vp8", "vp09.00.10.08"] as const;

async function decodeSampleSmoke(): Promise<Record<string, unknown> | null> {
  const input = mediaInput();
  const file = input?.files?.[0];
  if (!file) return null;
  try {
    const mb = await import("mediabunny");
    const source = new mb.Input({
      source: new mb.BlobSource(file),
      formats: mb.ALL_FORMATS,
    });
    try {
      const track = await source.getPrimaryVideoTrack();
      if (!track) return { attempted: true, ok: false, reason: "no-video-track" };
      const codec = track.codec ?? "unknown";
      const canDecode = await track.canDecode();
      if (!canDecode) {
        return { attempted: true, ok: false, codec, reason: "cannot-decode" };
      }
      const sink = new mb.VideoSampleSink(track);
      const sample = await sink.getSample(0);
      if (!sample) {
        return { attempted: true, ok: false, codec, reason: "no-sample" };
      }
      const report = {
        attempted: true,
        ok: true,
        codec,
        width: sample.displayWidth,
        height: sample.displayHeight,
        timestampSec: sample.timestamp,
      };
      sample.close();
      return report;
    } finally {
      source[Symbol.dispose]?.();
    }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probe(): Promise<Record<string, unknown>> {
  const facts: Record<string, unknown> = {};
  const errors: string[] = [];

  facts.offscreenCanvas = typeof OffscreenCanvas !== "undefined";
  try {
    const canvas = new OffscreenCanvas(8, 8);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 8, 8);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    facts.offscreenPngEncode = blob.size > 0;
  } catch (error) {
    facts.offscreenPngEncode = false;
    errors.push(`offscreen png smoke: ${error instanceof Error ? error.message : error}`);
  }

  const videoDecoder: Record<string, boolean> = {};
  if (typeof VideoDecoder !== "undefined") {
    for (const codec of DECODE_CODECS) {
      try {
        videoDecoder[codec] =
          (await VideoDecoder.isConfigSupported({ codec })).supported === true;
      } catch {
        videoDecoder[codec] = false;
      }
    }
  }
  facts.videoDecoder = videoDecoder;

  const videoEncoder: Record<string, boolean> = {};
  if (typeof VideoEncoder !== "undefined") {
    for (const codec of ENCODE_CODECS) {
      for (const pref of ["prefer-hardware", "prefer-software"] as const) {
        try {
          const support = await VideoEncoder.isConfigSupported({
            codec,
            width: 320,
            height: 180,
            bitrate: 1_000_000,
            framerate: 30,
            hardwareAcceleration: pref,
          });
          videoEncoder[`${codec}/${pref}`] = support.supported === true;
        } catch {
          videoEncoder[`${codec}/${pref}`] = false;
        }
      }
    }
  }
  facts.videoEncoder = videoEncoder;

  if (typeof AudioEncoder !== "undefined") {
    try {
      facts.audioEncoderAac =
        (
          await AudioEncoder.isConfigSupported({
            codec: "mp4a.40.2",
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 128_000,
          })
        ).supported === true;
    } catch {
      facts.audioEncoderAac = false;
    }
  } else {
    facts.audioEncoderAac = null;
  }

  try {
    await getVideoEngine().initialize();
    facts.videoEngineInit = true;
  } catch (error) {
    facts.videoEngineInit = false;
    errors.push(`video engine init: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const exportEngine = getExportEngine();
    await exportEngine.initialize();
    facts.exportEngineInit = true;
    facts.webCodecsSupported = exportEngine.isWebCodecsSupported();
    facts.mediabunnyLoaded = exportEngine.isMediaBunnyAvailable();
  } catch (error) {
    facts.exportEngineInit = false;
    errors.push(`export engine init: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const mb = await import("mediabunny");
    const encodeOptions = { width: 320, height: 180, bitrate: 1_000_000 };
    facts.firstEncodableVideo = {
      avc: await mb.getFirstEncodableVideoCodec(["avc"], encodeOptions),
      vp9: await mb.getFirstEncodableVideoCodec(["vp9"], encodeOptions),
      vp8: await mb.getFirstEncodableVideoCodec(["vp8"], encodeOptions),
    };
  } catch (error) {
    facts.firstEncodableVideo = null;
    errors.push(`mediabunny encode probe: ${error instanceof Error ? error.message : error}`);
  }

  // WebGPU adapter probe — the fact the export upscaling pass depends on.
  // A real requestAdapter (the same call the upscaling engine's GPU device
  // needs), not a mere typeof check; null when it cannot be decided.
  if (typeof navigator !== "undefined" && "gpu" in navigator) {
    try {
      const adapter = await (navigator as never as {
        gpu: { requestAdapter(): Promise<unknown> };
      }).gpu.requestAdapter();
      facts.webgpuAdapter = adapter !== null && adapter !== undefined;
    } catch (error) {
      facts.webgpuAdapter = null;
      errors.push(`webgpu probe: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    facts.webgpuAdapter = null;
  }

  facts.decodeSample = await decodeSampleSmoke();
  facts.errors = errors;
  return facts;
}

/* ------------------------------ api ------------------------------ */

const api: OpenreelRenderApi = {
  hydrate,
  renderPngBase64,
  renderContactSheetBase64,
  exportToMp4Webcodecs,
  abortExport,
  probe,
};

export interface OpenreelRenderApi {
  hydrate(projectJson: string, mediaIds: string[]): Promise<HydrateReport>;
  renderPngBase64(timeSec: number, width: number, height: number): Promise<string>;
  renderContactSheetBase64(request: {
    samples: Array<{ timeSec: number; label: string }>;
    width: number;
    height: number;
  }): Promise<string>;
  exportToMp4Webcodecs(settings: {
    width: number;
    height: number;
    frameRate: number;
    videoBitrateKbps: number;
  }): Promise<WebcodecsExportOutcome>;
  abortExport(): void;
  probe(): Promise<Record<string, unknown>>;
}

window.__openreelRender = api;
