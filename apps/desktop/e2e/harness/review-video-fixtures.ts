import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ReviewVideoFixture {
  name: string;
  file: string;
  probe: { streams: Array<{ width: number; height: number; start_time: string; duration: string; side_data_list?: Array<{ rotation?: number }> }>; frames: Array<{ best_effort_timestamp_time: string; pkt_duration_time?: string }> };
  width: number;
  height: number;
  /** RGB samples from actual FFmpeg decoded, autorotated frames, not fixture formulae. */
  signatures: number[][];
}

export const VIDEO_SAMPLE_POINTS = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]];

function ffmpeg(args: string[]) {
  return execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function inspect(name: string, file: string): ReviewVideoFixture {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_frames", "-of", "json", file], { windowsHide: true }).toString()) as ReviewVideoFixture["probe"];
  const stream = probe.streams[0];
  const rotated = Math.abs(stream.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
  const width = rotated ? stream.height : stream.width;
  const height = rotated ? stream.width : stream.height;
  const decoded = ffmpeg(["-i", file, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const frameBytes = width * height * 3;
  if (decoded.length !== frameBytes * probe.frames.length) throw new Error("Decoded frame count differs from ffprobe");
  const signatures = probe.frames.map((_, index) => VIDEO_SAMPLE_POINTS.flatMap(([x, y]) => {
    const offset = index * frameBytes + (Math.floor(y * height) * width + Math.floor(x * width)) * 3;
    return [...decoded.subarray(offset, offset + 3)];
  }));
  return { name, file, probe, width, height, signatures };
}

export function createReviewVideoFixtures(root: string): ReviewVideoFixture[] {
  const directory = path.join(root, "a7-video-fixtures");
  mkdirSync(directory);
  const durations = [0.16, 0.4, 0.24, 0.6, 0.2, 0.4, 0.32, 0.48, 0.2, 0.6];
  const entries: string[] = [];
  durations.forEach((duration, index) => {
    const pixels = Buffer.alloc(160 * 96 * 3);
    for (let y = 0; y < 96; y++) for (let x = 0; x < 160; x++) {
      let color = [40 + index * 18, 70, 140];
      if (x < 32 && y < 24) color = [230, 30, 30];
      if (x >= 128 && y < 24) color = [30, 230, 30];
      if (x < 32 && y >= 72) color = [30, 30, 230];
      if (x >= 128 && y >= 72) color = [230, 230, 30];
      pixels.set(color, (y * 160 + x) * 3);
    }
    const name = `frame-${index}.ppm`;
    writeFileSync(path.join(directory, name), Buffer.concat([Buffer.from("P6\n160 96\n255\n"), pixels]));
    entries.push(`file '${name}'`, `duration ${duration}`);
  });
  entries.push("file 'frame-9.ppm'");
  const list = path.join(directory, "frames.txt");
  writeFileSync(list, entries.join("\n"));
  const vfr = path.join(directory, "vfr.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "12", "-bf", "0", "-pix_fmt", "yuv420p", "-video_track_timescale", "1000", vfr]);
  const rotated = path.join(directory, "rotated.mp4");
  ffmpeg(["-display_rotation", "90", "-i", vfr, "-c", "copy", rotated]);
  const offset = path.join(directory, "offset.mp4");
  ffmpeg(["-i", vfr, "-c", "copy", "-output_ts_offset", "5", offset]);
  const slower = path.join(directory, "slower.mp4");
  ffmpeg(["-i", vfr, "-vf", "setpts=2*(PTS-STARTPTS)", "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "12", "-bf", "0", slower]);
  return [inspect("VFR", vfr), inspect("Rotation 90", rotated), inspect("Start time 5", offset), inspect("Twice duration", slower)];
}
