import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { ARTIFACTS_DIR, DESKTOP_DIR } from "./harness/paths";

test("project assets filter audio, inspect saved media and import subtitles through the main picker", async () => {
  const launched = await launchApp();
  const { page, runDir } = launched;
  page.setDefaultTimeout(15_000);
  try {
    await createProjectViaUI(page);
    const imagePath = path.join(runDir, "scene.png");
    const audioPath = path.join(runDir, "voice.wav");
    const subtitlePath = path.join(runDir, "captions.srt");
    copyFileSync(path.join(DESKTOP_DIR, "build/icon.png"), imagePath);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-y", audioPath], { windowsHide: true });
    writeFileSync(subtitlePath, "\uFEFF1\r\n00:00:00,000 --> 00:00:01,000\r\nHello captions\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\n第二句字幕");
    const picker = page.locator('input[type="file"][aria-label="Import media"]');
    await picker.setInputFiles([imagePath, audioPath]);
    const browser = page.getByTestId("project-asset-browser");
    await browser.getByText("voice.wav", { exact: true }).waitFor();
    const types = browser.getByRole("group", { name: "Media type" });
    await types.getByRole("button", { name: "Audio", exact: true }).click();
    expect(await browser.locator("[data-live-media-id]").count()).toBe(1);
    expect(await browser.getByText("scene.png", { exact: true }).count()).toBe(0);

    await browser.locator("[data-live-media-id]").getByRole("button", { name: "Add to timeline", exact: true }).click();
    await page.getByRole("button", { name: "Select clip voice.wav", exact: true }).waitFor();
    await page.getByRole("button", { name: "Select clip voice.wav", exact: true }).click();
    await browser.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByText("Save timeline selection", { exact: true }).click();
    await browser.getByPlaceholder("Name this clip or combination").fill("Voice excerpt");
    await browser.getByRole("button", { name: "Save", exact: true }).click();
    await browser.getByText("Voice excerpt", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Archives", exact: true }).click();
    await page.getByTestId("create-save-point").click();
    await page.getByText(/^Save point .* created/).first().waitFor();
    await browser.getByRole("button", { name: "By save point", exact: true }).click();
    const nodeButton = browser.locator('[data-testid^="asset-node-"]').first();
    const nodeId = (await nodeButton.getAttribute("data-testid"))?.slice("asset-node-".length);
    await nodeButton.click();
    await browser.getByTestId("node-assets").waitFor();
    await browser.getByRole("button", { name: "Clear save-point filter" }).click();
    expect(nodeId).toBeTruthy();
    await page.getByTestId(`version-node-${nodeId}`).click();
    await page.getByRole("button", { name: "View this node's media", exact: true }).click();
    expect(await browser.getByRole("button", { name: "Clear save-point filter" }).isVisible()).toBe(true);
    await browser.getByTestId("node-assets").getByText("voice.wav", { exact: true }).waitFor();
    expect(await browser.getByTestId("node-assets").getByText("Used in timeline", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByTestId("version-preview-banner").count()).toBe(0);
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await browser.getByRole("combobox", { name: "Sort media" }).selectOption("longest");
    await browser.getByTestId("node-assets").getByRole("button", { name: "voice.wav", exact: true }).click();
    await browser.getByTestId("media-node-relations").waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "project-node-media.png") });

    await browser.getByRole("button", { name: "Clear save-point filter" }).click();
    expect(await browser.getByRole("combobox", { name: "Sort media" }).inputValue()).toBe("longest");
    await picker.setInputFiles(subtitlePath);
    await browser.getByTestId("project-subtitles").getByText("Hello captions", { exact: true }).waitFor();
    expect(await browser.getByTestId("project-subtitles").getByText("第二句字幕", { exact: true }).isVisible()).toBe(true);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "project-subtitles.png") });
    await browser.getByTestId("project-subtitles").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await browser.getByTestId("project-subtitles").getByText("Hello captions", { exact: true }).waitFor({ state: "hidden" });
  } finally {
    await launched.close();
  }
});
