import { expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createProjectViaUI } from "./harness/ui";

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
