import { test, expect } from "vitest";
import { launchApp } from "./harness/launch";

test("player controls remain readable and reachable at narrow widths in both languages", async () => {
  const launched = await launchApp();
  const { app, page } = launched;
  page.setDefaultTimeout(15_000);
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(800, 600));
    for (const language of ["en", "zh-CN"]) {
      await page.evaluate((language) => localStorage.setItem("openreel-locale", language), language);
      await page.reload();
      await page.getByLabel(language === "en" ? /^Horizontal / : /^横屏 /).click();
      // The isolated profile shows the first-use tour once.
      const skipTour = page.getByRole("button", { name: language === "en" ? "Skip tour" : "跳过导览", exact: true }).last();
      if (language === "en") {
        await skipTour.waitFor();
        await skipTour.click();
      }
      const controls = page.getByTestId("preview-controls");
      await controls.waitFor();
      for (const width of [1600, 1200, 960]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
        const layout = await controls.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
            buttons: [...element.querySelectorAll("button")].map((button) => {
              const rect = button.getBoundingClientRect();
              return { label: button.getAttribute("aria-label"), inside: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 };
            }),
          };
        });
        expect(layout.scrollWidth, `${language} at ${width}px`).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.buttons.filter((button) => !button.inside), `${language} at ${width}px`).toEqual([]);
        const review = controls.getByRole("button", { name: language === "en" ? "Create review task" : "按帧段创建审片任务", exact: true });
        const bounds = await review.boundingBox();
        expect(bounds?.width).toBe(34);
        expect(bounds?.height).toBe(34);
        await review.click();
        const form = page.getByRole("dialog", { name: language === "en" ? "Create review task" : "按帧段创建审片任务", exact: true });
        await form.waitFor();
        expect(await form.locator("input").count()).toBe(3);
        await page.keyboard.press("Escape");
        await form.waitFor({ state: "hidden" });
      }
    }
  } finally {
    await launched.close();
  }
});
