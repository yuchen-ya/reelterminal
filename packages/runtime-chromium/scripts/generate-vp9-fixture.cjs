/**
 * Generate a TypeScript module containing a VP9 test fixture.
 * Usage: node scripts/generate-vp9-fixture.cjs <fixture.mp4> <out.ts>
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
 * VP9-in-MP4 input fixture for Chromium tests, embedded as base64.
 *
 * VP9 is used because Playwright's open-source Chromium build omits
 * proprietary H.264 decoding on Linux. Exported artifacts use H.264.
 *
 * Content: 60 video-only frames at 320x180 and 10 fps.
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
