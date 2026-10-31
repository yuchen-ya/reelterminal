import { expect, test } from "vitest";
import { launchApp } from "./harness/launch";
import { createProjectViaUI, disableAgentSessionViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

test("workspace tabs remain clickable with an open project in a narrow window", async () => {
  const launched = await launchApp();
  try {
    await createProjectViaUI(launched.page);
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1023, 720));
    const tab = launched.page.getByRole("tab", { name: "Review Workspace" });
    const tabBox = await tab.boundingBox();
    const exportBox = await launched.page.getByRole("button", { name: /^(Export|导出)$/ }).boundingBox();
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


test("persistent startup notices leave narrow-window workspace tabs reachable", async () => {
  const launched = await launchApp();
  const page = launched.page;
  const evidence = createEvidence("titlebar-persistent-toast", page);
  try {
    await createProjectViaUI(page);
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1023, 720));
    await launched.waitForEndpointFile();
    await disableAgentSessionViaUI(page, launched.endpointFile);
    await enableAgentSessionViaUI(page, launched.endpointFile);
    const notice = page.getByTestId("notification-toast").filter({ hasText: "Copy Agent startup prompt" });
    await notice.waitFor({ state: "visible" });
    const review = page.getByRole("tab", { name: "Review Workspace" });
    const reviewBox = await review.boundingBox();
    const noticeBox = await notice.boundingBox();
    expect(reviewBox).not.toBeNull();
    expect(noticeBox).not.toBeNull();
    expect(noticeBox!.y).toBeGreaterThanOrEqual(reviewBox!.y + reviewBox!.height);
    evidence.record("layout", { review: reviewBox, notice: noticeBox });
    await evidence.screenshot("notice-below-navigation");
    await review.click({ timeout: 5_000 });
    expect(await review.getAttribute("aria-selected")).toBe("true");
    await page.getByTestId("review-page").waitFor({ state: "visible" });
    const video = page.getByRole("tab", { name: "Video Editing" });
    await video.click({ timeout: 5_000 });
    expect(await video.getAttribute("aria-selected")).toBe("true");
    expect(await notice.isVisible()).toBe(true);
    await notice.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await notice.waitFor({ state: "hidden" });
  } finally {
    if (!page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await launched.close();
  }
}, 90_000);
