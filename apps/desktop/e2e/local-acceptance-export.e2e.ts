import { expect, test, vi } from "vitest";
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { DESKTOP_DIR } from "./harness/paths";

const evidence = process.env.REELTERMINAL_LOCAL_ACCEPTANCE_DIR;

test.skipIf(!evidence)("installed app exports the same fixed project twice with fully decodable outputs", async () => {
  const launched = await launchApp();
  const { app, page, runDir } = launched;
  const results: unknown[] = [];
  try {
    await createProjectViaUI(page);
    const source = path.join(runDir, "fixed-logo.png");
    copyFileSync(path.join(DESKTOP_DIR, "build/icon.png"), source);
    await page.locator('input[type="file"][aria-label="Import media"]').setInputFiles(source);
    await page.locator("[data-live-media-id]").first().getByRole("button", { name: "Add to timeline", exact: true }).click();
    for (const label of ["first-export", "repeat-export"]) {
      const output = path.join(evidence!, `${label}.mp4`);
      expect(existsSync(output)).toBe(false);
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, output);
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByRole("radio", { name: "Custom", exact: true }).click();
      const started = performance.now();
      await page.getByRole("button", { name: "Start Export", exact: true }).click();
      await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 120_000 });
      await page.getByRole("button", { name: "Export", exact: true }).waitFor({ timeout: 120_000 });
      const seconds = (performance.now() - started) / 1000;
      execFileSync(process.env.REELTERMINAL_FFMPEG_PATH!, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"], { timeout: 30_000, windowsHide: true });
      const probe = JSON.parse(execFileSync(process.env.REELTERMINAL_FFPROBE_PATH!, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8", windowsHide: true }));
      const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
      expect(video.width).toBe(1920);
      expect(video.height).toBe(1080);
      expect(Number(probe.format.duration)).toBeGreaterThan(0);
      results.push({ label, seconds, bytes: statSync(output).size, video, duration: probe.format.duration, fullyDecoded: true });
      writeFileSync(path.join(evidence!, "installed-export-timing.json"), JSON.stringify(results, null, 2));
    }
    await page.screenshot({ path: path.join(evidence!, "installed-export-finished.png") });
  } finally {
    await launched.close();
  }
}, 300_000);
