import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";
import { DESKTOP_DIR } from "./harness/paths";

describe("collaboration instructions in the existing board", () => {
  let launched: LaunchedApp;
  const cli = (args: string[]) => new Promise<{ ok: boolean; value: any; error?: unknown }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), ...args], {
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("CLI did not return JSON")); }
    });
  });
  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await launched.waitForEndpointFile();
  });
  afterAll(async () => { await launched?.close(); });

  test("adds user guidance through the GUI, reads through CLI, keeps tasks and survives undo and reopen", async () => {
    let page = launched.page;
    const evidence = createEvidence("collaboration-instructions", page);
    const context = await cli(["context", "--compact"]);
    expect(context.ok).toBe(true);
    expect(context.value.collaborationInstructions).toEqual({ enabledCount: 0, items: [] });
    const target = ["--project-id", context.value.identity.projectId, "--workspace-id", context.value.identity.workspaceId];
    const read = () => cli(["call", "collaboration.instructions.get", ...target]);
    expect((await read()).value.instructions).toEqual([]);
    expect((await cli(["call", "collaboration.instructions.get"])).ok).toBe(false);
    expect((await cli(["call", "collaboration.instructions.get", "--project-id", context.value.identity.projectId, "--workspace-id", "missing-workspace"])).ok).toBe(false);
    await page.getByTestId("requirement-board-entry").click();
    await page.getByRole("tab", { name: "Collaboration instructions", exact: true }).click();
    await page.getByRole("button", { name: "Add instruction", exact: true }).waitFor();
    await evidence.screenshot("empty");
    await page.getByRole("button", { name: "Add instruction", exact: true }).click();
    await page.getByRole("button", { name: "Guide me visually", exact: true }).click();
    // Complete built-ins are now added directly. Edit the resulting chip;
    // keep proving that draft changes do not reach CLI reads before Save.
    await page.getByRole("switch", { name: "Enable Guide me visually", exact: true }).waitFor();
    const preset = await read();
    expect(preset.ok, JSON.stringify(preset.error)).toBe(true);
    expect(preset.value.instructions).toHaveLength(1);
    expect(preset.value.instructions[0].title).toBe("Guide me visually");
    await page.getByRole("button", { name: "Guide me visually", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Show me a prototype");
    await page.getByRole("textbox", { name: "Detailed instruction" }).fill("When I dislike the direction, show two short visual prototypes before remaking the whole video.");
    expect((await read()).value.instructions).toEqual(preset.value.instructions);
    await evidence.screenshot("edit");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("switch", { name: "Enable Show me a prototype" }).waitFor();
    const saved = await read();
    expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
    expect(saved.value.instructions).toHaveLength(1);
    expect(saved.value.instructions[0].title).toBe("Show me a prototype");
    const compact = await cli(["context", "--compact"]);
    expect(compact.value.collaborationInstructions.items[0].id).toBe(saved.value.instructions[0].id);
    await evidence.screenshot("populated");
    await page.getByRole("switch", { name: "Enable Show me a prototype" }).click();
    expect((await read()).value.instructions).toEqual([]);
    await enableAgentSessionViaUI(page, launched.endpointFile);
    // The persistent startup prompt overlaps the board tabs at small window sizes.
    // Dismiss it through the same control available to a user before continuing.
    await page.getByTestId("notification-toast").filter({ hasText: "Copy Agent startup prompt" })
      .getByRole("button", { name: "Dismiss notification" }).click();
    const revision = (await read()).value.revision;
    expect((await cli(["history", "undo", ...target, "--expected-revision", String(revision)])).ok).toBe(true);
    expect((await read()).value.instructions).toEqual(saved.value.instructions);
    await page.getByRole("tab", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "New requirement" }).click();
    await page.getByPlaceholder("Describe the outcome in one line").fill("Review the opening");
    await page.getByRole("button", { name: "Publish to board" }).click();
    await page.getByRole("textbox", { name: "Task title" }).waitFor();
    expect((await cli(["requirements", "list", ...target])).value.requirements[0].title).toBe("Review the opening");
    const current = await read();
    expect((await cli(["call", "node.save", ...target, "--expected-revision", String(current.value.revision), "--idempotency-key", "collaboration-instructions-e2e-save"])).ok).toBe(true);
    launched = await launched.relaunch();
    page = launched.page;
    await openRecentProjectViaUI(page, "Horizontal");
    await launched.waitForEndpointFile();
    const reopened = await read();
    expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
    expect(reopened.value.instructions).toEqual(saved.value.instructions);
    evidence.bindPage(page);
    await page.getByTestId("requirement-board-entry").click();
    await page.getByRole("tab", { name: "Collaboration instructions", exact: true }).click();
    await page.getByRole("button", { name: "Show me a prototype" }).waitFor();
    await evidence.screenshot("reopened");
    evidence.record("instructionCount", reopened.value.instructions.length);
    evidence.record("projectId", reopened.value.projectId);
    evidence.flush();
  }, 120_000);
});
