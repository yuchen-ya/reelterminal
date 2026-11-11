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
  const nativeState = () => app.evaluate(({ BrowserWindow }) => {
    const state = (globalThis as any).fullscreenNavigation;
    return { ...state, isFullScreen: BrowserWindow.fromId(state.windowId)?.isFullScreen() };
  });
  let passed = false;
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const state = { windowId: win.id, platform: process.platform, entered: 0, left: 0, htmlEntered: 0, htmlLeft: 0, events: [] as string[] };
      (globalThis as any).fullscreenNavigation = state;
      for (const [event, counter] of [['enter-full-screen', 'entered'], ['leave-full-screen', 'left'], ['enter-html-full-screen', 'htmlEntered'], ['leave-html-full-screen', 'htmlLeft']] as const) {
        win.on(event, () => { state[counter]++; state.events.push(event); });
      }
    });
    await page.evaluate(() => {
      const events: Array<{ id: string; fullscreen: boolean }> = [];
      (window as any).fullscreenNavigationMenuEvents = events;
      window.reelterminal.onMenuAction(id => events.push({ id, fullscreen: !!document.fullscreenElement }));
    });
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
    let beforeEnter = await nativeState();
    const enterFullscreen = async () => {
      beforeEnter = await nativeState();
      await page.getByRole("button", { name: "Full Screen", exact: true }).click();
      await vi.waitFor(async () => {
        expect(await page.evaluate(() => document.fullscreenElement?.getAttribute("data-tour"))).toBe("preview");
        const state = await nativeState();
        expect(state.isFullScreen).toBe(true);
        // macOS native fullscreen is asynchronous. A true flag alone does not
        // establish that the Space transition finished before invoking a menu.
        // https://www.electronjs.org/docs/latest/api/browser-window#winisfullscreen
        if (state.platform === 'darwin') {
          expect(state.entered).toBeGreaterThan(beforeEnter.entered);
          expect(state.htmlEntered).toBeGreaterThan(beforeEnter.htmlEntered);
        }
      }, { timeout: 5_000 });
    };
    const assertExited = async () => {
      await vi.waitFor(async () => {
        expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
        const state = await nativeState();
        expect(state.isFullScreen).toBe(false);
        if (state.platform === 'darwin') {
          expect(state.left).toBeGreaterThan(beforeEnter.left);
          expect(state.htmlLeft).toBeGreaterThan(beforeEnter.htmlLeft);
        }
      }, { timeout: 5_000 });
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
    passed = true;
  } catch (error) {
    evidence.record('failure', error instanceof Error ? error.message : String(error));
    await evidence.screenshot('failure').catch(() => {});
    throw error;
  } finally {
    evidence.record('nativeFullscreen', await nativeState().catch(() => ({ unavailable: true })));
    evidence.record('menuEvents', await page.evaluate(() => (window as any).fullscreenNavigationMenuEvents).catch(() => []));
    evidence.record('rendererConsole', launched.output.rendererConsole.slice(-20));
    evidence.flush({ passed });
    await agent.close();
    await launched.close();
  }
});
