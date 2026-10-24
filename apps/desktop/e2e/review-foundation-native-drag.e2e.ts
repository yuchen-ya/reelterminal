import { value } from "./harness/cli-client";
import { expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp } from "./harness/launch";
import { connectExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";


test.skipIf(process.env.REELTERMINAL_REVIEW_NATIVE_DRAG !== "1")("manual Explorer drops from the formal export dialog preserve single, multiple and folder bytes", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const evidencePath = path.join(ARTIFACTS_DIR, `review-formal-native-drag-${Date.now()}.json`);
  const output = path.join(launched.runDir, "formal-explorer-target");
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), output };
  const save = async () => { await mkdir(ARTIFACTS_DIR, { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2)); };
  try {
    await mkdir(output);
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    if (process.env.REELTERMINAL_E2E_APP_EXECUTABLE) {
      const executable = process.env.REELTERMINAL_E2E_APP_EXECUTABLE;
      const cli = path.join(path.dirname(executable), "resources", "app.asar", "dist", "reelctl", "index.js");
      const reply = JSON.parse(execFileSync(executable, [cli, "review", "context"], { windowsHide: true, encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile } }));
      expect(reply.value.target).toEqual(context.target);
      evidence.packagedCli = true;
    }
    await page.evaluate(() => {
      const events: Array<{ type: string; target: string | null }> = [];
      (window as unknown as { exportDragEvents: typeof events }).exportDragEvents = events;
      for (const type of ["pointerdown", "dragstart", "dragend"]) document.addEventListener(type, event => events.push({ type, target: (event.target as HTMLElement).getAttribute("data-testid") }));
    });
    await launched.app.evaluate(({ BrowserWindow }) => {
      const calls: Array<{ files: string[]; icon: unknown; started: number; returned?: number }> = [];
      (globalThis as unknown as { exportDragCalls: typeof calls }).exportDragCalls = calls;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const original = contents.startDrag.bind(contents);
      contents.startDrag = item => {
        const call = { files: item.files ?? [item.file!], icon: typeof item.icon === "string" ? item.icon : item.icon.getSize(), started: Date.now(), returned: undefined as number | undefined };
        calls.push(call);
        try { original(item); } finally { call.returned = Date.now(); }
      };
    });
    const create = async (name: string, entries: Array<{ title: string; text: string }>) => {
      await page.getByLabel(/New node name|新节点名称/).fill(name);
      await page.getByTestId("review-create-node").click();
      await vi.waitFor(async () => expect(await page.getByTestId("review-node-title").textContent()).toBe(name));
      const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes.find(node => node.name === name)!;
      value(await agent.callCommand("review.ingest", { target: { ...context.target, nodeId: node.id }, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "Native drag fixture",
        items: entries.map(entry => ({ id: crypto.randomUUID(), title: entry.title, type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: entry.title, speakerOrContext: "", text: entry.text } })) }));
      await page.getByTestId("text-body").waitFor();
      await vi.waitFor(async () => expect(await page.getByTestId("review-node-editor").locator("[inert]").count()).toBe(0));
      await page.getByTestId("review-export-open").click();
      await page.getByTestId("review-export-prepare").click();
      await vi.waitFor(async () => expect(await page.getByTestId("review-export-status").getAttribute("data-state")).toBe("ready"));
    };
    const waitForFiles = async (names: string[]) => {
      const deadline = Date.now() + 1_200_000;
      while (Date.now() < deadline && !names.every(name => existsSync(path.join(output, name)))) {
        await new Promise(resolve => setTimeout(resolve, 500));
        evidence.events = await page.evaluate(() => (window as unknown as { exportDragEvents: unknown[] }).exportDragEvents);
        evidence.calls = await launched.app.evaluate(() => (globalThis as unknown as { exportDragCalls: unknown[] }).exportDragCalls);
        await save();
      }
      expect(names.every(name => existsSync(path.join(output, name)))).toBe(true);
    };
    await create("formal-single", [{ title: "single", text: "Formal single 👀\r\noriginal" }]);
    evidence.phase = "single-file-ready"; await save();
    await launched.app.evaluate(async ({ BrowserWindow, shell }, directory) => {
      await shell.openPath(directory);
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 0, y: 0, width: 1050, height: 700 });
      window.setTitle("ReelTerminal — 手动复测 1/2 · Drag out files");
      window.show(); window.focus();
    }, output);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-formal-native-ready.png") });
    console.info("FORMAL_DRAG_READY", JSON.stringify({ evidencePath, output }));
    await waitForFiles(["single.txt"]);
    expect(await readFile(path.join(output, "single.txt"), "utf8")).toBe("Formal single 👀\r\noriginal");
    evidence.single = { received: true, identical: true }; await save();
    await page.keyboard.press("Escape");
    const entries = [{ title: "multi-a", text: "Formal multiple A\n" }, { title: "multi-b", text: "Formal multiple B 👀\r\n" }];
    await create("formal-node", entries);
    evidence.phase = "multiple-files-and-folder-ready"; await save();
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setTitle("ReelTerminal — 手动复测 2/2 · 文件和文件夹各拖一次"));
    await waitForFiles(["multi-a.txt", "multi-b.txt", "formal-node/multi-a.txt", "formal-node/multi-b.txt", "formal-node/manifest.json"]);
    for (const entry of entries) {
      expect(await readFile(path.join(output, `${entry.title}.txt`), "utf8")).toBe(entry.text);
      expect(await readFile(path.join(output, "formal-node", `${entry.title}.txt`), "utf8")).toBe(entry.text);
    }
    evidence.multiple = { received: true, identical: true };
    evidence.folder = { received: true, identical: true };
    evidence.phase = "passed"; evidence.completedAt = new Date().toISOString(); await save();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-formal-native-drag.png") });
  } catch (problem) {
    evidence.phase = "not-completed";
    evidence.error = problem instanceof Error ? problem.message : String(problem);
    throw problem;
  } finally {
    evidence.console = launched.output.rendererConsole; await save();
    await agent.close(); await launched.close();
  }
}, 2_500_000);
