import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";

test("desktop body portals share dark tokens and project name/detail rows have spacing", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const launched = await launchApp({ runDir: job ? path.join(job, "work", `portals-${crypto.randomUUID()}`) : undefined, keepRunDir: true });
  const evidence = path.join(job ?? launched.runDir, "evidence", "desktop-portals");
  mkdirSync(evidence, { recursive: true });
  const observations: Record<string, unknown> = {};
  const darkBackground = async (selector: string) => {
    const result = await launched.page.locator(selector).evaluate(element => {
      const color = getComputedStyle(element).backgroundColor;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const rgba = Array.from(context.getImageData(0, 0, 1, 1).data);
      return { color, rgba };
    });
    expect(result.rgba[3]).toBe(255);
    expect(Math.max(...result.rgba.slice(0, 3))).toBeLessThan(80);
    return result;
  };
  try {
    await createProjectViaUI(launched.page);
    await launched.page.getByRole("button", { name: "Horizontal", exact: true }).click();
    await launched.page.getByRole("button", { name: "New Project", exact: true }).click();
    await launched.page.getByLabel(/^Vertical /).click();
    await launched.page.getByRole("button", { name: "Vertical", exact: true }).click();
    const menu = launched.page.getByTestId("project-switch-menu");
    await menu.waitFor();
    await launched.page.waitForTimeout(350);
    observations.projectMenu = await darkBackground('[data-testid="project-switch-menu"]');
    for (const name of ["Open Horizontal", "Try another cut"]) {
      const pair = menu.getByRole("button", { name, exact: true }).locator("span.flex-col > span");
      const boxes = await Promise.all((await pair.all()).map(element => element.boundingBox()));
      expect(boxes).toHaveLength(2);
      expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
    }
    await launched.page.screenshot({ path: path.join(evidence, "project-menu-dark.png") });
    await menu.getByRole("button", { name: "Open Horizontal", exact: true }).click();
    const notification = launched.page.getByTestId("notification-toast").filter({ hasText: 'Switched to "Horizontal"' });
    await notification.waitFor();
    await launched.page.waitForTimeout(350);
    const color = await notification.evaluate(element => getComputedStyle(element).backgroundColor);
    observations.switchNotificationColor = color;
    expect(color).not.toBe("rgb(255, 255, 255)");
    await launched.page.screenshot({ path: path.join(evidence, "switch-notification-dark.png") });
    await launched.page.getByRole("button", { name: "Settings", exact: true }).press("Enter");
    await launched.page.getByRole("dialog").waitFor();
    await launched.page.waitForTimeout(350);
    observations.settings = await darkBackground('[role="dialog"]');
    await launched.page.screenshot({ path: path.join(evidence, "settings-dark.png") });
  } finally {
    writeFileSync(path.join(evidence, "portals.json"), JSON.stringify(observations, null, 2));
    await launched.close({ keepRunDir: true });
  }
}, 120_000);
