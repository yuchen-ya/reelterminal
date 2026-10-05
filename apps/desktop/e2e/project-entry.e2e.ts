import { test, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { CHANNELS } from "../src/shared/channels";

test("new project chooser preserves the editor and open uses the active project folder", async () => {
  const launched = await launchApp();
  const { app, page, runDir } = launched;
  page.setDefaultTimeout(15_000);
  const projects = path.join(runDir, "projects");
  mkdirSync(projects);
  const pickedFile = path.join(projects, "picked.oreel");
  writeFileSync(pickedFile, JSON.stringify({
    id: "picked-project", name: "Picked Project", createdAt: Date.now(), modifiedAt: Date.now(),
    settings: { width: 1080, height: 1920, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], markers: [], subtitles: [] },
    mediaLibrary: { items: [] },
  }));

  try {
    // The harness isolates userData, so supply an active folder through the real
    // data-root IPC and capture native dialog options without opening an OS modal.
    await app.evaluate(({ ipcMain, dialog }, { channel, projects }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ active: true, projects }));
      const state = { lastFolder: "", pickedFile: "" };
      (globalThis as unknown as { projectEntryTest: typeof state }).projectEntryTest = state;
      dialog.showOpenDialog = async (_window, options) => {
        state.lastFolder = options.defaultPath ?? "";
        return { canceled: !state.pickedFile, filePaths: state.pickedFile ? [state.pickedFile] : [] };
      };
    }, { channel: CHANNELS.dataRootGetInfo, projects });

    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    await vi.waitFor(async () => {
      expect(await app.evaluate(() => (globalThis as unknown as { projectEntryTest: { lastFolder: string } }).projectEntryTest.lastFolder)).toBe(projects);
    });
    expect(await page.getByRole("heading", { name: "New Project", exact: true }).isVisible()).toBe(true);

    await page.getByLabel(/^Horizontal /).click();
    await page.getByRole("dialog", { name: "Welcome to ReelTerminal" }).waitFor();
    await page.getByRole("button", { name: "Skip tour", exact: true }).last().click();
    await page.getByTestId("desktop-workspace").waitFor();
    await page.getByRole("button", { name: "Horizontal", exact: true }).click();
    await page.getByRole("button", { name: "New Project", exact: true }).click();
    await page.getByRole("button", { name: "Back to current project", exact: true }).waitFor();
    expect(await page.getByTestId("desktop-workspace").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Back to current project", exact: true }).click();
    expect(await page.getByRole("button", { name: "Horizontal", exact: true }).isVisible()).toBe(true);

    await app.evaluate(({ BrowserWindow }, channel) => {
      BrowserWindow.getAllWindows()[0].webContents.send(channel, "newProject");
    }, CHANNELS.menuAction);
    await page.getByRole("button", { name: "Back to current project", exact: true }).waitFor();
    await page.getByLabel(/^Vertical /).click();
    await page.getByRole("button", { name: "Vertical", exact: true }).waitFor();

    await app.evaluate(({ BrowserWindow }, { channel, pickedFile }) => {
      (globalThis as unknown as { projectEntryTest: { pickedFile: string } }).projectEntryTest.pickedFile = pickedFile;
      BrowserWindow.getAllWindows()[0].webContents.send(channel, "open");
    }, { channel: CHANNELS.menuAction, pickedFile });
    await page.getByRole("button", { name: "Picked Project", exact: true }).waitFor();
    expect(await page.getByTestId("desktop-workspace").isVisible()).toBe(true);
  } finally {
    // Leave temporary diagnostics to the existing harness cleanup policy.
    await launched.close();
  }
});
