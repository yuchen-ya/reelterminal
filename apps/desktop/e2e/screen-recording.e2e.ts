import { test, expect } from "vitest";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";

test("asset recorder opens, encodes a synthetic stream and imports the completed recording", async () => {
  const launched = await launchApp();
  const { page } = launched;
  page.setDefaultTimeout(20_000);
  try {
    await createProjectViaUI(page);
    // Only replace capture permission/source acquisition. MediaRecorder,
    // countdown, controls, WebM encoding and project import all run for real.
    // This deliberately never captures the user's desktop or microphone.
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext("2d")!;
        const timer = setInterval(() => {
          ctx.fillStyle = "#155e46";
          ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = "#fff";
          ctx.fillText(`Recording test ${Date.now()}`, 20, 80);
        }, 30);
        const stream = canvas.captureStream(30);
        Object.assign(window, { recordingTestStream: stream });
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { clearInterval(timer); stop(); };
        }
        return stream;
      };
    });
    await page.getByTestId("project-asset-browser").getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByText("Record", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Screen Recording", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Start Recording", exact: true }).click();
    await page.getByRole("button", { name: "Pause recording", exact: true }).click();
    await page.getByRole("button", { name: "Resume recording", exact: true }).click();
    await page.getByText("0:02", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    const recording = page.getByTestId("project-asset-browser").locator("[data-live-media-id]");
    await page.getByTestId("project-asset-browser").getByText(/^Screen_.*\.webm$/).waitFor();
    expect(await recording.count()).toBe(1);
    expect(await dialog.count()).toBe(0);

    // Stopping via the OS sharing control must also deliver the result.
    await page.getByTestId("project-asset-browser").getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByText("Record", { exact: true }).click();
    await dialog.getByRole("button", { name: "Start Recording", exact: true }).click();
    await page.getByRole("button", { name: "Stop recording", exact: true }).waitFor();
    await page.getByText("0:02", { exact: true }).last().waitFor();
    await page.evaluate(() => {
      const stream = (window as unknown as { recordingTestStream: MediaStream }).recordingTestStream;
      stream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-asset-browser"] [data-live-media-id]').length === 2);
    expect(await dialog.count()).toBe(0);
    expect(launched.output.rendererConsole.filter(line => line.startsWith("[pageerror]"))).toEqual([]);
  } catch (error) {
    console.error(await page.locator("body").innerText());
    console.error(launched.output.rendererConsole.join("\n"));
    throw error;
  } finally {
    await launched.close();
  }
});
