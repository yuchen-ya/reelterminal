import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

test("compact instructions copy through the library and settings expose Agent configuration", async () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "rt-environment-e2e-"));
  const configPath = path.join(configDir, "audio.json");
  writeFileSync(configPath, JSON.stringify({ python: path.join(configDir, "missing-python.exe"), separationPython: path.join(configDir, "missing-separation.exe") }));
  const launched = await launchApp({ env: { REELTERMINAL_AUDIO_CONFIG: configPath } });
  const page = launched.page;
  const evidence = createEvidence("instruction-library-environment", page);
  try {
    await createProjectViaUI(page);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const board = page.getByTestId("collaboration-board");
    await board.getByRole("button", { name: "New instruction", exact: true }).click();
    await board.getByRole("textbox", { name: "Title", exact: true }).fill("Preview first");
    await board.getByRole("textbox", { name: "Detailed instruction" }).fill("Show a short sample before the whole video.");
    await board.getByRole("button", { name: "Add to project" }).click();
    const chip = board.getByRole("button", { name: "Preview first", exact: true });
    await chip.waitFor();
    expect(await board.getByRole("heading", { name: "Board", exact: true }).count()).toBe(0);
    expect((await chip.boundingBox())!.height).toBeLessThan(40);
    await chip.click({ button: "right" });
    await board.getByRole("menuitem", { name: "Save to library" }).click();
    await board.getByRole("status").getByText("Saved", { exact: true }).waitFor();
    await board.getByRole("button", { name: "Add", exact: true }).click();
    await board.getByRole("textbox", { name: "Search instructions" }).fill("Preview first");
    await board.getByRole("button", { name: "Preview first", exact: true }).nth(1).click();
    await board.getByRole("textbox", { name: "Title", exact: true }).fill("Project copy");
    await board.getByRole("button", { name: "Add to project" }).click();
    await board.getByRole("button", { name: "Project copy", exact: true }).waitFor();
    await evidence.screenshot("compact-board");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("radio", { name: "Models & environment", exact: true }).click();
    await settings.getByText("Configuration required", { exact: true }).first().waitFor();
    await settings.getByRole("button", { name: "Copy setup prompt" }).click();
    await settings.getByText("Copied", { exact: true }).waitFor();
    const prompt = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(prompt).toContain("environment set --file config.json");
    expect(prompt).toContain("environment test --file speech.wav");
    await evidence.screenshot("model-environment");
    evidence.record("copiedPromptHasCliAcceptance", true);
    evidence.flush();
  } finally {
    await launched.close();
    rmSync(configDir, { recursive: true, force: true });
  }
}, 120_000);
