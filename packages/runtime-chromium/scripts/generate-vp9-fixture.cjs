/**
 * One-off generator for the embedded VP9 test fixture TS module.
 * Usage: node scripts/generate-vp9-fixture.cjs <fixture.mp4> <out.ts>
 * (The fixture itself is produced by ffmpeg; see the emitted file header.)
 */
const fs = require("node:fs");
const crypto = require("node:crypto");

const [, , inputPath, outPath] = process.argv;
if (!inputPath || !outPath) {
  console.error("usage: node generate-vp9-fixture.cjs <fixture.mp4> <out.ts>");
  process.exit(1);
}
const buf = fs.readFileSync(inputPath);
const b64 = buf.toString("base64");
const lines = [];
for (let i = 0; i < b64.length; i += 100) {
  lines.push(`  "${b64.slice(i, i + 100)}",`);
}
const sha = crypto.createHash("sha256").update(buf).digest("hex");
const ts = `/**
 * Deterministic VP9-in-MP4 test fixture, embedded as base64 so that no
 * binary artifact ever lives in the repository.
 *
 * Why VP9 (not H.264): this fixture is decoded INSIDE stock Chromium by the
 * Slice-1b E2E. Playwright's open-source Chromium build omits proprietary
 * H.264 decoding on Linux, while VP9 decodes everywhere Chromium runs — so
 * the same fixture serves local Windows and Linux CI identically. Only the
 * INPUT is VP9; the exported artifact is always H.264.
 *
 * Generated ONCE with ffmpeg 8.1.1 (Gyan full build), outside the repo:
 *   ffmpeg -y -f lavfi -i testsrc2=size=320x180:rate=10:duration=6 \\
 *     -an -c:v libvpx-vp9 -crf 38 -b:v 0 -pix_fmt yuv420p \\
 *     -movflags +faststart tiny-vp9-6s.mp4
 *
 * Content: 60 frames of the moving testsrc2 pattern, video-only
 * (vp9 / yuv420p / 320x180 @ 10 fps, faststart moov).
 * sha256: ${sha}
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export const TINY_VP9_MP4_FILENAME = "tiny-vp9-6s.mp4";

/** Fixed-width chunks of the base64 encoding, in order. */
const BASE64_LINES: readonly string[] = [
${lines.join("\n")}
];

export const TINY_VP9_MP4_BASE64 = BASE64_LINES.join("");

/** Decodes the embedded fixture bytes (a fresh allocation per call). */
export function tinyVp9Mp4Bytes(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_VP9_MP4_BASE64, "base64"));
}

/**
 * Writes the fixture into \`dir\` (which must already exist) under
 * {@link TINY_VP9_MP4_FILENAME} and returns the absolute file path.
 */
export function writeTinyVp9Mp4(dir: string): string {
  const filePath = path.join(dir, TINY_VP9_MP4_FILENAME);
  writeFileSync(filePath, tinyVp9Mp4Bytes());
  return filePath;
}

/** Metadata the probes must reproduce (measured with ffprobe 8.1.1). */
export const TINY_VP9_MP4_EXPECTED: {
  durationSec: number;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  codec: string;
  sha256: string;
} = {
  durationSec: 6,
  width: 320,
  height: 180,
  frameRate: 10,
  frameCount: 60,
  codec: "vp9",
  sha256: "${sha}",
};
`;
fs.writeFileSync(outPath, ts);
console.log("written", outPath, "sha256=", sha, "bytes=", buf.length);
