import type {
  Clip,
  MediaRecord,
  Project,
  ShapeClip,
  StickerClip,
  SVGClip,
  TextClip,
  Track,
} from "@reelterminal/core";
import { loadProjectMedia } from "../../../services/media-storage";
import {
  installProjectRenderFonts,
  releaseProjectRenderFonts,
} from "../../../services/project-render-dependencies";
import type { ProjectNodeRecord } from "../../../services/workspace-manager";
import {
  drawFrameWithTransform,
  getActiveShapeClips,
  getActiveSubtitles,
  getActiveTextClips,
  getAnimatedTransform,
  getTransitionAtTime,
  renderShapeClipToCanvas,
  renderSubtitleToCanvas,
  renderTextClipToCanvas,
  renderTransitionCanvas,
} from "./canvas-renderers";
import { compareTracksForComposite, type IndexedTrack } from "./composite-track-order";
import type { ClipTransform } from "./types";

/**
 * Read-only frame renderer for one immutable version node snapshot
 * (docs/VERSION-NODES-UX.md "播放器对比历史版本"). It renders the snapshot's
 * own picture at a mapped time WITHOUT restoring the node, switching the
 * workspace or touching the editing project: media is resolved once through
 * loadProjectMedia, the clip layout is precomputed from node.project, and
 * every render writes into a caller-provided canvas sized to the snapshot's
 * project dimensions (the comparison panel scales each side via CSS).
 *
 * v1 layer coverage: video/image clips (base layer), text, graphics
 * (shape/svg/sticker), subtitles and transitions. Complex GPU effects render
 * their base layer without the effect (accepted v1 limitation), and the
 * canvas output is silent — the history side never produces audio.
 */

export type HistoryFrameResult = "frame" | "no-frame";

export interface HistoryFrameRenderer {
  readonly projectId: string;
  readonly nodeId: string;
  /** Snapshot timeline duration in seconds (mapped times at/after this are "no-frame"). */
  readonly durationSec: number;
  /** Snapshot project dimensions; renderAt sizes the target canvas to these. */
  readonly width: number;
  readonly height: number;
  /**
   * Bumped when an async decode completes outside renderAt (e.g. an image
   * finished loading) so polling callers know a re-render can improve the
   * picture without the mapped time changing.
   */
  readonly revision: number;
  /**
   * Draw the snapshot at timeSec into the canvas. Returns "no-frame" when
   * timeSec is outside [0, durationSec) — the caller must show an honest
   * "no picture here" notice instead of freezing on the last frame — or
   * when the renderer was disposed. Inside the duration a time covered by
   * zero clips renders an empty canvas and still counts as a "frame".
   */
  renderAt(
    timeSec: number,
    canvas: HTMLCanvasElement | OffscreenCanvas,
  ): Promise<HistoryFrameResult>;
  isDisposed(): boolean;
  /** Revoke blob URLs, release video decoders and drop caches. Idempotent. */
  dispose(): void;
}

export interface HistoryFrameRendererOptions {
  /** Test seam: build the video element used to decode one media blob. */
  createVideoElement?: (url: string) => HTMLVideoElement;
  /** Test seam: object URL creation (defaults to URL.createObjectURL). */
  createObjectUrl?: (blob: Blob) => string;
  /** Test seam: object URL revocation (defaults to URL.revokeObjectURL). */
  revokeObjectUrl?: (url: string) => void;
  /** Upper bound for waiting on decode/seek events, in milliseconds. */
  eventTimeoutMs?: number;
  /** LRU cap for held video decoders (default 2). */
  videoCacheSize?: number;
}

type GraphicClip = ShapeClip | SVGClip | StickerClip;

interface MediaUrl {
  readonly url: string;
  readonly revoke: boolean;
}

interface VideoCacheEntry {
  readonly mediaId: string;
  readonly video: HTMLVideoElement;
  readonly url: string;
  readonly revoke: boolean;
}

const EPSILON = 1e-4;

function get2DContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): CanvasRenderingContext2D | null {
  const context = canvas.getContext("2d");
  return context
    ? (context as unknown as CanvasRenderingContext2D)
    : null;
}

export async function createHistoryFrameRenderer(
  projectId: string,
  node: ProjectNodeRecord,
  options: HistoryFrameRendererOptions = {},
): Promise<HistoryFrameRenderer> {
  const createObjectUrl =
    options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl =
    options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const eventTimeoutMs = options.eventTimeoutMs ?? 4000;
  const videoCacheSize = options.videoCacheSize ?? 2;

  // Resolve the snapshot's media ONCE (doc: 对比读取独立只读快照). Missing
  // blobs surface as skipped clips, not as a failed comparison.
  const mediaRecords: MediaRecord[] = node.mediaIds.length
    ? await loadProjectMedia(projectId, node.mediaIds)
    : [];
  const urlByMediaId = new Map<string, MediaUrl>();
  for (const record of mediaRecords) {
    if (urlByMediaId.has(record.id)) continue;
    if (record.blob) {
      urlByMediaId.set(record.id, { url: createObjectUrl(record.blob), revoke: true });
    } else if (record.contentUrl) {
      urlByMediaId.set(record.id, { url: record.contentUrl, revoke: false });
    }
  }

  // Snapshot fonts so text clips render with the bytes captured at save time.
  const fontOwnerId = `history-frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await installProjectRenderFonts(node.project, fontOwnerId);
  } catch {
    // Text falls back to the default family; comparison still renders.
  }

  const project: Project = node.project;
  const width = project.settings.width;
  const height = project.settings.height;
  // The snapshot's timeline duration is authoritative for "no picture here":
  // only when it is absent do we infer it from clip/subtitle extents.
  const computedMaxEnd = (time: number, clip: Clip | TextClip | GraphicClip): number =>
    Math.max(time, clip.startTime + clip.duration);

  let computedDuration = 0;
  const sortedTracks: Array<IndexedTrack<Track>> = project.timeline.tracks
    .map((track, originalIndex) => ({ track, originalIndex }))
    .filter(({ track }) => track.type !== "audio" && !track.hidden)
    .sort(compareTracksForComposite);
  for (const { track } of sortedTracks) {
    if (track.type === "audio") continue;
    for (const clip of track.clips) computedDuration = computedMaxEnd(computedDuration, clip);
  }
  for (const clip of project.textClips ?? []) computedDuration = computedMaxEnd(computedDuration, clip);
  for (const clip of [
    ...(project.shapeClips ?? []),
    ...(project.svgClips ?? []),
    ...(project.stickerClips ?? []),
  ]) {
    computedDuration = computedMaxEnd(computedDuration, clip);
  }
  for (const subtitle of project.timeline.subtitles) {
    computedDuration = Math.max(computedDuration, subtitle.endTime);
  }
  const durationSec = project.timeline.duration > 0 ? project.timeline.duration : computedDuration;

  const images = new Map<string, HTMLImageElement>();
  // drawFrameWithTransform draws bitmaps/videos/canvases, so decoded image
  // media is held as an ImageBitmap (released on dispose).
  const imageBitmaps = new Map<string, ImageBitmap>();
  const videoCache = new Map<string, VideoCacheEntry>();
  let revision = 0;
  let disposed = false;

  const bumpRevision = () => {
    revision += 1;
  };

  const acquireVideo = (mediaId: string): VideoCacheEntry | null => {
    const media = urlByMediaId.get(mediaId);
    if (!media) return null;
    const existing = videoCache.get(mediaId);
    if (existing) {
      // LRU refresh: re-insert so the oldest entry is evicted first.
      videoCache.delete(mediaId);
      videoCache.set(mediaId, existing);
      return existing;
    }
    let video: HTMLVideoElement;
    try {
      video = options.createVideoElement
        ? options.createVideoElement(media.url)
        : document.createElement("video");
    } catch {
      return null;
    }
    video.muted = true;
    video.preload = "auto";
    video.addEventListener("loadeddata", bumpRevision);
    video.src = media.url;
    const entry: VideoCacheEntry = {
      mediaId,
      video,
      url: media.url,
      revoke: media.revoke,
    };
    videoCache.set(mediaId, entry);
    while (videoCache.size > videoCacheSize) {
      const oldestKey = videoCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = videoCache.get(oldestKey);
      if (oldest) releaseVideoEntry(oldest);
    }
    return entry;
  };

  function releaseVideoEntry(entry: VideoCacheEntry): void {
    videoCache.delete(entry.mediaId);
    try {
      entry.video.removeEventListener("loadeddata", bumpRevision);
      entry.video.pause();
      entry.video.removeAttribute("src");
      entry.video.load();
    } catch {
      // Releasing a decoder must never break the render loop.
    }
  }

  const waitForEvent = (video: HTMLVideoElement, event: string): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener(event, done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, eventTimeoutMs);
      video.addEventListener(event, done, { once: true });
    });

  const seekVideo = async (video: HTMLVideoElement, target: number): Promise<void> => {
    if (video.readyState < 2) await waitForEvent(video, "loadeddata");
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < EPSILON) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener("seeked", done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, eventTimeoutMs);
      video.addEventListener("seeked", done);
      try {
        video.currentTime = target;
      } catch {
        done();
      }
    });
  };

  const acquireImage = (mediaId: string): HTMLImageElement | null => {
    const media = urlByMediaId.get(mediaId);
    if (!media) return null;
    let image = images.get(mediaId);
    if (!image) {
      image = new Image();
      image.addEventListener("load", bumpRevision);
      image.src = media.url;
      images.set(mediaId, image);
    }
    return image;
  };

  const clipSourceTime = (clip: Clip, timeSec: number): number => {
    const localTime = Math.max(0, timeSec - clip.startTime);
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    return Math.max(clip.inPoint, Math.min(clip.outPoint, clip.inPoint + localTime * speed));
  };

  /**
   * Draw one video/image clip layer. Returns false when the media or its
   * decoded frame is unavailable (the layer is skipped, as in the live
   * preview's decode-failure path).
   */
  const drawMediaClipLayer = async (
    ctx: CanvasRenderingContext2D,
    clip: Clip,
    track: Track,
    timeSec: number,
    target: HTMLCanvasElement | OffscreenCanvas,
  ): Promise<boolean> => {
    if (!urlByMediaId.has(clip.mediaId)) return false;
    let source: HTMLVideoElement | ImageBitmap | null = null;
    if (track.type === "image") {
      const image = acquireImage(clip.mediaId);
      if (image && image.complete && image.naturalWidth > 0) {
        let bitmap = imageBitmaps.get(clip.mediaId);
        if (!bitmap) {
          try {
            bitmap = await createImageBitmap(image);
            imageBitmaps.set(clip.mediaId, bitmap);
          } catch {
            bitmap = undefined;
          }
        }
        if (bitmap) source = bitmap;
      }
    } else {
      const entry = acquireVideo(clip.mediaId);
      if (entry) {
        await seekVideo(entry.video, clipSourceTime(clip, timeSec));
        if (entry.video.videoWidth > 0) source = entry.video;
      }
    }
    if (!source) return false;
    const localTime = timeSec - clip.startTime;
    const transform = getAnimatedTransform(
      clip.transform as ClipTransform,
      clip.keyframes,
      localTime,
    );
    // v1: per-clip GPU effects/color grading render their base layer only.
    drawFrameWithTransform(ctx, source, transform, target.width, target.height);
    return true;
  };

  const renderClipToTempCanvas = async (
    clip: Clip,
    track: Track,
    timeSec: number,
  ): Promise<HTMLCanvasElement | null> => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = get2DContext(canvas);
    if (!ctx) return null;
    const drawn = await drawMediaClipLayer(ctx, clip, track, timeSec, canvas);
    return drawn ? canvas : null;
  };

  const renderer: HistoryFrameRenderer = {
    projectId,
    nodeId: node.id,
    durationSec,
    width,
    height,
    get revision() {
      return revision;
    },
    isDisposed: () => disposed,
    async renderAt(timeSec, canvas) {
      if (disposed) return "no-frame";
      const time = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ctx = get2DContext(canvas);
      if (!ctx) return "frame";
      if (time >= durationSec + EPSILON || durationSec <= 0) {
        // Outside the snapshot: clear instead of freezing on the last frame.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return "no-frame";
      }

      const background = project.timeline.backgroundFillMode === "color"
        ? project.timeline.layoutBackgroundColor ?? "#000000"
        : "#000000";
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();

      const videoTracks = sortedTracks.filter(
        ({ track }) => track.type === "video" || track.type === "image",
      );

      // Transition frames blend the two adjacent clip layers; when the bridge
      // is unavailable getTransitionAtTime returns null and both clips draw as
      // a hard cut (same fallback as the live preview).
      const transitionInfo = getTransitionAtTime(
        time,
        project.timeline.tracks as Parameters<typeof getTransitionAtTime>[1],
      );
      if (transitionInfo && transitionInfo.clipB) {
        const track = project.timeline.tracks.find((candidate) =>
          candidate.clips.some((clip) => clip.id === transitionInfo.clipA.id),
        );
        if (track) {
          const outgoing = await renderClipToTempCanvas(transitionInfo.clipA as Clip, track, time);
          const incoming = await renderClipToTempCanvas(transitionInfo.clipB as Clip, track, time);
          if (outgoing && incoming) {
            try {
              const blended = await renderTransitionCanvas(transitionInfo, outgoing, incoming);
              ctx.drawImage(blended, 0, 0, canvas.width, canvas.height);
            } catch {
              ctx.drawImage(transitionInfo.progress < 0.5 ? outgoing : incoming, 0, 0);
            }
          } else if (outgoing || incoming) {
            ctx.drawImage((outgoing ?? incoming) as HTMLCanvasElement, 0, 0);
          }
        }
      } else {
        for (const { track } of videoTracks) {
          for (const clip of track.clips) {
            if (time < clip.startTime || time >= clip.startTime + clip.duration) continue;
            await drawMediaClipLayer(ctx, clip, track, time, canvas);
          }
        }
      }

      // Overlay tracks paint after video (compareTracksForComposite order).
      const graphics = [
        ...(project.shapeClips ?? []),
        ...(project.svgClips ?? []),
        ...(project.stickerClips ?? []),
      ];
      for (const { track } of sortedTracks) {
        if (track.type === "graphics") {
          for (const shapeClip of getActiveShapeClips(
            graphics.filter((clip) => clip.trackId === track.id),
            time,
          )) {
            renderShapeClipToCanvas(ctx, shapeClip, canvas.width, canvas.height, time);
          }
        } else if (track.type === "text") {
          for (const textClip of getActiveTextClips(
            (project.textClips ?? []).filter((clip) => clip.trackId === track.id),
            time,
          )) {
            renderTextClipToCanvas(ctx, textClip, canvas.width, canvas.height, time);
          }
        }
      }

      for (const subtitle of getActiveSubtitles(project.timeline.subtitles, time)) {
        renderSubtitleToCanvas(ctx, subtitle, canvas.width, canvas.height, time);
      }

      return "frame";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...videoCache.values()]) releaseVideoEntry(entry);
      videoCache.clear();
      for (const bitmap of imageBitmaps.values()) {
        try {
          bitmap.close();
        } catch {
          // Best-effort cleanup.
        }
      }
      imageBitmaps.clear();
      images.clear();
      for (const media of urlByMediaId.values()) {
        if (media.revoke) {
          try {
            revokeObjectUrl(media.url);
          } catch {
            // Best-effort cleanup.
          }
        }
      }
      urlByMediaId.clear();
      releaseProjectRenderFonts(fontOwnerId);
    },
  };

  return renderer;
}
