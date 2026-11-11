import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { createProjectViaUI, openRecentProjectViaUI } from "./harness/ui";

test("a saved title paints immediately after reopening a paused project", async () => {
  let launched = await launchApp();
  try {
    await createProjectViaUI(launched.page);
    await launched.page.getByRole("button", { name: "Text", exact: true }).click();
    await launched.page.getByRole("button", { name: "Add Title", exact: true }).click();
    await launched.page.getByRole("button", { name: "Select text clip New Title", exact: true }).waitFor();
    await launched.page.keyboard.press("ControlOrMeta+s");
    await launched.page.getByTestId("notification-toast").getByText("Current edits saved", { exact: true }).waitFor();

    launched = await launched.relaunch();
    await openRecentProjectViaUI(launched.page, "Horizontal");
    await vi.waitFor(async () => {
      const differentPixels = await launched.page.getByTestId("preview-canvas").evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let offset = 4; offset < pixels.length; offset += 4) {
          if (Math.abs(pixels[offset]! - pixels[0]!) > 20 ||
              Math.abs(pixels[offset + 1]! - pixels[1]!) > 20 ||
              Math.abs(pixels[offset + 2]! - pixels[2]!) > 20) count += 1;
        }
        return count;
      });
      expect(differentPixels).toBeGreaterThan(100);
    }, { timeout: 15_000, interval: 250 });
    expect(await launched.page.getByRole("button", { name: "Play", exact: true }).isVisible()).toBe(true);
  } finally {
    await launched.close();
  }
});

test("hiding a paused title clears its previously painted pixels", async () => {
  const launched = await launchApp();
  try {
    const page = launched.page;
    await createProjectViaUI(page);
    const differentPixels = () => page.getByTestId("preview-canvas").evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let offset = 4; offset < pixels.length; offset += 4) {
        if (Math.abs(pixels[offset]! - pixels[0]!) > 20 ||
            Math.abs(pixels[offset + 1]! - pixels[1]!) > 20 ||
            Math.abs(pixels[offset + 2]! - pixels[2]!) > 20) count += 1;
      }
      return count;
    });
    // An unauthored project shows the import hint. A project with a hidden
    // authored title has real timeline content and renders the solid project
    // background instead of returning to that empty-project hint.
    await vi.waitFor(async () => expect(await differentPixels()).toBeGreaterThan(100), { timeout: 15_000 });
    const emptyPixels = await differentPixels();
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.getByRole("button", { name: "Add Title", exact: true }).click();
    await page.getByRole("button", { name: "Select text clip New Title", exact: true }).waitFor();
    await vi.waitFor(async () => {
      const titlePixels = await differentPixels();
      expect(titlePixels).toBeGreaterThan(100);
      expect(Math.abs(titlePixels - emptyPixels)).toBeGreaterThan(100);
    }, { timeout: 15_000 });
    // Track headers and lanes are separate DOM columns. Match their vertical
    // positions to target the row containing the new title.
    const titleBox = await page.getByRole("button", { name: "Select text clip New Title", exact: true }).boundingBox();
    if (!titleBox) throw new Error("Title clip is not visible");
    const hideButtons = await page.getByTestId("timeline-track-headers-scroll")
      .getByRole("button", { name: "Hide track", exact: true }).all();
    const titleCenterY = titleBox.y + titleBox.height / 2;
    let target = null as typeof hideButtons[number] | null;
    for (const button of hideButtons) {
      const box = await button.boundingBox();
      if (box && Math.abs(box.y + box.height / 2 - titleCenterY) < titleBox.height) {
        target = button;
        break;
      }
    }
    if (!target) throw new Error("Could not find the title track header");
    await target.click();
    await vi.waitFor(async () => expect(await differentPixels()).toBeLessThan(100), { timeout: 15_000 });
  } finally {
    await launched.close();
  }
}, 60_000);
