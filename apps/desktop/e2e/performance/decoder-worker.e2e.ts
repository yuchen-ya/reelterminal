import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { launchApp } from "../harness/launch";
import { DESKTOP_DIR } from "../harness/paths";
import { createEvidence } from "../harness/evidence";
import { prepareProfile, waitForMarker } from "../harness/performance/driver";
import { createPerformanceFixture } from "./fixtures";
import type { ProductPerformanceCaptureApi } from "../../../web/src/performance/product-capture-bridge";

test("production decode worker loads offline and returns the synthetic video frame", async () => {
  const assets = path.resolve(DESKTOP_DIR, "../web/dist/assets");
  const workerFile = (await readdir(assets)).find((name) => /^decode-worker-.*\.js$/.test(name));
  expect(workerFile, "build must contain the local decoder worker entry").toBeDefined();
  const launched = await launchApp();
  const evidence = createEvidence("p4-decoder-worker", launched.page);
  try {
    const mediaFile = path.join(launched.runDir, "worker-red.mp4");
    execFileSync(process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1",
      "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", mediaFile,
    ], { windowsHide: true });
    const video = (await readFile(mediaFile)).toString("base64");
    const networkRequests: string[] = [];
    await launched.page.context().route(/^https?:\/\//, async (route) => {
      networkRequests.push(new URL(route.request().url()).hostname);
      await route.abort();
    });
    const result = await launched.page.evaluate(async ({ workerFile, video }) => {
      const worker = new Worker(new URL(`./assets/${workerFile}`, location.href), { type: "module" });
      let timeout: ReturnType<typeof setTimeout>;
      try {
        return await new Promise<{ available: boolean; pixel: number[]; width: number; height: number }>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("local decode worker timed out")), 10_000);
          worker.onerror = () => reject(new Error("local decode worker module failed"));
          worker.onmessage = (event) => {
            const response = event.data;
            if (response.type === "ready") {
              if (!response.mediabunnyAvailable) {
                reject(new Error("local decoder dependency unavailable"));
                return;
              }
              const bytes = Uint8Array.from(atob(video), (char) => char.charCodeAt(0));
              worker.postMessage({ type: "decode", requestId: "red-frame", clipId: "synthetic-red", blob: new Blob([bytes], { type: "video/mp4" }), time: 0.4, width: 64, height: 64 });
              return;
            }
            if (response.requestId !== "red-frame" || !response.bitmap) {
              reject(new Error("synthetic video decode failed"));
              return;
            }
            const bitmap = response.bitmap as ImageBitmap;
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d")!;
            context.drawImage(bitmap, 0, 0);
            const pixel = Array.from(context.getImageData(32, 32, 1, 1).data);
            const { width, height } = bitmap;
            bitmap.close();
            resolve({ available: true, pixel, width, height });
          };
          worker.postMessage({ type: "init" });
        });
      } finally {
        clearTimeout(timeout!);
        worker.terminate();
      }
    }, { workerFile: workerFile!, video });
    expect(result.available).toBe(true);
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
    expect(result.pixel[0]).toBeGreaterThan(240);
    expect(result.pixel[1]).toBeLessThan(15);
    expect(result.pixel[2]).toBeLessThan(15);
    expect(networkRequests).toEqual([]);
    evidence.record("worker", { entry: workerFile, ...result, externalRequestCount: networkRequests.length });
  } finally {
    evidence.flush();
    await launched.close();
  }
});

test("the editor paints a valid frame while optional decode workers are still preparing", async () => {
  const fixture = createPerformanceFixture({ scenarioId: "T01", seed: "p4-worker-readiness" });
  const runDir = await prepareProfile(fixture);
  const launched = await launchApp({ runDir, skipLocaleReload: true });
  const evidence = createEvidence("p4-worker-nonblocking-first-frame", launched.page);
  try {
    // Parallel decoding is deliberately disabled in the shipped engine until
    // its request queue is wired. Opt in only in this isolated renderer by
    // replacing the single built class-field initializer in the routed bundle.
    // Fail closed if the build shape changes; do not modify files on disk.
    const assets = path.resolve(DESKTOP_DIR, "../web/dist/assets");
    const initializer = "useParallelDecoding=!1;";
    const candidates = await Promise.all((await readdir(assets))
      .filter(name => /^index-.*\.js$/.test(name))
      .map(async name => ({ name, source: await readFile(path.join(assets, name), "utf8") })));
    const matches = candidates.filter(candidate => candidate.source.includes(initializer));
    expect(matches, "exactly one renderer bundle must contain the disabled decoder initializer").toHaveLength(1);
    const [{ name: engineBundle, source }] = matches;
    expect(source.split(initializer), "decoder initializer must be unique").toHaveLength(2);
    const optedInSource = source.replace(initializer, "useParallelDecoding=!0;");
    await launched.page.route(url => url.pathname === `/assets/${engineBundle}`, route =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: optedInSource }));
    await launched.page.addInitScript(() => {
      const NativeWorker = Worker;
      const pending: Array<() => void> = [];
      const root = globalThis as typeof globalThis & { __p4WorkerInit: { readonly count: number; release(): void } };
      root.__p4WorkerInit = {
        get count() { return pending.length; },
        release() { for (const send of pending.splice(0)) send(); },
      };
      globalThis.Worker = class extends NativeWorker {
        private readonly hold: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.hold = String(url).includes("decode-worker-");
        }
        postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []): void {
          const send = () => {
            if (Array.isArray(options)) super.postMessage(message, options);
            else super.postMessage(message, options);
          };
          if (this.hold && (message as { type?: string }).type === "init") {
            pending.push(send);
          } else {
            send();
          }
        }
      };
    });
    // This is a controlled startup correctness test, not a cold timing sample.
    await launched.page.reload();
    await launched.page.getByTestId("project-library").waitFor();
    await launched.page.evaluate(() => {
      (globalThis as typeof globalThis & { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi })
        .__reelterminalPerformanceCapture.start({ mode: "trace", budgets: { captureSeconds: 30 } });
    });
    await launched.page.getByRole("button", { name: `Open ${fixture.project!.name}`, exact: true }).click();
    await waitForMarker(launched.page, fixture, 8_000);
    const pending = await launched.page.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __p4WorkerInit: { count: number; release(): void };
        __reelterminalPerformanceCapture: ProductPerformanceCaptureApi;
      };
      const count = root.__p4WorkerInit.count;
      const spans = root.__reelterminalPerformanceCapture.pendingSpanCount;
      root.__p4WorkerInit.release();
      return { count, spans };
    });
    expect(pending.count).toBeGreaterThan(0);
    expect(pending.spans).toBeGreaterThan(0);
    await launched.page.waitForFunction(() =>
      (globalThis as typeof globalThis & { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi })
        .__reelterminalPerformanceCapture.pendingSpanCount === 0,
    undefined, { timeout: 10_000 });
    const report = await launched.page.evaluate(() =>
      (globalThis as typeof globalThis & { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi })
        .__reelterminalPerformanceCapture.stop());
    const workers = report.events.filter((event) => event.phase === "parallel_decoder.worker_ready");
    expect(workers).toHaveLength(pending.count);
    expect(workers.every((event) => event.kind === "mark" && event.dims?.mediabunny_available === true)).toBe(true);
    evidence.record("firstFrame", { markerVerifiedBeforeReadiness: true, pending, workerCount: workers.length });
  } finally {
    evidence.flush();
    await launched.close();
  }
});
