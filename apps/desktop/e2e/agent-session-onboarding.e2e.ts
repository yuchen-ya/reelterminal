/**
 * Agent Session onboarding (GUI) — first-run intro bubble, help popover, and
 * the "Open Agent Workspace" entry, driven with real UI input on the built
 * app (ADR 0004 human-side red line: Playwright mouse/keyboard only).
 *
 * Filesystem reveal itself is covered by the IPC unit seam. This GUI spec
 * verifies the entry without opening Finder or changing foreground apps.
 */
import { test, describe, beforeAll, afterAll } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { createProjectViaUI, waitForEditorReady } from "./harness/ui";

describe("agent session onboarding (GUI)", () => {
  let launched: LaunchedApp;

  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await waitForEditorReady(launched.page);
  }, 240_000);

  afterAll(async () => {
    await launched?.close();
  });

  test("first-run intro, help popover, and workspace entry", async () => {
    const page = launched.page;

    // Fresh profile → the first-run intro bubble shows next to the toggle.
    const intro = page.getByRole("status").filter({
      hasText: "Let an AI agent help you edit",
    });
    await intro.waitFor({ timeout: 30_000 });

    // "Learn more" opens the help popover and dismisses the intro for good.
    await intro.getByRole("button", { name: "Learn more" }).click();
    const popover = page.getByRole("dialog", { name: "What is Agent Session?" });
    await popover.waitFor({ timeout: 10_000 });
    await intro.waitFor({ state: "detached", timeout: 10_000 });
    await popover.getByText(/same undo history as yours/).waitFor({ timeout: 10_000 });

    // Keep GUI acceptance side-effect free. The entry remains discoverable;
    // its bridge invocation is covered by CollabStatusBar.test.tsx.
    await popover.getByRole("button", { name: /Open Agent Workspace/ }).waitFor();

    // Close + reopen via the help button next to the Agent Session toggle.
    await popover.getByRole("button", { name: "Close" }).click();
    await popover.waitFor({ state: "detached", timeout: 10_000 });
    await page.getByRole("button", { name: "About Agent Session" }).click();
    await popover.waitFor({ timeout: 10_000 });
    await popover.getByRole("button", { name: "Close" }).click();
    await popover.waitFor({ state: "detached", timeout: 10_000 });
  }, 120_000);
});
