import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveToolFfmpeg, runToolProcess } from '@reelterminal/agent-facade/media/ffmpeg-bin';
import { copyTaskMediaFile, decodeTaskReviewImage, extractTaskReviewFrame, extractTaskReviewFrameAtTime, fingerprintTaskMediaFile } from './task-review-media-files';
import { validateRequest } from './segmentation/geometry';

const roots: string[] = [];
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-media-files-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('task media binary identity and copies', () => {
  it('streams binary originals above the text limit, preserves exact bytes and never replaces an existing output', async () => {
    const root = await temporary();
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 13);
    for (let position = 0; position < bytes.length; position++) bytes[position] = position % 256;
    await fs.writeFile(path.join(root, 'source.bin'), bytes);
    const target = { root, relativePath: 'source.bin' };
    const identity = await fingerprintTaskMediaFile(target);
    const output = path.join(root, 'copy.bin');
    expect(await copyTaskMediaFile(target, identity, output)).toMatchObject({ size: bytes.length, sha256: identity.sha256 });
    expect((await fs.readFile(output)).equals(bytes)).toBe(true);
    await expect(copyTaskMediaFile(target, identity, output)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await fs.readFile(output)).equals(bytes)).toBe(true);
    expect((await fs.readdir(root)).some(name => name.endsWith('.part'))).toBe(false);
  });

  it('rejects changed versions and cancellation, cleaning only its own output staging', async () => {
    const root = await temporary();
    const target = { root, relativePath: 'source.bin' };
    await fs.writeFile(path.join(root, 'source.bin'), Buffer.from([0, 255, 2, 254]));
    const identity = await fingerprintTaskMediaFile(target);
    await fs.writeFile(path.join(root, 'source.bin'), Buffer.from([0, 255, 3, 254]));
    await expect(copyTaskMediaFile(target, identity, path.join(root, 'changed.bin'))).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await fs.readdir(root)).toEqual(['source.bin']);
    const controller = new AbortController();
    controller.abort();
    await expect(copyTaskMediaFile(target, identity, path.join(root, 'cancelled.bin'), controller.signal)).rejects.toThrow();
    await expect(fingerprintTaskMediaFile({ root, relativePath: '../outside' })).rejects.toThrow('relative media path');
    expect(await fs.readdir(root)).toEqual(['source.bin']);
  });

});

// These integration fixtures use only already-installed binaries; no downloads.
const tools = await resolveToolFfmpeg();
describe.skipIf(!tools)('task media real ffmpeg synthetic fixtures', () => {
  async function jpegFixture(root: string) {
    const ppm = Buffer.concat([Buffer.from('P6\n3 2\n255\n'), Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255])]);
    await fs.writeFile(path.join(root, 'pixels.ppm'), ppm);
    await runToolProcess(tools!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', path.join(root, 'pixels.ppm'), '-frames:v', '1', '-q:v', '1', '-pix_fmt', 'yuvj444p', path.join(root, 'base.jpg')]);
    return fs.readFile(path.join(root, 'base.jpg'));
  }
  function exifOrientation(jpeg: Buffer, orientation: number): Buffer {
    // A minimal real EXIF TIFF IFD containing Orientation (tag 0x0112).
    const payload = Buffer.alloc(32);
    payload.write('Exif\0\0', 0, 'binary'); payload.write('II', 6, 'ascii');
    payload.writeUInt16LE(42, 8); payload.writeUInt32LE(8, 10); payload.writeUInt16LE(1, 14);
    payload.writeUInt16LE(0x0112, 16); payload.writeUInt16LE(3, 18); payload.writeUInt32LE(1, 20); payload.writeUInt16LE(orientation, 24);
    const marker = Buffer.alloc(4); marker[0] = 0xff; marker[1] = 0xe1; marker.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
  }
  function pixel(rgba: Uint8Array, width: number, x: number, y: number) { return [...rgba.subarray((y * width + x) * 4, (y * width + x + 1) * 4)]; }

  it('physically normalizes non-square EXIF rotation and mirroring into the saved PNG and worker RGBA coordinates', async () => {
    const root = await temporary();
    const jpeg = await jpegFixture(root);
    await fs.writeFile(path.join(root, 'rotate.jpg'), exifOrientation(jpeg, 6));
    await fs.writeFile(path.join(root, 'mirror.jpg'), exifOrientation(jpeg, 2));
    const decode = (relativePath: string) => decodeTaskReviewImage({ source: { root, relativePath }, artifactRoot: root, frameId: `test/${relativePath}` });
    const base = await decode('base.jpg');
    const rotated = await decode('rotate.jpg');
    const mirrored = await decode('mirror.jpg');
    expect(rotated.frame).toMatchObject({ width: 2, height: 3, rotation: 0 });
    expect(mirrored.frame).toMatchObject({ width: 3, height: 2, rotation: 0 });
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
      expect(pixel(rotated.frame.rgba, 2, 1 - y, x)).toEqual(pixel(base.frame.rgba, 3, x, y));
      expect(pixel(mirrored.frame.rgba, 3, 2 - x, y)).toEqual(pixel(base.frame.rgba, 3, x, y));
    }
    expect(() => validateRequest({ frame: rotated.frame, refinementId: 'geometry-test-session', prompts: { points: [{ x: 0.25, y: 0.75, foreground: true }] } })).not.toThrow();
    expect(await fs.readFile(path.join(root, 'rotate.jpg'))).toEqual(exifOrientation(jpeg, 6));
  }, 30000);

  it('extracts the exact VFR frame index with its actual nonzero PTS and stream timebase', async () => {
    const root = await temporary();
    const sourcePath = path.join(root, 'vfr.mkv');
    await runToolProcess(tools!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc=size=6x4:rate=10:duration=0.4', '-vf', "settb=1/1000,setpts='if(eq(N,0),400,if(eq(N,1),500,if(eq(N,2),750,800)))'", '-frames:v', '4', '-fps_mode', 'passthrough', '-enc_time_base', '1:1000', '-c:v', 'ffv1', sourcePath]);
    const extracted = await extractTaskReviewFrame({ source: { root, relativePath: 'vfr.mkv' }, artifactRoot: root, frameId: 'test/vfr/2', frameIndex: 2 });
    expect(extracted.frameIndex).toBe(2);
    expect(extracted.ptsTimeSec).toBeCloseTo(0.75, 5);
    expect(extracted.timeBase).toBe('1/1000');
    expect(extracted.timing.timing).toBe('vfr');
    expect(extracted.frame).toMatchObject({ id: 'test/vfr/2', width: 6, height: 4, rotation: 0 });
    expect(extracted.frame.rgba).toHaveLength(6 * 4 * 4);
  }, 30000);

  it('captures a late player-time target through bounded nearby seeking rather than decoding a whole video prefix', async () => {
    const root = await temporary();
    await runToolProcess(tools!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc=size=16x8:rate=10:duration=20', '-c:v', 'ffv1', '-g', '10', path.join(root, 'longer.mkv')]);
    const start = performance.now();
    const captured = await extractTaskReviewFrameAtTime({ source: { root, relativePath: 'longer.mkv' }, artifactRoot: root, frameId: 'late-player-time', timeSec: 18.15 });
    expect(captured.ptsTimeSec).toBeCloseTo(18.1, 5);
    expect(captured.frameIndex).toBeUndefined();
    expect(captured.timing.sampledFrameCount).toBeLessThan(80);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(15000);
    console.info('synthetic late-frame capture', JSON.stringify({ elapsedMs: Math.round(elapsedMs), sampledFrames: captured.timing.sampledFrameCount, targetSec: 18.15, actualPtsSec: captured.ptsTimeSec }));
  }, 30000);

  it('fails explicitly when the nearby decoded-frame cap stops before the requested time', async () => {
    const root = await temporary();
    await runToolProcess(tools!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc=size=2x2:rate=1000:duration=2', '-c:v', 'ffv1', '-g', '2000', path.join(root, 'dense.mkv')]);
    await expect(extractTaskReviewFrameAtTime({ source: { root, relativePath: 'dense.mkv' }, artifactRoot: root, frameId: 'bounded-uncovered-target', timeSec: 1.8 })).rejects.toThrow('did not establish coverage');
  }, 30000);
});
