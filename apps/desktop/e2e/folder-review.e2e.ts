import { expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { launchApp } from "./harness/launch";
import { ARTIFACTS_DIR } from "./harness/paths";
import { writeRgbaPng } from "./harness/repair-acceptance-fixtures";

test("task directory retains real file management, imports and previews through reopening", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "folder-review-e2e-"));
  let launched = await launchApp({ runDir });
  const root = path.join(launched.userDataDir, "review", "tasks", "review-task");
  const output = path.join(launched.runDir, "delivery");
  await mkdir(output);
  try {
    let page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "审阅工作台", exact: true }).click();
    await page.getByTestId("review-workspace-open").click();
    await page.getByTestId("folder-task-directory").waitFor();
    await page.getByTestId("folder-task-new").click();
    const creation = page.getByRole("dialog", { name: "新建任务" });
    await creation.getByLabel("任务名称").fill("审阅任务");
    await creation.getByLabel("文件夹名称").fill("review-task");
    expect(await creation.textContent()).toContain(root);
    await creation.getByRole("button", { name: "创建" }).click();
    await page.getByTestId("folder-review-workspace").waitFor();
    await page.getByRole("button", { name: "重命名任务" }).click();
    const renameTask = page.getByRole("dialog", { name: "重命名任务" });
    await renameTask.getByLabel("任务名称").fill("修改后的任务");
    await renameTask.getByRole("button", { name: "确定" }).click();
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(root, ".reelterminal", "review-index.json"), "utf8")).name).toBe("修改后的任务"));
    await mkdir(path.join(root, "Selected"));
    await writeFile(path.join(root, "A.txt"), "Review file A");
    await writeFile(path.join(root, "B.txt"), "Review file B");
    await writeFile(path.join(root, "unknown.xyz"), "A file without a preview");
    writeRgbaPng(path.join(root, "image.png"), 2, 2, Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]));
    const row = (name: string) =>
      page
        .getByTestId("folder-review-row")
        .filter({ has: page.locator(`span[title="${name}"]`) });
    await row("image.png").waitFor();
    // An OS-backed File exercises the incoming drop handler. This is a
    // dispatched DOM drop, not a claim of native Explorer drag automation.
    const incoming = path.join(launched.runDir, "incoming.txt");
    await writeFile(incoming, "Dropped file bytes");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "drop-fixture";
      input.hidden = true;
      document.body.append(input);
    });
    await page.locator("#drop-fixture").setInputFiles(incoming);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#drop-fixture")!;
      const transfer = new DataTransfer();
      transfer.items.add(input.files![0]);
      document.querySelector('[data-testid="folder-review-tree"]')!.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      input.remove();
    });
    await row("incoming.txt").waitFor();
    expect(await readFile(path.join(root, "incoming.txt"), "utf8")).toBe("Dropped file bytes");
    expect(await readFile(incoming, "utf8")).toBe("Dropped file bytes");
    await row("image.png").click();
    await vi.waitFor(async () =>
      expect(
        await page
          .getByRole("img", { name: "image.png" })
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      ).toBe(2),
    );
    await row("A.txt").click();
    // The directory embeds file management only. Human review and feedback
    // now belong to version-bound text units in task-review.e2e.ts.
    expect(await page.getByRole("textbox", { name: "审阅备注" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "采用", exact: true }).count()).toBe(0);
    expect(await page.getByRole("combobox", { name: "审阅结果筛选" }).count()).toBe(0);
    expect(await row("B.txt").count()).toBe(1);
    await row("A.txt").getByRole("button", { name: "重命名", exact: true }).click();
    const renameFile = page.getByRole("dialog", { name: "重命名", exact: true });
    await renameFile.getByLabel("新名称").fill("Renamed-A.txt");
    await renameFile.getByRole("button", { name: "确定", exact: true }).click();
    await row("Renamed-A.txt").waitFor();
    // Classification acts only on the explicitly selected file.
    await row("Renamed-A.txt").click();
    await page.getByRole("combobox").last().selectOption("Selected");
    await page.getByRole("button", { name: "移动到", exact: true }).click();
    await vi.waitFor(async () =>
      expect(await readFile(path.join(root, "Selected", "Renamed-A.txt"), "utf8")).toBe(
        "Review file A",
      ),
    );
    // Moving into a collapsed folder makes the previous selection invisible;
    // expand and explicitly select the relocated file for the next operation.
    await row("Selected").press("ArrowRight");
    await row("Selected/Renamed-A.txt").click();
    await launched.app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, output);
    await page
      .getByRole("button", { name: "复制到外部…", exact: true })
      .click();
    await vi.waitFor(async () =>
      expect(await readFile(path.join(output, "Renamed-A.txt"), "utf8")).toBe(
        "Review file A",
      ),
    );
    expect(await readFile(path.join(root, "B.txt"), "utf8")).toBe(
      "Review file B",
    );

    // A file written by an external producer appears without an import command.
    await writeFile(path.join(root, "C.txt"), "New external output");
    await row("C.txt").waitFor();
    await row("C.txt").click();
    await vi.waitFor(async () => expect(await page.getByTestId("folder-review-workspace").locator("pre").textContent()).toBe("New external output"));
    // Closing and reopening retains the real folder rather than a second
    // virtual review copy. Feedback persistence lives in the task-domain spec.
    await page.getByTestId("task-review-workspace").getByRole("button", { name: "关闭", exact: true }).click();
    await launched.app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, root);
    await page.getByTestId("review-workspace-open").click();
    await page.getByTestId("folder-task-recent").click();
    await row("C.txt").click();
    await vi.waitFor(async () => expect(await page.getByTestId("folder-review-workspace").locator("pre").textContent()).toBe("New external output"));

    await page.getByTestId("review-workspace-open").click();
    await page.getByTestId("human-board-new").click();
    await page.getByTestId("workbench-private-board").waitFor({ state: "attached" });
    await page.getByTestId("review-workspace-open").click();
    await page.getByTestId("folder-task-recent").click();
    await row("C.txt").waitFor();

    launched = await launched.relaunch();
    page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace/ }).click();
    await page.getByTestId("folder-review-workspace").waitFor();
    await row("Selected").press("ArrowRight");
    await row("Selected/Renamed-A.txt").waitFor();
    await writeFile(
      path.join(root, "Selected", "Renamed-A.txt"),
      "A new externally written revision",
    );
    await row("Selected/Renamed-A.txt").click();
    await vi.waitFor(async () => expect(await page.getByTestId("folder-review-workspace").locator("pre").textContent()).toBe("A new externally written revision"), { timeout: 10000 });
    const index = JSON.parse(await readFile(path.join(root, ".reelterminal", "review-index.json"), "utf8"));
    expect(index.entries.every((entry: { review: { status: string } }) => entry.review.status === "pending")).toBe(true);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "folder-review.png"),
    });
  } catch (error) {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "folder-review--failure.png") });
    throw error;
  } finally {
    await launched.close();
  }
});
