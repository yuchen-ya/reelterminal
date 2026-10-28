/** P0 feasibility probes. These do not claim the proposed ReviewService exists. */
import { afterAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR, DESKTOP_DIR } from "./harness/paths";

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

describe("review foundation P0: isolated feasibility evidence", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  const evidence: Record<string, unknown> = { measuredAt: new Date().toISOString() };
  const evidencePath = path.join(ARTIFACTS_DIR, `review-foundation-p0-${Date.now()}-${process.pid}.json`);
  const save = async () => {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  };

  afterAll(async () => {
    await save();
    await agent?.close();
    await launched?.close();
  });

  test("records no-project bridge, catalog and persistent IDB baseline", async () => {
    launched = await launchApp();
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    let context = await agent.callCommand("editor.get_context");
    const attempts = [context];
    const deadline = Date.now() + 10_000;
    while (!context.ok && context.error?.message.includes("still loading") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      context = await agent.callCommand("editor.get_context");
      attempts.push(context);
    }
    const commands = await agent.listCommands();
    evidence.noProject = {
      context,
      attempts,
      reviewCommands: commands.filter(command => command.name.startsWith("review.")),
      note: "Current product baseline; no review target is inferred from a video context.",
    };
    await save();
    const screenshot = path.join(ARTIFACTS_DIR, "review-foundation-p0-no-project.png");
    await launched.page.screenshot({ path: screenshot });
    // A baseline probe records the current absence of a review target honestly.
    expect(context.ok || context.error?.message === "No project is open").toBe(true);
  });

  test.skipIf(process.env.REELTERMINAL_P0_NATIVE_ONLY === "1")("writes and reads back a >256 MiB video through bounded existing media IPC", async () => {
    const source = path.join(launched.runDir, "large-original.avi");
    const ffmpeg = process.platform === "win32" ? path.join(DESKTOP_DIR, "resources", "bin", "win32-x64", "ffmpeg.exe") : "ffmpeg";
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=1920x1080:rate=24", "-frames:v", "48", "-c:v", "rawvideo", "-pix_fmt", "bgr24", source],
    { windowsHide: true, timeout: 60_000 });
    const sourceStat = await stat(source);
    expect(sourceStat.size).toBeGreaterThan(256 * 1024 * 1024);
    const hash = await digest(source);
    const session = await launched.page.evaluate(async (expectedHash) => {
      return window.reelterminal!.mediaStore.beginWrite({
        projectId: "p0-probe-only", mediaId: "p0-large-video", expectedHash, extension: "avi",
      });
    }, hash);
    let maximumChunk = 0;
    let chunks = 0;
    const before = await launched.app.evaluate(() => process.memoryUsage());
    let peakRss = before.rss;
    const started = performance.now();
    for await (const chunk of createReadStream(source, { highWaterMark: 1024 * 1024 })) {
      const bytes = chunk as Buffer;
      maximumChunk = Math.max(maximumChunk, bytes.byteLength);
      chunks += 1;
      // Playwright transports one chunk to the renderer, which calls the real preload IPC.
      await launched.page.evaluate(async ({ sessionId, data }) => {
        const binary = atob(data);
        const chunk = Uint8Array.from(binary, character => character.charCodeAt(0));
        await window.reelterminal!.mediaStore.writeChunk(sessionId, chunk);
      }, { sessionId: session, data: bytes.toString("base64") });
      if (chunks % 16 === 0) {
        const memory = await launched.app.evaluate(() => process.memoryUsage());
        peakRss = Math.max(peakRss, memory.rss);
      }
    }
    const committed = await launched.page.evaluate(async (sessionId) =>
      window.reelterminal!.mediaStore.commitWrite(sessionId), session);
    const destination = path.join(launched.runDir, "large-export.avi");
    // Native fs.copyFile never transfers the whole file through renderer IPC.
    // This proves platform feasibility only; review export integration is still required.
    await copyFile(committed.path, destination);
    const exportedHash = await digest(destination);
    evidence.largeVideo = {
      bytes: sourceStat.size, chunks, maximumChunk, sha256: hash,
      managedSha256: await digest(committed.path), exportedSha256: exportedHash,
      elapsedMs: performance.now() - started, mainRssBefore: before.rss, mainRssSampledPeak: peakRss,
      note: "Existing bounded write IPC + native file copy. Canonical path import and review export are not implemented by this probe.",
    };
    expect(exportedHash).toBe(hash);
    expect(await digest(committed.path)).toBe(hash);
    expect(maximumChunk).toBeLessThanOrEqual(1024 * 1024);
    await save();
  });

  test.skipIf(process.env.REELTERMINAL_P0_NATIVE_DRAG !== "1")("native drag to actual Explorer: single, multiple and directory", async () => {
    const fixtureRoot = path.join(launched.runDir, "native-drag");
    const input = path.join(fixtureRoot, "export-copy");
    const output = path.join(fixtureRoot, "explorer-target");
    await mkdir(path.join(input, "node-folder"), { recursive: true });
    await mkdir(output, { recursive: true });
    await writeFile(path.join(input, "single.txt"), "single original\r\n");
    await writeFile(path.join(input, "multi-a.txt"), "multi A\n");
    await writeFile(path.join(input, "multi-b.txt"), "multi B\n");
    await writeFile(path.join(input, "node-folder", "child.txt"), "folder child\n");
    const preload = path.join(fixtureRoot, "drag-preload.cjs");
    await writeFile(preload, `const {ipcRenderer}=require('electron');
window.addEventListener('DOMContentLoaded',()=>{
  const status=document.getElementById('status');
  document.querySelectorAll('[data-export-id]').forEach(element=>{
    element.addEventListener('dragstart',event=>{
      event.preventDefault();
      status.textContent='Native drag requested: '+element.dataset.exportId;
      ipcRenderer.send('p0:drag',element.dataset.exportId);
    });
  });
  ipcRenderer.on('p0:drag:result',(_event,result)=>status.textContent=result);
  status.textContent='Ready: drag a handle into Explorer';
});`);
    evidence.nativeDrag = { fixtureRoot, state: "waiting-for-real-Explorer-drop" };
    await save();
    await launched.app.evaluate(async ({ app, BrowserWindow, ipcMain, shell }, args) => {
      const paths = args.exports;
      const icons = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([id, files]) =>
        [id, (await app.getFileIcon(files[0], { size: "normal" })).resize({ width: 32, height: 32 })])));
      for (const window of BrowserWindow.getAllWindows()) window.minimize();
      await shell.openPath(args.output);
      const probe = new BrowserWindow({ x: 30, y: 100, width: 510, height: 470,
        alwaysOnTop: true, title: "Review foundation P0 drag probe",
        webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false } });
      ipcMain.on("p0:drag", (event, exportId) => {
        if (event.sender !== probe.webContents || !Object.hasOwn(paths, exportId)) return;
        const files = paths[exportId];
        try {
          event.sender.startDrag({ file: files[0], files, icon: icons[exportId] });
          event.sender.send("p0:drag:result", "Handed to system: " + exportId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("P0_NATIVE_DRAG_ERROR", message);
          event.sender.send("p0:drag:result", "ERROR: " + message);
        }
      });
      await probe.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
        <title>Review foundation P0 drag probe</title><style>body{font:18px sans-serif;padding:24px}.handle{display:block;margin:16px;padding:14px;border:1px solid #999;background:#eee;cursor:grab}</style>
        <h3>P0 native drag — isolated copies</h3><p>Drag each button into explorer-target.</p>
        <div class="handle" role="button" draggable="true" data-export-id="single">1 · single file</div>
        <div class="handle" role="button" draggable="true" data-export-id="multi">2 · multiple files</div>
        <div class="handle" role="button" draggable="true" data-export-id="folder">3 · node folder</div>
        <p id="status">Preload not ready</p>`));
    }, { output, preload, exports: {
      single: [path.join(input, "single.txt")],
      multi: [path.join(input, "multi-a.txt"), path.join(input, "multi-b.txt")],
      folder: [path.join(input, "node-folder")],
    } as Record<string, string[]> });
    const expected = ["single.txt", "multi-a.txt", "multi-b.txt", "node-folder/child.txt"];
    const deadline = Date.now() + 480_000;
    while (Date.now() < deadline && !expected.every(name => existsSync(path.join(output, name)))) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const results = await Promise.all(expected.map(async name => ({
      name, received: existsSync(path.join(output, name)),
      identical: existsSync(path.join(output, name)) &&
        (await readFile(path.join(input, name))).equals(await readFile(path.join(output, name))),
      sha256: existsSync(path.join(output, name)) ? await digest(path.join(output, name)) : null,
    })));
    evidence.nativeDrag = { fixtureRoot, electron: await launched.app.evaluate(() => process.versions.electron), results };
    await save();
    expect(results.every(result => result.received && result.identical)).toBe(true);
  });
});
