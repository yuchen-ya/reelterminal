import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createProjectViaUI } from "./harness/ui";

test("library saves and reveals a durable project file and permanently deletes a selected batch", async () => {
  let launched = await launchApp();
  const filePath = path.join(launched.runDir, "library-save.oreel");
  const page = () => launched.page;
  const library = () => page().getByTestId("project-library");
  const menu = async (name: string, action: string) => {
    await library().getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await page().getByRole("menuitem", { name: action, exact: true }).click();
  };
  const showLibrary = async (name: string) => {
    await page().getByRole("button", { name, exact: true }).click();
    await page().getByRole("button", { name: "New Project", exact: true }).click();
    await library().waitFor();
  };
  const confirm = async () => {
    await page().getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page().getByRole("dialog").waitFor({ state: "hidden" });
  };
  const observeReveal = async () => {
    // Keep native UI boundaries deterministic. Saving still uses the real
    // preload/main IPC and filesystem; revealing must reach Electron's shell.
    await launched.app.evaluate(({ shell }) => {
      const state = { path: "" };
      (globalThis as unknown as { libraryReveal: typeof state }).libraryReveal = state;
      shell.showItemInFolder = (path) => { state.path = path; };
    });
  };
  const revealedPath = () => launched.app.evaluate(() =>
    (globalThis as unknown as { libraryReveal: { path: string } }).libraryReveal.path,
  );
  try {
    await createProjectViaUI(page());
    await showLibrary("Horizontal");
    await observeReveal();
    await menu("Horizontal", "Show saved project file");
    await library().getByRole("alert").getByText(/Use “Save project file…” first/).waitFor();
    expect(await revealedPath()).toBe("");
    await launched.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, filePath);
    await menu("Horizontal", "Save project file…");
    await library().getByRole("status").getByText(/Project file saved/).waitFor();
    expect(existsSync(filePath)).toBe(true);
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    expect(saved.name).toBe("Horizontal");
    expect(saved.settings).toMatchObject({ width: 1920, height: 1080 });
    expect(saved.timeline.tracks).toBeInstanceOf(Array);
    expect(await page().getByTestId("desktop-workspace").isVisible()).toBe(false);
    await menu("Horizontal", "Show saved project file");
    await vi.waitFor(async () => expect(await revealedPath()).toBe(filePath));

    launched = await launched.relaunch();
    await library().getByRole("button", { name: "Open Horizontal", exact: true }).waitFor();
    await observeReveal();
    await menu("Horizontal", "Show saved project file");
    await vi.waitFor(async () => expect(await revealedPath()).toBe(filePath));
    await menu("Horizontal", "Duplicate");
    await library().getByRole("button", { name: "Open Horizontal (Copy)", exact: true }).waitFor();
    await page().getByLabel(/^Vertical /).click();
    await showLibrary("Vertical");
    await library().getByRole("searchbox").fill("Horizontal");
    await library().getByRole("button", { name: "Manage", exact: true }).click();
    await library().getByRole("checkbox", { name: "Select all results", exact: true }).check();
    await library().getByText("Selected 2", { exact: true }).waitFor();
    await library().getByRole("button", { name: "Delete", exact: true }).click();
    await confirm();
    await library().getByRole("combobox", { name: "Project folder" }).selectOption("trash");
    await library().getByRole("checkbox", { name: "Select all results", exact: true }).check();
    await library().getByText("Selected 2", { exact: true }).waitFor();
    await library().getByRole("button", { name: "Delete permanently", exact: true }).click();
    await confirm();
    await library().getByText("The recycle bin is empty.", { exact: true }).waitFor();
    expect(JSON.parse(readFileSync(filePath, "utf8")).id).toBe(saved.id);
    launched = await launched.relaunch();
    await library().getByRole("searchbox").fill("");
    await library().getByRole("combobox", { name: "Project folder" }).selectOption("all");
    await library().getByRole("button", { name: "Open Vertical", exact: true }).waitFor();
    expect(await library().getByRole("button", { name: /^Open Horizontal/ }).count()).toBe(0);
  } finally {
    await launched.close();
  }
});

test("new projects and copies get unique names while manual renaming permits duplicates", async () => {
  const launched = await launchApp();
  const { page } = launched;
  const library = page.getByTestId("project-library");
  const showLibrary = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "New Project", exact: true }).click();
    await library.waitFor();
  };
  const menu = async (name: string, action: string) => {
    await library.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  };
  try {
    await createProjectViaUI(page);
    await showLibrary("Horizontal");
    await page.getByLabel(/^Horizontal /).click();
    await showLibrary("Horizontal 2");
    await menu("Horizontal", "Duplicate");
    await library.getByRole("button", { name: "Open Horizontal (Copy)", exact: true }).waitFor();
    await menu("Horizontal", "Duplicate");
    await library.getByRole("button", { name: "Open Horizontal (Copy) 2", exact: true }).waitFor();
    await menu("Horizontal 2", "Rename");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Horizontal");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(await library.getByRole("button", { name: "Open Horizontal", exact: true }).count()).toBe(2);
  } finally {
    await launched.close();
  }
});

test("local project library supports folders, bulk recycle/restore, current-project deletion and durable purge", async () => {
  let launched = await launchApp();
  const evidence = path.join(ARTIFACTS_DIR, "project-library");
  mkdirSync(evidence, { recursive: true });
  const page = () => launched.page;
  const library = () => page().getByTestId("project-library");
  const openChooser = async (name: string) => {
    await page().getByRole("button", { name, exact: true }).click();
    await page()
      .getByRole("button", { name: "New Project", exact: true })
      .click();
    await library().waitFor();
  };
  const menu = async (name: string, action: string) => {
    await library()
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page().getByRole("menuitem", { name: action, exact: true }).click();
  };
  const confirm = async () => {
    await page()
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await page().getByRole("dialog").waitFor({ state: "hidden" });
  };
  try {
    await createProjectViaUI(page());
    await openChooser("Horizontal");
    await page()
      .getByLabel(/^Vertical /)
      .click();
    await openChooser("Vertical");
    await menu("Horizontal", "Rename");
    await page()
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Library Cut");
    await confirm();
    await library()
      .getByRole("button", { name: "Open Library Cut", exact: true })
      .waitFor();
    await library()
      .getByRole("button", { name: "New folder", exact: true })
      .click();
    await page()
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Campaign");
    await confirm();
    await menu("Library Cut", "Move to folder");
    await page()
      .getByRole("combobox", { name: "Destination folder" })
      .selectOption({ label: "Campaign" });
    await confirm();
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption({ label: "Campaign" });
    expect(
      await library()
        .getByRole("button", { name: "Open Vertical", exact: true })
        .count(),
    ).toBe(0);
    await menu("Library Cut", "Duplicate");
    await library()
      .getByRole("button", { name: "Open Library Cut (Copy)", exact: true })
      .waitFor();
    await library().scrollIntoViewIfNeeded();
    await page().screenshot({ path: path.join(evidence, "list.png") });
    await library().getByRole("searchbox").fill("Library Cut");
    await library()
      .getByRole("button", { name: "Manage", exact: true })
      .click();
    await library()
      .getByRole("checkbox", { name: "Select all results", exact: true })
      .check();
    await library()
      .getByRole("button", { name: "Grid view", exact: true })
      .click();
    await library()
      .getByRole("combobox", { name: "Sort projects" })
      .selectOption("name");
    expect(
      await library().getByText("Selected 2", { exact: true }).isVisible(),
    ).toBe(true);
    await page().screenshot({
      path: path.join(evidence, "grid-selection.png"),
    });
    await library()
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page()
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    expect(
      await library().getByText("Selected 2", { exact: true }).isVisible(),
    ).toBe(true);
    await library()
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await confirm();
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption("trash");
    await library()
      .getByRole("checkbox", { name: "Select all results", exact: true })
      .check();
    await library()
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await library().getByRole("searchbox").fill("");
    await library()
      .getByText("The recycle bin is empty.", { exact: true })
      .waitFor();
    await library()
      .getByRole("button", { name: "Exit selection", exact: true })
      .click();
    await library().getByRole("searchbox").fill("");
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption("all");
    await menu("Vertical", "Delete");
    await confirm();
    expect(
      await page()
        .getByRole("button", { name: "Back to current project", exact: true })
        .count(),
    ).toBe(0);
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption("trash");
    await menu("Vertical", "Restore");
    await library()
      .getByText("The recycle bin is empty.", { exact: true })
      .waitFor();
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption("all");
    await menu("Library Cut (Copy)", "Delete");
    await confirm();
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption("trash");
    await menu("Library Cut (Copy)", "Delete permanently");
    await confirm();
    await library()
      .getByText("The recycle bin is empty.", { exact: true })
      .waitFor();
    await library()
      .getByRole("combobox", { name: "Project folder" })
      .selectOption("all");
    await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(800, 720),
    );
    await library().scrollIntoViewIfNeeded();
    expect(
      await library().evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page().screenshot({ path: path.join(evidence, "compact.png") });
    launched = await launched.relaunch();
    await library()
      .getByRole("button", { name: "Open Library Cut", exact: true })
      .waitFor();
    await library()
      .getByRole("button", { name: "Open Vertical", exact: true })
      .waitFor();
    expect(
      await library()
        .getByRole("button", { name: "Open Library Cut (Copy)", exact: true })
        .count(),
    ).toBe(0);
    expect(
      await library()
        .getByRole("button", { name: "Grid view", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await library()
      .getByRole("button", { name: "Open Library Cut", exact: true })
      .click();
    await page()
      .getByRole("button", { name: "Library Cut", exact: true })
      .waitFor();
    await page().getByTestId("desktop-workspace").waitFor();
    expect(await page().getByTestId("desktop-workspace").isVisible()).toBe(
      true,
    );
  } finally {
    await launched.close();
  }
});
