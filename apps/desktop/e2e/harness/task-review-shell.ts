import type { Page } from "playwright-core";

export type TaskReviewLauncherItem =
  | "stage"
  | "overview"
  | "export"
  | "agent"
  | "copy"
  | "import"
  | "files"
  | "criteria";

/**
 * Open a launcher destination on the rewritten task-review shell.
 *
 * The old top-bar "目录|全局" scene switch (`task-review-scene-switch`) was
 * removed: the spotlight tool card's flip button (`spotlight-flip-btn`) is now
 * the only way onto the 3x3 launcher grid, and each grid tile
 * (`task-review-launcher-*`) opens one scene or utility. The tiles only exist
 * while the card is on its launcher face, so flip first unless the requested
 * tile is already showing (the card stays on whichever face it was left on).
 */
export async function openLauncher(page: Page, item: TaskReviewLauncherItem): Promise<void> {
  const tile = page.getByTestId(`task-review-launcher-${item}`);
  if (!(await tile.isVisible())) {
    await page.getByTestId("agent-spotlight-card").waitFor();
    await page.getByTestId("spotlight-flip-btn").click();
  }
  await tile.click();
}

/**
 * Global overview overlay (old "全局" scene-switch destination). Wait for the
 * overview scene itself, not the card face.
 */
export async function openGlobalScene(page: Page): Promise<void> {
  await openLauncher(page, "overview");
  await page.getByTestId("task-review-global-scene").waitFor();
}

/**
 * Directory scene overlay (old "目录" scene-switch destination). The directory
 * host (`task-review-directory-host`) stays mounted but carries the `hidden`
 * class under every other scene, so only its visibility expresses "directory
 * is active"; assertions about file rows go through its visible children.
 */
export async function openDirectoryScene(page: Page): Promise<void> {
  await openLauncher(page, "files");
  await page.getByTestId("task-review-directory-host").waitFor();
}

/**
 * Switch to the note tab on the tool card's text body (改词|批注|口径). The
 * feedback editor (`task-review-unit-note` and its candidate controls) lives
 * behind this tab; compare/group scenes render their own always-visible note
 * editor and do not use tabs.
 */
export async function openNoteTab(page: Page): Promise<void> {
  await page.getByTestId("task-review-card-tab-note").click();
}
