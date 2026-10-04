import { test, expect, vi } from "vitest";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";

test("first-time user can find help, finish the tour, import, edit, save and export", async () => {
  const launched = await launchApp();
  const { app, page, runDir } = launched;
  page.setDefaultTimeout(15_000);
  try {
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await page.getByRole("dialog", { name: "Help", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Interface tour" }).isDisabled()).toBe(true);
    await page.getByRole("dialog", { name: "Help", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await page.getByLabel(/^Horizontal /).click();
    await page.getByRole("dialog", { name: "Welcome to ReelTerminal" }).waitFor();
    await page.screenshot({ path: path.join(runDir, "first-tour.png") });
    for (let index = 0; index < 7; index += 1) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
    }
    await page.getByRole("button", { name: "Get Started", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.reload();
    await page.getByLabel(/^Horizontal /).click();
    await page.getByTestId("agent-access-status").waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);

    await page.getByRole("button", { name: "Help", exact: true }).click();
    await page.getByRole("button", { name: "Interface tour" }).click();
    await page.getByRole("dialog", { name: "Welcome to ReelTerminal" }).waitFor();
    await page.getByRole("button", { name: "Skip tour", exact: true }).last().click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    const sourcePath = path.join(runDir, "first-media.png");
    copyFileSync(path.join(DESKTOP_DIR, "build/icon.png"), sourcePath);
    await page.locator('input[type="file"][aria-label="Import media"]').setInputFiles(sourcePath);
    await page.locator("[data-live-media-id]").first().dblclick({ position: { x: 15, y: 15 } });
    await page.getByRole("button", { name: "Select clip first-media.png", exact: true }).waitFor();
    await page.getByRole("button", { name: "Select clip first-media.png", exact: true }).click();
    await page.keyboard.press("Home");
    for (let frame = 0; frame < 30; frame += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await page.keyboard.press("s");
    await vi.waitFor(async () => {
      expect(await page.locator('[data-live-editor-target-kind="clip"]').count()).toBe(2);
    });
    await page.keyboard.press("ControlOrMeta+z");
    await vi.waitFor(async () => {
      expect(await page.locator('[data-live-editor-target-kind="clip"]').count()).toBe(1);
    });
    await page.keyboard.press("ControlOrMeta+s");
    await page.getByText("Saved", { exact: true }).waitFor();

    const outputPath = path.join(runDir, "first-export.mp4");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, outputPath);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("radio", { name: "Custom", exact: true }).click();
    await page.getByRole("button", { name: "Start Export", exact: true }).click();
    await vi.waitFor(() => expect(existsSync(outputPath)).toBe(true), { timeout: 120_000 });
    await page.getByRole("button", { name: "Export", exact: true }).waitFor({ timeout: 120_000 });
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);
    execFileSync(process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg", [
      "-v", "error", "-i", outputPath, "-f", "null", "-",
    ], { timeout: 30_000 });
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
});
