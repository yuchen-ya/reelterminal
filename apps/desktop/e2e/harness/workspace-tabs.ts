import type { Page } from "playwright-core";

export async function openWorkspaceDirectory(page: Page) {
  if (await page.getByTestId("workbench-open-dialog").count()) return;
  await page.getByTestId("review-workspace-open").click();
  await page.getByTestId("workbench-open-dialog").waitFor();
}

export async function openOrCreateBoard(page: Page) {
  const active = page.locator('[data-testid^="board-tab-"]');
  if (await active.count()) {
    await active.first().click();
  } else {
    await openWorkspaceDirectory(page);
    await page.getByTestId("human-board-new").click();
  }
  await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
  await page.getByTestId("human-board-scene").locator(".excalidraw").waitFor({ timeout: 30_000 });
}
