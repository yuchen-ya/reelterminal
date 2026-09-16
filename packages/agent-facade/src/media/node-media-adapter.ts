/**
 * Node media adapter: probes real metadata of local media files with
 * mediabunny. Pure Node — no DOM, no WebCodecs, no Electron. Unlike the
 * browser engine (`packages/core/src/media/mediabunny-engine.ts`) this never
 * calls `track.canDecode()`, because `VideoDecoder` does not exist in Node;
 * mediabunny's demuxer-level probing is fully isomorphic.
 *
 * Images (PNG/JPEG/GIF/WebP — the GUI's accepted set) never reach mediabunny,
 * which only demuxes audio/video containers: they are classified by the same
 * extension whitelist as the GUI, content-sniffed via magic bytes, and have
 * their dimensions parsed from the file header (`./image-probe`). This mirrors
 * the GUI's `extractImageMetadata` shape: duration 0, frameRate 0, empty
 * codec, no video/audio tracks, no waveform.
 *
 * Memory contract: probing STREAMS from disk via mediabunny's FilePathSource
 * (bounded internal cache, 8 MiB by default) — the file is never read into
 * memory in full. The Input is explicitly disposed so the underlying file
 * handle is always released, and the file size comes from `stat`, not from
 * a byte buffer. The image branch performs one bounded header read.
 */
import { stat } from "node:fs/promises";
import { Input, ALL_FORMATS, FilePathSource } from "mediabunny";
import type { InputAudioTrack, InputVideoTrack } from "mediabunny";
import type { ImportedMediaMetadata } from "../types";
import {
  classifyImageExtension,
  readImageHeaderFacts,
} from "./image-probe";

export interface ProbedMedia extends ImportedMediaMetadata {
  readonly type: "video" | "audio" | "image";
  readonly mimeType: string;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/** Wraps any low-level failure into an Error naming the offending file. */
function toProbeError(absPath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to probe media file "${absPath}": ${message}`);
}

/** Extracts display dimensions, codec and best-effort packet rate. */
async function videoTrackFacts(
  track: InputVideoTrack,
): Promise<{ width: number; height: number; codec: string; frameRate: number }> {
  let frameRate = 0;
  // Best-effort average packet rate over up to ~100 packets; probing stays
  // non-fatal if stats cannot be computed.
  try {
    const stats = await track.computePacketStats(100);
    frameRate = stats.averagePacketRate || 0;
  } catch {
    frameRate = 0;
  }
  return {
    width: track.displayWidth,
    height: track.displayHeight,
    codec: track.codec ?? "",
    frameRate,
  };
}

/**
 * Probes a local file's real container/track metadata via mediabunny,
 * streaming reads from disk (FilePathSource) instead of buffering the file.
 * Image files take the header-parse branch instead (see the module doc).
 *
 * Throws an `Error` (with a clear, path-bearing message) when the file cannot
 * be read or is not a recognizable media file.
 */
export async function probeLocalMediaFile(
  absPath: string,
): Promise<ProbedMedia> {
  let fileSize: number;
  try {
    const fileStat = await stat(absPath);
    if (!fileStat.isFile()) {
      throw new Error("not a regular file");
    }
    fileSize = fileStat.size;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read media file "${absPath}": ${message}`);
  }

  const imageVerdict = classifyImageExtension(absPath);
  if (imageVerdict.kind === "recognized-unsupported") {
    throw new Error(
      `Unsupported media: image format ".${imageVerdict.extension}" is not supported — use PNG, JPEG, GIF, or WebP ("${absPath}")`,
    );
  }
  if (imageVerdict.kind === "supported") {
    const facts = await readImageHeaderFacts(absPath, fileSize);
    return {
      type: "image",
      durationSec: 0,
      width: facts.width,
      height: facts.height,
      frameRate: 0,
      codec: "",
      fileSize,
      mimeType: facts.mimeType,
      hasVideo: false,
      hasAudio: false,
    };
  }

  const input = new Input({
    source: new FilePathSource(absPath),
    formats: ALL_FORMATS,
  });

  let durationSec = 0;
  let mimeType = "";
  let videoTrack: InputVideoTrack | null = null;
  let audioTrack: InputAudioTrack | null = null;
  let facts = { width: 0, height: 0, codec: "", frameRate: 0 };
  let unsupported = false;

  // All reads happen before disposal (a disposed Input rejects further reads).
  try {
    durationSec = await input.computeDuration();
    mimeType = await input.getMimeType();
    videoTrack = await input.getPrimaryVideoTrack();
    audioTrack = await input.getPrimaryAudioTrack();

    if (!videoTrack && !audioTrack) {
      // Marked here, thrown below: the "no tracks" verdict must surface with
      // its exact message (not wrapped), and the input must still be disposed.
      unsupported = true;
    } else if (videoTrack) {
      facts = await videoTrackFacts(videoTrack);
    }
  } catch (error) {
    throw toProbeError(absPath, error);
  } finally {
    // Explicit dispose: releases the file handle FilePathSource opened.
    input.dispose();
  }

  if (unsupported) {
    throw new Error("Unsupported media: no video or audio track");
  }

  const probed: ProbedMedia = {
    type: videoTrack ? "video" : "audio",
    durationSec,
    width: facts.width,
    height: facts.height,
    frameRate: facts.frameRate,
    codec: facts.codec,
    fileSize,
    mimeType,
    hasVideo: videoTrack !== null,
    hasAudio: audioTrack !== null,
  };
  return probed;
}
