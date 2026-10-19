import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

test("Chinese caption design has a compact empty state and an actionable environment flow", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "caption-design-"));
  const config = path.join(directory, "audio.json");
  writeFileSync(
    config,
    JSON.stringify({
      python: path.join(directory, "missing.exe"),
      qwenPython: path.join(directory, "qwen-missing.exe"),
      separationPython: path.join(directory, "missing.exe"),
    }),
  );
  const launched = await launchApp({
    env: { REELTERMINAL_AUDIO_CONFIG: config },
  });
  const { page } = launched;
  const evidence = createEvidence("caption-design-zh", page);
  try {
    await createProjectViaUI(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "剪辑工具", exact: true }).click();
    await page.getByRole("button", { name: "自动字幕", exact: true }).click();
    expect(
      await page
        .getByRole("button", { name: "请先选择片段", exact: true })
        .isDisabled(),
    ).toBe(true);
    const actionBounds = (await page
      .getByRole("button", { name: "请先选择片段", exact: true })
      .boundingBox())!;
    const panelBounds = (await page
      .getByTestId("local-caption-panel")
      .boundingBox())!;
    expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
      panelBounds.y + panelBounds.height,
    );
    expect(actionBounds.y + actionBounds.height).toBeLessThan(
      (await page.getByTestId("timeline-tracks-scroll").boundingBox())!.y,
    );
    expect(await page.getByText(/Whisper/).count()).toBe(0);
    await page.getByText("可能占用数GB内存", { exact: true }).waitFor();
    await page.waitForTimeout(250);
    await evidence.screenshot("empty");
    await page.getByRole("button", { name: /SenseVoice/ }).click();
    expect(
      await page
        .getByRole("button", { name: /SenseVoice/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page.getByRole("button", { name: "环境设置", exact: true }).click();
    await page.getByText("Qwen ForcedAligner", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "重新检测", exact: true })
      .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(250);
    await evidence.screenshot("environment");
    await page
      .getByRole("button", { name: "让 Agent 配置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "复制配置提示词", exact: true })
      .click();
    await page.getByText("已复制", { exact: true }).waitFor();
    const prompt = await launched.app.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    expect(prompt).toContain("qwenAlignerModelDir");
    expect(prompt).toContain("--engine sensevoice");
    expect(prompt).toContain("CPU");
    await evidence.screenshot("agent-prompt");
    evidence.flush();
  } catch (error) {
    await evidence.screenshot("failure");
    throw error;
  } finally {
    await launched.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
