import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runReleaseFeature } from "../harness/performance/release-feature";

const enabled = process.env.REELTERMINAL_RELEASE_FEATURE === "recording";
const native = process.env.REELTERMINAL_FEATURE_NATIVE_CAPTURE === "1";
(enabled && !native ? test : test.skip)("ten real 1080p MediaRecorder cycles with synthetic capture acquisition", async () => {
  await runReleaseFeature("recording", async c => {
    const count = Number(process.env.REELTERMINAL_FEATURE_RECORDINGS ?? 10);
    const seconds = Number(process.env.REELTERMINAL_FEATURE_RECORD_SECONDS ?? 10);
    if (![count, seconds].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid recording scale");
    c.record.scale = { count, active_seconds_each: seconds, width: 1920, height: 1080, fps: 30, acquisition: "synthetic_canvas_only", encoder: "real_MediaRecorder", native_permission_verified: false };
    await c.app.page.evaluate(() => {
      const instrumentation = { calls: 0, activeTimers: 0, tracks: [] as MediaStreamTrack[] };
      (window as any).__recordingPressure = instrumentation;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const index = instrumentation.calls++;
        const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext("2d")!;
        let frame = 0;
        const draw = () => {
          frame++;
          ctx.fillStyle = "rgb(" + frame % 128 + ",80,90)"; ctx.fillRect(0, 0, 1920, 1080);
          ctx.fillStyle = ["red", "lime", "blue"][index % 3]!; ctx.fillRect(860, 440, 200, 200);
          ctx.fillStyle = "white"; ctx.font = "48px sans-serif"; ctx.fillText("Recording " + index + " frame " + frame, 50, 100);
          for (let bit = 0; bit < 10; bit++) { ctx.fillStyle = frame & 2 ** bit ? "white" : "black"; ctx.fillRect(40 + bit * 28, 960, 24, 24); }
        };
        draw(); const timer = setInterval(draw, 1000 / 30); instrumentation.activeTimers++;
        const stream = canvas.captureStream(30); let released = false;
        for (const track of stream.getTracks()) {
          instrumentation.tracks.push(track);
          const stop = track.stop.bind(track);
          track.stop = () => { if (!released) { clearInterval(timer); instrumentation.activeTimers--; released = true; } stop(); };
        }
        return stream;
      };
    });
    c.record.recordings = [];
    for (let index = 0; index < count; index++) {
      const before = await c.call("project_get_state");
      const page = c.app.page; const browser = page.getByTestId("project-asset-browser");
      await browser.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByText("Record", { exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Screen Recording", exact: true });
      await dialog.getByRole("button", { name: "Start Recording", exact: true }).click();
      await page.getByRole("button", { name: "Pause recording", exact: true }).waitFor();
      const start = performance.now();
      await page.waitForTimeout(seconds * 500);
      await page.getByRole("button", { name: "Pause recording", exact: true }).click();
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "Resume recording", exact: true }).click();
      await page.waitForTimeout(seconds * 500);
      if (index === count - 1) {
        await page.evaluate(() => { const data = (window as any).__recordingPressure; data.tracks[data.tracks.length - 1].dispatchEvent(new Event("ended")); });
      } else {
        await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      }
      await dialog.waitFor({ state: "hidden", timeout: 30_000 });
      await page.waitForFunction(expected => document.querySelectorAll('[data-testid="project-asset-browser"] [data-live-media-id]').length === expected, before.project.mediaLibrary.items.length + 1, { timeout: 60_000 });
      const after = await c.call("project_get_state");
      const oldIds = new Set(before.project.mediaLibrary.items.map((m: any) => m.id));
      const added = after.project.mediaLibrary.items.filter((m: any) => !oldIds.has(m.id));
      expect(added).toHaveLength(1);
      const file = added[0].contentUrl;
      expect(typeof file).toBe("string"); expect(file.startsWith(c.app.runDir)).toBe(true);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
      const video = probe.streams.find((s: any) => s.codec_type === "video");
      expect(video.width).toBe(1920); expect(video.height).toBe(1080);
      // Streaming WebM from MediaRecorder can omit Segment Duration. Decode
      // packet timestamps instead of treating absent metadata as NaN.
      const packets = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,duration_time", "-of", "json", file], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
      const packetEnd = Math.max(...packets.packets.map((p: any) => Number(p.pts_time) + Number(p.duration_time ?? 0)));
      c.record.latest_probe = { index, probe, packets, packet_end_seconds: packetEnd };
      await c.flush();
      expect(Number.isFinite(packetEnd)).toBe(true);
      expect(Math.abs(packetEnd - seconds)).toBeLessThanOrEqual(1);
      execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { timeout: 60_000 });
      const frames = [1, Math.max(1.5, seconds - 1)].map(t => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }));
      const hashes = frames.map(bytes => createHash("sha256").update(bytes).digest("hex"));
      expect(hashes[0]).not.toBe(hashes[1]);
      const rgb = Array.from(frames[0]!.subarray((540 * 1920 + 960) * 3, (540 * 1920 + 960) * 3 + 3));
      expect(rgb[index % 3]).toBeGreaterThan(180);
      expect(rgb[(index + 1) % 3]).toBeLessThan(80);
      const resources = await page.evaluate(() => { const data = (window as any).__recordingPressure; return { calls: data.calls, activeTimers: data.activeTimers, tracks: data.tracks.map((t: MediaStreamTrack) => t.readyState) }; });
      expect(resources.activeTimers).toBe(0); expect(resources.tracks.every((s: string) => s === "ended")).toBe(true);
      const ext = path.extname(file);
      expect([".webm", ".mp4"]).toContain(ext);
      await copyFile(file, path.join(c.evidence, "recording-" + index + ext));
      c.record.recordings.push({ index, elapsed_ms: performance.now() - start, source_ended: index === count - 1, media: added[0], probe, packet_end_seconds: packetEnd, packet_count: packets.packets.length, resources, frame_hashes: hashes, center_rgb: rgb });
      await c.sample(); await c.flush(); console.info("REAL_RECORDING_COMPLETE", { index });
    }
    await c.app.page.screenshot({ path: path.join(c.evidence, "recording-assets.png") });
  });
}, 7_200_000);

(enabled && native ? test : test.skip)("native macOS display capture of only the owned test window", async () => {
  await runReleaseFeature("native-recording", async c => {
    c.record.scope = "native picker must select only the isolated ReelTerminal test window; no desktop/microphone/webcam capture";
    const page = c.app.page;
    await page.getByTestId("project-asset-browser").getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByText("Record", { exact: true }).click();
    await page.getByRole("dialog", { name: "Screen Recording", exact: true }).getByRole("button", { name: "Start Recording", exact: true }).click();
    console.info("NATIVE_CAPTURE_AWAITING_PICKER", { app_pid: c.record.application.pid });
    await page.getByRole("button", { name: "Pause recording", exact: true }).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-asset-browser"] [data-live-media-id]').length === 1, null, { timeout: 30_000 });
    const item = (await c.call("project_get_state")).project.mediaLibrary.items[0];
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", item.contentUrl], { encoding: "utf8" }));
    expect(probe.streams.some((s: any) => s.codec_type === "video")).toBe(true);
    execFileSync("ffmpeg", ["-v", "error", "-i", item.contentUrl, "-f", "null", "-"], { timeout: 60_000 });
    c.record.capture = { item, probe };
    await copyFile(item.contentUrl, path.join(c.evidence, "native-recording" + path.extname(item.contentUrl)));
  });
}, 300_000);
