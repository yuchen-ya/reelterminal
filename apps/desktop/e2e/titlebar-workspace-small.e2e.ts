import { expect, test } from "vitest";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";

test("workspace tabs remain clickable with an open project in a narrow window", async () => {
  const launched = await launchApp();
  try {
    await createProjectViaUI(launched.page);
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1023, 720));
    const tab = launched.page.getByRole("tab", { name: "Review Workspace" });
    const tabBox = await tab.boundingBox();
    const exportBox = await launched.page.getByRole("button", { name: "导出与整理" }).boundingBox();
    expect(tabBox).not.toBeNull();
    expect(exportBox).not.toBeNull();
    expect(tabBox!.x + tabBox!.width).toBeLessThanOrEqual(exportBox!.x);
    await tab.click({ timeout: 5_000 });
    expect(await tab.getAttribute("aria-selected")).toBe("true");
    await launched.page.getByTestId("review-page").waitFor({ state: "visible" });
    await launched.page.getByRole("tab", { name: "Video Editing" }).click();
    expect(await launched.page.getByRole("tab", { name: "Video Editing" }).getAttribute("aria-selected")).toBe("true");
  } finally {
    await launched.close();
  }
}, 60_000);
