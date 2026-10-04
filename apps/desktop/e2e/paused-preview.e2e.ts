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
    await launched.page.getByText("Saved", { exact: true }).waitFor();

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
