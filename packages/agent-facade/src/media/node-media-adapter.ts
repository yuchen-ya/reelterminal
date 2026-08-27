/**
 * Node media adapter: probes real metadata of local media files with
 * mediabunny. Pure Node — no DOM, no WebCodecs, no Electron. Unlike the
 * browser engine (`packages/core/src/media/mediabunny-engine.ts`) this never
 * calls `track.canDecode()`, because `VideoDecoder` does not exist in Node;
 * mediabunny's demuxer-level probing is fully isomorphic.
 */
import { readFile } from "node:fs/promises";
import { Input, ALL_FORMATS, BlobSource } from "mediabunny";
import type { InputAudioTrack, InputVideoTrack } from "mediabunny";
import type { ImportedMediaMetadata } from "../types";

export interface ProbedMedia extends ImportedMediaMetadata {
  readonly type: "video" | "audio";
  readonly mimeType: string;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/**
 * Disposes a mediabunny Input if explicit-resource-management disposal is
 * available at runtime. `Symbol.dispose` is not part of this package's ES2022
 * lib typing, so it is looked up dynamically.
 */
function disposeInput(input: Input): void {
  const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (disposeKey === undefined) return;
  const disposable = input as unknown as Record<
    symbol,
    (() => void) | undefined
  >;
  disposable[disposeKey]?.();
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
 * Reads a local file and probes real container/track metadata via mediabunny.
 *
 * Throws an `Error` (with a clear, path-bearing message) when the file cannot
 * be read or is not a recognizable media file.
 */
export async function probeLocalMediaFile(
  absPath: string,
): Promise<ProbedMedia> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read media file "${absPath}": ${message}`);
  }

  // Node >= 18 provides the WHATWG Blob global; BlobSource consumes it.
  // Cast note: @types/node models Buffer's backing store as ArrayBufferLike
  // (possibly SharedArrayBuffer) while the DOM BlobPart typing demands an
  // ArrayBuffer view; every Node Buffer is in fact backed by a private
  // ArrayBuffer, so a single narrow cast keeps all supported type levels happy.
  const blob = new Blob([bytes as unknown as BlobPart]);
  const input = new Input({
    source: new BlobSource(blob),
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
    disposeInput(input);
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
    fileSize: bytes.byteLength,
    mimeType,
    hasVideo: videoTrack !== null,
    hasAudio: audioTrack !== null,
  };
  return probed;
}
