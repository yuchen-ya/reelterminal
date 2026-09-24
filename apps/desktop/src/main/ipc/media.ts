import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  MediaJob,
  buildProxyArgs,
  buildTranscodeArgs,
  buildExtractAudioArgs,
  type ProxyPreset,
  type TranscodeContainer,
} from "../sidecar/media-job";
import { probeAudioStreams as probe, type AudioStreamInfo } from "../sidecar/probe-streams";

function tmpPath(ext: string): string {
  return path.join(os.tmpdir(), `reelterminal-${randomUUID()}.${ext}`);
}

export async function generateProxy(args: {
  srcPath: string;
  preset: ProxyPreset;
}): Promise<{ outPath: string }> {
  const outPath = tmpPath("mp4");
  try {
    await new MediaJob(buildProxyArgs(args.srcPath, outPath, args.preset)).run();
  } catch (error) {
    // Best-effort reclaim of the partial ffmpeg output; the original error
    // object is rethrown untouched.
    await rm(outPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { outPath };
}

export async function transcode(args: {
  srcPath: string;
  container: TranscodeContainer;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}): Promise<{ outPath: string }> {
  const outPath = tmpPath(args.container);
  try {
    await new MediaJob(
      buildTranscodeArgs(args.srcPath, outPath, {
        container: args.container,
        videoBitrateKbps: args.videoBitrateKbps,
        audioBitrateKbps: args.audioBitrateKbps,
      }),
    ).run();
  } catch (error) {
    await rm(outPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { outPath };
}

export async function extractAudioWav(args: {
  srcPath: string;
  streamIndex?: number;
}): Promise<{ outPath: string }> {
  const outPath = tmpPath("wav");
  try {
    await new MediaJob(buildExtractAudioArgs(args.srcPath, outPath, args.streamIndex)).run();
  } catch (error) {
    await rm(outPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { outPath };
}

export async function probeAudioStreams(args: {
  srcPath: string;
}): Promise<{ streams: AudioStreamInfo[] }> {
  return { streams: await probe(args.srcPath) };
}
