import { lstat, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "@reelterminal/core/types/project";
import { DEFAULT_SUBTITLE_STYLE, exportSRT } from "@reelterminal/core/text/subtitle-engine";
import type { Subtitle } from "@reelterminal/core/types/timeline";
import { FacadeError } from "./errors";
import {
  resolveDeliverySidecarDestination,
  type DeliveryDestination,
} from "./delivery";
import { resolveContainedPathDetailed } from "./media/path-roots";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import type { ExportSidecarArtifacts } from "./providers";

export interface PreparedCoverImage {
  readonly path: string;
  readonly codec: "png" | "mjpeg";
}

export interface PreparedSidecarTarget {
  readonly explicitPath?: string;
}

export interface PreparedExportPublishing {
  readonly cover?: PreparedCoverImage;
  readonly subtitlesSrt?: PreparedSidecarTarget;
  readonly chaptersTxt?: PreparedSidecarTarget;
}

function detectImageCodec(header: Uint8Array, readBytes: number): "png" | "mjpeg" | null {
  if (
    readBytes >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "png";
  }
  if (readBytes >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "mjpeg";
  }
  return null;
}

function replaceExtension(filePath: string, nextSuffix: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = ext.length > 0 ? path.basename(filePath, ext) : path.basename(filePath);
  return path.join(dir, `${stem}${nextSuffix}`);
}

async function assertPathDoesNotExist(targetPath: string, fieldName: string, verb: string): Promise<void> {
  try {
    await lstat(targetPath);
    throw new FacadeError(
      "CONFLICT",
      `${verb}: ${fieldName} target already exists — delivery never overwrites`,
      { path: targetPath },
    );
  } catch (error) {
    if (error instanceof FacadeError) throw error;
    // ENOENT / unresolvable target means no conflict yet.
  }
}

export async function prepareExportPublishing(
  options: {
    readonly coverImagePath?: string;
    readonly exportSubtitlesSrt?: boolean | string;
    readonly exportChaptersTxt?: boolean | string;
    readonly mediaRoots: readonly string[];
    readonly deliveryRoots: readonly string[];
    readonly delivery: DeliveryDestination | null;
    readonly verb: string;
  },
): Promise<PreparedExportPublishing> {
  let cover: PreparedCoverImage | undefined;
  if (options.coverImagePath !== undefined) {
    const resolved = resolveContainedPathDetailed(options.coverImagePath, options.mediaRoots);
    if (resolved.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${options.verb}: coverImagePath must resolve inside configured mediaRoots`,
        { path: options.coverImagePath, mediaRoots: [...options.mediaRoots] },
      );
    }
    if (resolved.kind !== "ok") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${options.verb}: coverImagePath cannot be read (missing or unreadable)`,
        { path: options.coverImagePath },
      );
    }
    const info = await stat(resolved.path).catch(() => null);
    if (!info || !info.isFile() || info.size === 0) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${options.verb}: coverImagePath must be a non-empty regular image file`,
        { path: options.coverImagePath },
      );
    }
    const handle = await open(resolved.path, "r");
    let codec: "png" | "mjpeg" | null = null;
    try {
      const buf = new Uint8Array(12);
      const { bytesRead } = await handle.read(buf, 0, 12, 0);
      codec = detectImageCodec(buf, bytesRead);
    } finally {
      await handle.close();
    }
    if (!codec) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${options.verb}: coverImagePath must be a valid PNG or JPEG image`,
        { path: resolved.path },
      );
    }
    try {
      await resolveToolFfmpeg();
    } catch (error) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${options.verb}: coverImagePath requires FFmpeg to mux the attached_pic stream (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    cover = { path: resolved.path, codec };
  }

  let subtitlesSrt: PreparedSidecarTarget | undefined;
  if (typeof options.exportSubtitlesSrt === "string") {
    const dest = await resolveDeliverySidecarDestination(
      options.exportSubtitlesSrt,
      options.deliveryRoots,
      ".srt",
      "exportSubtitlesSrt",
      options.verb,
    );
    subtitlesSrt = { explicitPath: dest.path };
  } else if (options.exportSubtitlesSrt === true) {
    if (options.delivery !== null) {
      await assertPathDoesNotExist(
        replaceExtension(options.delivery.path, ".srt"),
        "exportSubtitlesSrt",
        options.verb,
      );
    }
    subtitlesSrt = {};
  }

  let chaptersTxt: PreparedSidecarTarget | undefined;
  if (typeof options.exportChaptersTxt === "string") {
    const dest = await resolveDeliverySidecarDestination(
      options.exportChaptersTxt,
      options.deliveryRoots,
      ".txt",
      "exportChaptersTxt",
      options.verb,
    );
    chaptersTxt = { explicitPath: dest.path };
  } else if (options.exportChaptersTxt === true) {
    if (options.delivery !== null) {
      await assertPathDoesNotExist(
        replaceExtension(options.delivery.path, ".chapters.txt"),
        "exportChaptersTxt",
        options.verb,
      );
    }
    chaptersTxt = {};
  }

  return {
    ...(cover ? { cover } : {}),
    ...(subtitlesSrt ? { subtitlesSrt } : {}),
    ...(chaptersTxt ? { chaptersTxt } : {}),
  };
}

export async function muxExportCoverImage(
  mp4Path: string,
  cover: PreparedCoverImage,
): Promise<number> {
  const bins = await resolveToolFfmpeg();
  if (!bins) {
    throw new FacadeError("UNSUPPORTED", "export.start: coverImagePath requires ffmpeg");
  }
  const tempPath = `${mp4Path}.cover.tmp.mp4`;
  try {
    await runToolProcess(bins.ffmpeg, [
      "-y",
      "-i",
      mp4Path,
      "-i",
      cover.path,
      "-map",
      "0",
      "-map",
      "1:v:0",
      "-c",
      "copy",
      "-c:v:1",
      cover.codec,
      "-disposition:v:1",
      "attached_pic",
      "-movflags",
      "+faststart",
      tempPath,
    ]);
    const muxedInfo = await stat(tempPath);
    if (!muxedInfo.isFile() || muxedInfo.size === 0) {
      throw new Error("FFmpeg produced an empty cover-muxed MP4");
    }
    await rename(tempPath, mp4Path);
    return muxedInfo.size;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function formatSubtitlesSrtFromProject(project: Project): string {
  const timelineSubs = project.timeline.subtitles ?? [];
  if (timelineSubs.length > 0) {
    return exportSRT(timelineSubs);
  }
  const textClips = project.textClips ?? [];
  if (textClips.length > 0) {
    const sorted = [...textClips].sort((a, b) => a.startTime - b.startTime);
    const converted: Subtitle[] = sorted.map((clip) => ({
      id: clip.id,
      text: clip.text,
      startTime: Math.max(0, clip.startTime),
      endTime: Math.max(0, clip.startTime + Math.max(0.001, clip.duration)),
      style: DEFAULT_SUBTITLE_STYLE,
    }));
    return exportSRT(converted);
  }
  return "";
}

function formatChapterTimestamp(seconds: number, useHours: boolean): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return useHours
    ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}`
    : `${pad(mins)}:${pad(secs)}`;
}

export function formatChaptersTxtFromProject(project: Project): string {
  const entries: Array<{ time: number; label: string }> = [];

  for (const marker of project.timeline.markers ?? []) {
    if (!Number.isFinite(marker.time) || marker.time < 0) continue;
    const label = marker.label.trim() || "Chapter";
    entries.push({ time: marker.time, label });
  }

  for (const pm of project.markers?.items ?? []) {
    let time: number | undefined;
    if (pm.target.kind === "timeRange") {
      time = pm.target.start;
    }
    if (time === undefined || !Number.isFinite(time) || time < 0) continue;
    const label = pm.label?.trim() || `Marker ${pm.number}`;
    entries.push({ time, label });
  }

  if (entries.length === 0) {
    return "";
  }

  entries.sort((a, b) => a.time - b.time);
  if (entries[0]!.time > 0) {
    entries.unshift({ time: 0, label: "Intro" });
  }

  const maxTime = entries[entries.length - 1]!.time;
  const useHours = maxTime >= 3600;
  const lines = entries.map(
    (entry) => `${formatChapterTimestamp(entry.time, useHours)} ${entry.label}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function writeExportSidecars(options: {
  readonly snapshot: Project;
  readonly prepared: PreparedExportPublishing;
  readonly artifactMp4Path: string;
  readonly deliveredMp4Path?: string;
}): Promise<ExportSidecarArtifacts | undefined> {
  const baseMp4 = options.deliveredMp4Path ?? options.artifactMp4Path;
  let subtitlesSrtPath: string | undefined;
  let chaptersTxtPath: string | undefined;

  if (options.prepared.subtitlesSrt) {
    const targetPath =
      options.prepared.subtitlesSrt.explicitPath ?? replaceExtension(baseMp4, ".srt");
    const content = formatSubtitlesSrtFromProject(options.snapshot);
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
    subtitlesSrtPath = targetPath;
  }

  if (options.prepared.chaptersTxt) {
    const targetPath =
      options.prepared.chaptersTxt.explicitPath ?? replaceExtension(baseMp4, ".chapters.txt");
    const content = formatChaptersTxtFromProject(options.snapshot);
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
    chaptersTxtPath = targetPath;
  }

  const hasAttachedCover = options.prepared.cover !== undefined ? true : undefined;
  if (!subtitlesSrtPath && !chaptersTxtPath && !hasAttachedCover) {
    return undefined;
  }
  return {
    ...(subtitlesSrtPath !== undefined ? { subtitlesSrtPath } : {}),
    ...(chaptersTxtPath !== undefined ? { chaptersTxtPath } : {}),
    ...(hasAttachedCover ? { hasAttachedCover } : {}),
  };
}
