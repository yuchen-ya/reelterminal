import { expect, test, vi } from "vitest";
import type { ElectronApplication } from "playwright-core";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";

async function invokeNativeMenu(app: ElectronApplication, label: string) {
  // Playwright keyboard input does not invoke OS accelerators. Exercise their
  // installed menu callbacks, without injecting renderer actions or stores.
  await app.evaluate(({ Menu }, label) => {
    const item = Menu.getApplicationMenu()!.items
      .flatMap(menu => menu.submenu?.items ?? [])
      .find(item => item.label === label)!;
    item.click();
  }, label);
}

test("fullscreen preview yields to project selection and desktop dialogs without locking mouse input", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const { page, app } = launched;
  const evidence = createEvidence("fullscreen-navigation", page);
  try {
    await createProjectViaUI(page);
    const identity = async () => {
      const context = value(await agent.callCommand<{
        identity: { projectId: string; workspaceId: string; projectEpoch: string };
        projectRevision: number;
      }>("editor.get_context"));
      return { identity: context.identity, revision: context.projectRevision };
    };
    const original = await identity();
    const editor = (await page.getByTestId("desktop-workspace").elementHandle())!;
    const enterFullscreen = async () => {
      await page.getByRole("button", { name: "Full Screen", exact: true }).click();
      await vi.waitFor(async () => {
        expect(await page.evaluate(() => document.fullscreenElement?.getAttribute("data-tour"))).toBe("preview");
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
      });
    };
    const assertExited = async () => {
      await vi.waitFor(async () => {
        expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
      });
    };

    await enterFullscreen();
    await invokeNativeMenu(app, "New Project");
    const back = page.getByRole("button", { name: "Back to current project", exact: true });
    await back.waitFor();
    await assertExited();
    await evidence.screenshot("project-chooser");
    await back.click();
    expect(await editor.evaluate(element => element.isConnected && !element.closest("[hidden]"))).toBe(true);
    expect(await identity()).toEqual(original);
    evidence.record("projectPreserved", original);

    for (const { label, close } of [
      { label: "ReelTerminal Help", close: "Close" },
      { label: "Settings…", close: "Close dialog" },
      { label: "Export…", close: "Cancel" },
    ]) {
      await enterFullscreen();
      await invokeNativeMenu(app, label);
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await assertExited();
      const closeButton = dialog.getByRole("button", { name: close, exact: true });
      // Playwright's normal click must reach the dialog; DOM presence alone
      // previously passed while the fullscreen layer hid the entire portal.
      await closeButton.click();
      await dialog.waitFor({ state: "hidden" });
      await vi.waitFor(async () => expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe("auto"));
      expect(await identity()).toEqual(original);
      evidence.record(label, { exitedFullscreen: true, mouseDismissedDialog: true });
    }
    // Normal preview fullscreen remains available after these transitions.
    await enterFullscreen();
    await page.getByRole("button", { name: "Exit Full Screen", exact: true }).click();
    await assertExited();
    await evidence.screenshot("returned-editor");
  } finally {
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});
