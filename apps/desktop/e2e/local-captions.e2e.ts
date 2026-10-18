import { expect, test, vi } from "vitest";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

const config = process.env.REELTERMINAL_CAPTION_E2E_CONFIG;
const speech = process.env.REELTERMINAL_CAPTION_E2E_WAV;
test.skipIf(!config || !speech)("human generates local captions and undoes the entire batch", async () => {
  const launched = await launchApp({ env: { REELTERMINAL_AUDIO_CONFIG: config! } });
  const page = launched.page;
  const evidence = createEvidence("local-captions", page);
  try {
    await createProjectViaUI(page);
    const name = path.basename(speech!);
    await page.locator('input[type="file"][aria-label="Import media"]').setInputFiles(speech!);
    const assets = page.getByTestId("project-asset-browser");
    await assets.getByRole("button", { name: `Preview ${name}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Add to timeline", exact: true }).click();
    const source = page.getByTestId("timeline-tracks-scroll").getByRole("button", { name: `Select clip ${name}`, exact: true });
    await source.click();
    await page.getByRole("button", { name: "Editing Tools", exact: true }).click();
    await page.getByRole("button", { name: "Auto Captions", exact: true }).click();
    const generate = page.getByRole("button", { name: "Generate captions", exact: true });
    await vi.waitFor(async () => expect(await generate.isEnabled()).toBe(true), { timeout: 60_000 });
    await generate.click();
    await page.getByText("Captions added · undo available", { exact: true }).first().waitFor({ timeout: 120_000 });
    const timeline = page.getByTestId("timeline-tracks-scroll");
    expect(await timeline.getByRole("button", { name: /^Select text clip / }).count()).toBeGreaterThan(0);
    await evidence.screenshot("generated");
    await source.focus();
    await page.keyboard.press("Meta+z");
    await vi.waitFor(async () => expect(await timeline.getByRole("button", { name: /^Select text clip / }).count()).toBe(0));
    expect(await source.isVisible()).toBe(true);
    evidence.record("singleUndoPreservesSource", true);
    evidence.flush();
  } finally { await launched.close(); }
}, 180_000);
