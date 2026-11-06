import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveToolFfmpeg, runToolProcess } from '@reelterminal/agent-facade/media/ffmpeg-bin';
import { extractFramesExact, parseShowinfo, probeRasterSize, probeVideoFacts, type FrameTimingAssessment } from '@reelterminal/agent-facade/media/frame-exact';
import { probeLocalMediaFile } from '@reelterminal/agent-facade/media/node-media-adapter';
import { MAX_FRAME_PIXELS } from './segmentation/geometry';
import type { SegmentationFrame } from './segmentation/types';

/** The caller supplies its authorized task root, never an arbitrary source URL. */
export interface TaskMediaFileTarget { root: string; relativePath: string }
export interface TaskMediaVersion { sha256: string; size: number }
export interface TaskMediaFingerprint extends TaskMediaVersion {
  relativePath: string;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}
interface DecodeInput {
  source: TaskMediaFileTarget;
  expectedVersion?: TaskMediaVersion;
  /** Existing controlled directory; only exclusive operation children are created. */
  artifactRoot: string;
  /** Task/source/frame identity assigned by the future task service. */
  frameId: string;
  signal?: AbortSignal;
}
export interface TaskDecodedImage {
  sourceFingerprint: TaskMediaFingerprint;
  artifactDirectory: string;
  pngPath: string;
  /** Pixels are physically oriented (including EXIF mirrors), so rotation is zero. */
  frame: SegmentationFrame;
}
export interface TaskExtractedFrame extends TaskDecodedImage {
  frameIndex?: number;
  ptsTimeSec: number;
  timeBase: string | null;
  timing: FrameTimingAssessment;
  limitations: string[];
  mediaTimeSec?: number;
}

function changed(): Error { return Object.assign(new Error('Media source changed; refresh its version before continuing'), { code: 'SOURCE_CHANGED' }); }
function sameIdentity(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && !b.isSymbolicLink() && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.dev === b.dev && a.ino === b.ino;
}
async function sourcePath(target: TaskMediaFileTarget): Promise<string> {
  if (!path.isAbsolute(target.root) || !target.relativePath || path.isAbsolute(target.relativePath) || /^[a-z]:/i.test(target.relativePath) || target.relativePath.includes('\0')) throw new Error('Expected an absolute task root and a safe relative media path');
  const parts = target.relativePath.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || (process.platform === 'win32' && (part.includes(':') || /[. ]$/.test(part))))) throw new Error('Invalid relative media path');
  let file = await fs.realpath(target.root);
  if (!(await fs.stat(file)).isDirectory()) throw new Error('Media root must be a directory');
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('Media path must contain real directories and a regular file');
  }
  return file;
}
function validateVersion(version: TaskMediaVersion | undefined): void {
  if (version && (!/^[a-f0-9]{64}$/.test(version.sha256) || !Number.isSafeInteger(version.size) || version.size < 0)) throw new Error('Expected a SHA-256 media version and byte size');
}
async function checkSource(target: TaskMediaFileTarget, file: string, before: Stats): Promise<void> {
  if (await sourcePath(target) !== file || !sameIdentity(before, await fs.lstat(file))) throw changed();
}
function fingerprint(target: TaskMediaFileTarget, info: Stats, sha256: string): TaskMediaFingerprint {
  return { relativePath: target.relativePath.replace(/\\/g, '/'), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, sha256 };
}
function matchesVersion(actual: TaskMediaVersion, expected: TaskMediaVersion | undefined): void {
  if (expected && (actual.sha256 !== expected.sha256 || actual.size !== expected.size)) throw changed();
}

/** Streams arbitrary binary originals. No UTF-8 decoding or text-size limit. */
export async function fingerprintTaskMediaFile(target: TaskMediaFileTarget, signal?: AbortSignal): Promise<TaskMediaFingerprint> {
  signal?.throwIfAborted();
  const file = await sourcePath(target);
  const source = await fs.open(file, 'r');
  try {
    const before = await source.stat();
    const hash = createHash('sha256');
    let size = 0;
    const reader = source.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
    for await (const bytes of reader) { signal?.throwIfAborted(); hash.update(bytes); size += bytes.length; }
    if (size !== before.size || !sameIdentity(before, await source.stat())) throw changed();
    await checkSource(target, file, before);
    return fingerprint(target, before, hash.digest('hex'));
  } finally { await source.close(); }
}

export async function assertTaskMediaFileUnchanged(target: TaskMediaFileTarget, previous: TaskMediaFingerprint): Promise<void> {
  const file = await sourcePath(target);
  const info = await fs.lstat(file);
  if (info.size !== previous.size || info.mtimeMs !== previous.mtimeMs || info.ctimeMs !== previous.ctimeMs || info.dev !== previous.dev || info.ino !== previous.ino) throw changed();
}

/** Publishes verified bytes without replacing an existing output; only owned staging is cleaned. */
export async function copyTaskMediaFile(target: TaskMediaFileTarget, expected: TaskMediaVersion, destination: string, signal?: AbortSignal): Promise<TaskMediaFingerprint> {
  validateVersion(expected);
  if (!path.isAbsolute(destination)) throw new Error('Media destination must be absolute');
  signal?.throwIfAborted();
  const file = await sourcePath(target);
  const parent = await fs.realpath(path.dirname(destination));
  const output = path.join(parent, path.basename(destination));
  const temporary = path.join(parent, `.media-copy-${randomUUID()}.part`);
  const source = await fs.open(file, 'r');
  let staged = false;
  let published = false;
  let stagedIdentity: Stats | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size !== expected.size) throw changed();
    const staging = await fs.open(temporary, 'wx');
    staged = true;
    const hash = createHash('sha256');
    let size = 0;
    try {
      const meter = new Transform({ transform(bytes: Buffer, _encoding, next) { hash.update(bytes); size += bytes.length; next(null, bytes); } });
      await pipeline(createReadStream(file, { fd: source.fd, autoClose: false, emitClose: false, highWaterMark: 1024 * 1024 }), meter, createWriteStream(temporary, { fd: staging.fd, autoClose: false, emitClose: false }), { signal });
      await staging.sync();
      stagedIdentity = await staging.stat();
    } finally { await staging.close(); }
    const sha256 = hash.digest('hex');
    matchesVersion({ sha256, size }, expected);
    if (size !== before.size || !sameIdentity(before, await source.stat())) throw changed();
    await checkSource(target, file, before);
    signal?.throwIfAborted();
    await fs.link(temporary, output); // Atomic EXCL publication, like the existing immutable file store.
    published = true;
    stagedIdentity = await fs.lstat(temporary);
    await checkSource(target, file, before);
    signal?.throwIfAborted();
    return fingerprint(target, before, sha256);
  } catch (error) {
    if (published) {
      const current = await fs.lstat(output);
      if (stagedIdentity && sameIdentity(stagedIdentity, current)) await fs.unlink(output);
    }
    throw error;
  } finally {
    await source.close();
    if (staged) await fs.unlink(temporary);
  }
}

async function binaries() {
  const available = await resolveToolFfmpeg();
  if (!available) throw Object.assign(new Error('Media decoding requires configured ffmpeg and ffprobe or existing binaries on PATH; no models or binaries are downloaded automatically'), { code: 'MEDIA_UNAVAILABLE' });
  return available;
}
async function operationDirectory(root: string, prefix: string): Promise<string> {
  if (!path.isAbsolute(root)) throw new Error('Media artifact root must be an absolute controlled directory');
  const canonical = await fs.realpath(root);
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Media artifact root must already exist');
  return fs.mkdtemp(path.join(canonical, prefix));
}
function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_FRAME_PIXELS) throw new Error('Decoded media frame exceeds the segmentation limit of 4096² pixels');
}
async function rgbaFromPng(ffmpeg: string, ffprobe: string, pngPath: string, directory: string, frameId: string, signal?: AbortSignal): Promise<SegmentationFrame> {
  const size = await probeRasterSize(ffprobe, pngPath);
  dimensions(size.width, size.height);
  const raw = path.join(directory, 'pixels.rgba');
  await runToolProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', pngPath, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', raw], { signal });
  const info = await fs.lstat(raw);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== size.width * size.height * 4) throw new Error('Decoded RGBA dimensions do not match the normalized image');
  const rgba = await fs.readFile(raw);
  await fs.unlink(raw);
  const revision = createHash('sha256').update(rgba).digest('hex');
  return { id: frameId, revision, ...size, rotation: 0, rgba };
}
async function checkedInput(input: DecodeInput) {
  if (!input.frameId.trim()) throw new Error('A task-scoped frame identity is required');
  validateVersion(input.expectedVersion);
  const sourceFingerprint = await fingerprintTaskMediaFile(input.source, input.signal);
  matchesVersion(sourceFingerprint, input.expectedVersion);
  const file = await sourcePath(input.source);
  const info = await fs.stat(file);
  if (info.size !== sourceFingerprint.size || info.mtimeMs !== sourceFingerprint.mtimeMs || info.ctimeMs !== sourceFingerprint.ctimeMs || info.dev !== sourceFingerprint.dev || info.ino !== sourceFingerprint.ino) throw changed();
  return { sourceFingerprint, file, info };
}

/** Physically normalizes EXIF orientation/mirroring; the saved PNG and worker pixels share one space. */
export async function decodeTaskReviewImage(input: DecodeInput): Promise<TaskDecodedImage> {
  const source = await checkedInput(input);
  const facts = await probeLocalMediaFile(source.file);
  if (facts.type !== 'image') throw new Error('An actual supported still image is required');
  dimensions(facts.width, facts.height);
  const tool = await binaries();
  const artifactDirectory = await operationDirectory(input.artifactRoot, 'image-');
  try {
    const pngPath = path.join(artifactDirectory, 'normalized.png');
    await runToolProcess(tool.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', source.file, '-map', '0:v:0', '-frames:v', '1', '-map_metadata', '-1', '-update', '1', pngPath], { signal: input.signal });
    const frame = await rgbaFromPng(tool.ffmpeg, tool.ffprobe, pngPath, artifactDirectory, input.frameId, input.signal);
    await checkSource(input.source, source.file, source.info);
    input.signal?.throwIfAborted();
    return { sourceFingerprint: source.sourceFingerprint, artifactDirectory, pngPath, frame };
  } catch (error) { await fs.rm(artifactDirectory, { recursive: true, force: true }); throw error; }
}

/** Uses the exact decoded index and returned PTS; never multiplies time by a nominal frame rate. */
export async function extractTaskReviewFrame(input: DecodeInput & { frameIndex: number }): Promise<TaskExtractedFrame> {
  if (!Number.isSafeInteger(input.frameIndex) || input.frameIndex < 0) throw new Error('A zero-based exact frame index is required');
  const source = await checkedInput(input);
  return extractCheckedFrame(input, source);
}

async function extractCheckedFrame(input: DecodeInput & { frameIndex: number }, source: Awaited<ReturnType<typeof checkedInput>>): Promise<TaskExtractedFrame> {
  const media = await probeLocalMediaFile(source.file);
  if (media.type !== 'video') throw new Error('An actual video source is required for frame extraction');
  const tool = await binaries();
  const facts = await probeVideoFacts(tool.ffprobe, source.file, { signal: input.signal });
  dimensions(facts.width, facts.height);
  const artifactDirectory = await operationDirectory(input.artifactRoot, 'frame-');
  try {
    const extracted = await extractFramesExact(tool.ffmpeg, source.file, [input.frameIndex], path.join(artifactDirectory, 'exact'), { ffprobe: tool.ffprobe, signal: input.signal });
    const captured = extracted.frames[0];
    if (!captured || captured.frame !== input.frameIndex || !Number.isFinite(captured.ptsTimeSec)) throw new Error('Exact frame extraction did not return the requested index and PTS');
    const frame = await rgbaFromPng(tool.ffmpeg, tool.ffprobe, captured.path, artifactDirectory, input.frameId, input.signal);
    await checkSource(input.source, source.file, source.info);
    input.signal?.throwIfAborted();
    return { sourceFingerprint: source.sourceFingerprint, artifactDirectory, pngPath: captured.path, frame, frameIndex: captured.frame, ptsTimeSec: captured.ptsTimeSec, timeBase: facts.timeBase, timing: facts.timing, limitations: extracted.limitations };
  } catch (error) { await fs.rm(artifactDirectory, { recursive: true, force: true }); throw error; }
}

/** Freeze the frame actually covering player-relative time, by decoded PTS, including VFR. */
export async function extractTaskReviewFrameAtTime(input: DecodeInput & { timeSec: number }): Promise<TaskExtractedFrame> {
  if (!Number.isFinite(input.timeSec) || input.timeSec < 0) throw new Error('A nonnegative player time is required');
  const source = await checkedInput(input);
  const tool = await binaries();
  const media = await probeLocalMediaFile(source.file);
  if (media.type !== 'video') throw new Error('An actual video source is required for frame capture');
  dimensions(media.width, media.height);
  const probe = await runToolProcess(tool.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time,time_base:format=start_time', '-of', 'json', source.file], { signal: input.signal, timeoutMs: 15000 });
  const metadata = JSON.parse(probe.stdout.toString('utf8')) as { streams?: { start_time?: string; time_base?: string }[]; format?: { start_time?: string } };
  const stream = metadata.streams?.[0];
  let startTime = Number(stream?.start_time ?? metadata.format?.start_time);
  if (!Number.isFinite(startTime)) {
    const first = await runToolProcess(tool.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe', '-copyts', '-i', source.file, '-map', '0:v:0', '-vf', 'showinfo', '-frames:v', '1', '-an', '-f', 'null', '-'], { signal: input.signal, timeoutMs: 15000 });
    const beginning = parseShowinfo(first.stderr)[0];
    if (!beginning) throw new Error('Cannot establish the video player timeline origin');
    startTime = beginning.ptsTimeSec;
  }
  const absoluteTime = startTime + input.timeSec;
  const seekTime = Math.max(0, input.timeSec - 2);
  // Seek to a nearby keyframe, retain its predecessor across VFR gaps, and
  // stop at a bounded time/count. Counter is local to this seek, not a global index.
  const scanned = await runToolProcess(tool.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe', '-ss', String(seekTime), '-noaccurate_seek', '-copyts', '-i', source.file, '-map', '0:v:0', '-vf', `showinfo,trim=end=${absoluteTime + 2}`, '-frames:v', '512', '-an', '-fps_mode', 'passthrough', '-f', 'null', '-'], { signal: input.signal, timeoutMs: 15000 });
  const frames = parseShowinfo(scanned.stderr);
  const selected = frames.filter(frame => frame.ptsTimeSec <= absoluteTime + 1e-7).at(-1);
  let covered = selected !== undefined && (Math.abs(selected.ptsTimeSec - absoluteTime) <= 1e-7 || frames.some(frame => frame.ptsTimeSec > absoluteTime));
  if (selected && !covered) {
    // EOF can hold its last frame only for the duration actually reported by
    // that decoded frame. Absence of a later sample is not proof of coverage.
    for (const line of scanned.stderr.split('\n')) {
      const duration = /\bn:\s*(\d+).*\bpts_time:\s*([\d.e+-]+).*\bduration_time:\s*([\d.e+-]+)/.exec(line);
      if (duration && Number(duration[1]) === selected.counter && Number(duration[2]) === selected.ptsTimeSec && Number(duration[3]) > 0 && absoluteTime <= selected.ptsTimeSec + Number(duration[3]) + 1e-7) covered = true;
    }
  }
  if (!selected || !covered) throw new Error('The bounded seek did not establish coverage of the requested player time');
  const artifactDirectory = await operationDirectory(input.artifactRoot, 'frame-');
  try {
    const pngPath = path.join(artifactDirectory, 'captured.png');
    const extracted = await runToolProcess(tool.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe', '-ss', String(Math.max(0, selected.ptsTimeSec - startTime - 1e-7)), '-noaccurate_seek', '-copyts', '-i', source.file, '-map', '0:v:0', '-vf', `showinfo,select='gte(t,${selected.ptsTimeSec - 1e-7})'`, '-frames:v', '1', '-map_metadata', '-1', '-update', '1', '-n', pngPath], { signal: input.signal, timeoutMs: 15000 });
    const actual = parseShowinfo(extracted.stderr).find(frame => frame.ptsTimeSec >= selected.ptsTimeSec - 1e-7);
    if (!actual || Math.abs(actual.ptsTimeSec - selected.ptsTimeSec) > 1e-6) throw new Error('Seeked frame PTS does not match the requested decoded frame');
    const frame = await rgbaFromPng(tool.ffmpeg, tool.ffprobe, pngPath, artifactDirectory, input.frameId, input.signal);
    await checkSource(input.source, source.file, source.info);
    return { sourceFingerprint: source.sourceFingerprint, artifactDirectory, pngPath, frame, ptsTimeSec: actual.ptsTimeSec, mediaTimeSec: actual.ptsTimeSec - startTime, timeBase: stream?.time_base ?? null, timing: { timing: 'unknown', fps: null, method: 'Bounded PTS seek without a full-stream rate scan', sampledFrameCount: frames.length }, limitations: ['Global frame index is not inferred from a local seek or nominal FPS.'] };
  } catch (error) { await fs.rm(artifactDirectory, { recursive: true, force: true }); throw error; }
}

/** Persist a binary foreground mask without interpreting it as a semantic class or approval. */
export async function encodeTaskMaskPng(input: { alpha: Uint8Array; width: number; height: number; artifactRoot: string; signal?: AbortSignal }): Promise<{ artifactDirectory: string; pngPath: string }> {
  dimensions(input.width, input.height);
  if (input.alpha.length !== input.width * input.height) throw new Error('Mask dimensions do not match its pixel buffer');
  const tool = await binaries();
  const artifactDirectory = await operationDirectory(input.artifactRoot, 'mask-');
  try {
    const raw = path.join(artifactDirectory, 'alpha.gray');
    const pngPath = path.join(artifactDirectory, 'mask.png');
    await fs.writeFile(raw, input.alpha, { flag: 'wx' });
    await runToolProcess(tool.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${input.width}x${input.height}`, '-i', raw, '-frames:v', '1', '-update', '1', pngPath], { signal: input.signal });
    await fs.unlink(raw);
    return { artifactDirectory, pngPath };
  } catch (error) { await fs.rm(artifactDirectory, { recursive: true, force: true }); throw error; }
}

/** Straight RGBA source color with alpha = original alpha × foreground mask. */
export async function encodeTaskCutoutPng(input: { rgba: Uint8Array; alpha: Uint8Array; width: number; height: number; artifactRoot: string; signal?: AbortSignal }): Promise<{ artifactDirectory: string; pngPath: string }> {
  dimensions(input.width, input.height);
  if (input.rgba.length !== input.width * input.height * 4 || input.alpha.length !== input.width * input.height) throw new Error('Cutout source and mask dimensions do not match');
  const tool = await binaries();
  const artifactDirectory = await operationDirectory(input.artifactRoot, 'cutout-');
  try {
    const rgba = path.join(artifactDirectory, 'source.rgba');
    const mask = path.join(artifactDirectory, 'mask.gray');
    const pngPath = path.join(artifactDirectory, 'cutout.png');
    await fs.writeFile(rgba, input.rgba, { flag: 'wx' });
    await fs.writeFile(mask, input.alpha, { flag: 'wx' });
    const size = `${input.width}x${input.height}`;
    await runToolProcess(tool.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', size, '-i', rgba, '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', size, '-i', mask, '-filter_complex', '[0:v]split[c][x];[x]alphaextract[a];[a][1:v]blend=all_mode=multiply[m];[c][m]alphamerge[out]', '-map', '[out]', '-frames:v', '1', '-pix_fmt', 'rgba', '-update', '1', pngPath], { signal: input.signal });
    await fs.unlink(rgba); await fs.unlink(mask);
    return { artifactDirectory, pngPath };
  } catch (error) { await fs.rm(artifactDirectory, { recursive: true, force: true }); throw error; }
}
