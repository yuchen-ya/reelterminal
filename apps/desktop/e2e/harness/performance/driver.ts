import { build } from "esbuild";
import { open, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Locator, Page } from "playwright-core";
import type { Project } from "@reelterminal/core/types/project";
import type { TimelineState } from "@reelterminal/agent-facade";
import type { CaptureReport } from "../../../../web/src/performance";
import { launchApp, type LaunchedApp } from "../launch";
import { ARTIFACTS_DIR, E2E_DIR } from "../paths";
import { connectExternalAgent, type ExternalAgent } from "../cli-client";
import { enableAgentSessionViaUI } from "../ui";
import { captureBuildIdentity, readEnvironmentIdentity } from "./identity";
import { createPerformanceResult, type RawPerformanceOperation } from "./result";
import { readHydratedStructureBytes } from "./structure-probe";
import { extractProductMeasurements } from "./product-metrics";
import { createActionWindowArtifactParts, type ActionWindowArtifactReference } from "./action-window-artifacts";
import { stopCaptureWhenIdle } from "./idle-capture-stop";
import {
  createPerformanceFixture,
  materializePerformanceFixtureAssets,
  performanceFixtureManifestSha256,
  type PerformanceFixture,
  type PerformanceScenarioId,
  type TimelinePerformanceScenarioId,
} from "../../performance/fixtures";
import { validateResultDocument } from "../../../../../scripts/performance/result-contract.mjs";

export interface PerformanceRunOptions {
  suite: "quick" | "benchmark" | "soak";
  saturateHistory?: boolean;
  scenarios: PerformanceScenarioId[];
  seed: string;
  samples: number;
  repeats: number;
  cache: "warm" | "fresh-profile" | "reused-profile";
  coldLaunches: number;
  fontMiB: 32 | 64;
  nodeCount: 10 | 100 | 1000;
  clipCount: 500 | 2000;
  trackCount: 20 | 50;
  editRounds: number;
  durationSeconds: number;
  actionIntervalMs: number;
  operationTimeoutMs: number;
  runTimeoutSeconds: number;
}

export interface RendererWindowEvidence {
  report: CaptureReport;
  firstInputUs: number | null;
  intervalsMs: number[];
  hiddenDuringAction: boolean;
  main?: import("../../../src/shared/performance-contract").PerfStopReply;
}

export function captureComplete(window: RendererWindowEvidence): boolean {
  const mainCapture = window.main?.ok === true ? window.main.mainCapture : null;
  return !window.hiddenDuringAction &&
    window.report.status === "complete" &&
    window.report.drops.eventsDropped === 0 &&
    window.report.drops.criticalEndpointsDropped === 0 &&
    mainCapture?.status === "complete" &&
    mainCapture.eventsDropped === 0;
}

type ProbeGlobal = typeof globalThis & {
  __reelterminalPerfDriver: {
    start(runId: string, operationId: string, seconds: number): void;
    stop(outcome: "ok" | "error" | "timeout"): RendererWindowEvidence;
  };
};

/** Refuse concurrent performance desktops, including independent command invocations. */
export async function acquirePerformanceLock(): Promise<() => Promise<void>> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const lockPath = path.join(ARTIFACTS_DIR, "performance.lock");
  const file = await open(lockPath, "wx");
  await file.writeFile(JSON.stringify({ pid: process.pid }));
  return async () => { await file.close(); await rm(lockPath); };
}

export function markerMatches(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length >= 3 && expected.length === 3 && expected.every((value, index) => Math.abs(actual[index]! - value) <= 8);
}

/** Native/remote pointer input must not silently alter an owned CDP gesture. */
export function unexpectedPointerMoves(actual: readonly { x: number; y: number }[], planned: readonly { x: number; y: number }[]) {
  return actual.filter(point => !planned.some(expected => Math.abs(point.x - expected.x) <= 1.5 && Math.abs(point.y - expected.y) <= 1.5));
}

async function markerPixel(page: Page, fixture: PerformanceFixture): Promise<number[]> {
  return page.getByTestId("preview-canvas").evaluate((element, probe) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("preview canvas pixels unavailable");
    return Array.from(context.getImageData(Math.floor(canvas.width * probe.x), Math.floor(canvas.height * probe.y), 1, 1).data);
  }, fixture.targetMarker!.probe);
}

export async function waitForMarker(page: Page, fixture: PerformanceFixture, timeout: number): Promise<void> {
  await page.waitForFunction(({ rgb, probe }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]');
    if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("preview canvas pixels unavailable");
    const pixel = context.getImageData(Math.floor(canvas.width * probe.x), Math.floor(canvas.height * probe.y), 1, 1).data;
    return rgb.every((value, index) => Math.abs(pixel[index]! - value) <= 8);
  }, fixture.targetMarker!, { timeout, polling: "raf" });
}

/** Prepare only preferences, database rows and assets; never open the editor or decode a font. */
export async function prepareProfile(fixture: PerformanceFixture): Promise<string> {
  const runDir = await mkdtemp(path.join(tmpdir(), "reelterminal-e2e-performance-"));
  try {
    await materializePerformanceFixtureAssets(fixture, path.join(runDir, "assets"));
    const launched = await launchApp({ runDir });
    try {
      await launched.page.getByTestId("project-library").waitFor({ timeout: 30_000 });
      // JSON transport avoids Playwright recursively expanding the core Project union.
      const seedJson = JSON.stringify({ records: fixture.records!, assets: fixture.assets.filter((asset) => asset.kind === "synthetic-image") });
      await launched.page.evaluate(async (seedJson) => {
        const { records, assets } = JSON.parse(seedJson) as { records: NonNullable<PerformanceFixture["records"]>; assets: PerformanceFixture["assets"] };
        localStorage.setItem("openreel-locale", "en");
        localStorage.setItem("openreel-onboarding-complete", "true");
        const openDb = (name: string, version: number, upgrade?: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.onupgradeneeded = () => upgrade?.(request.result);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error("fixture database blocked"));
        });
        const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error ?? new Error("fixture transaction aborted"));
          transaction.onerror = () => reject(transaction.error);
        });
        const mediaAssets = assets.filter((asset) => asset.kind === "synthetic-image");
        const blobs = new Map(mediaAssets.map((asset) => [asset.assetId, new Blob([Uint8Array.from(atob(asset.content), (character) => character.charCodeAt(0))], { type: asset.mediaType })]));
        const hydrate = (project: Project): Project => ({ ...project, mediaLibrary: { items: project.mediaLibrary.items.map((item) => ({ ...item, blob: blobs.get(item.id)! })) } });
        const workspaceDb = await openDb("reelterminal-workspaces", 3);
        const stores = ["projects", "workspaces", "nodes", "nodeSummaries"];
        const transaction = workspaceDb.transaction(stores, "readwrite");
        const committed = done(transaction);
        for (const record of records.projects) transaction.objectStore("projects").put(record);
        for (const record of records.workspaces) transaction.objectStore("workspaces").put({ ...record, project: hydrate(record.project) });
        for (const record of records.nodes) transaction.objectStore("nodes").put({ ...record, project: hydrate(record.project) });
        for (const record of records.nodeSummaries) transaction.objectStore("nodeSummaries").put(record);
        await committed;
        workspaceDb.close();
        const mediaDb = await openDb("openreel-db", 4, (db) => {
          for (const name of ["projects", "media", "cache", "waveforms", "fileHandles", "dirHandles"]) {
            if (db.objectStoreNames.contains(name)) continue;
            const keyPath = name === "waveforms" ? "mediaId" : name === "cache" ? "key" : "id";
            const store = db.createObjectStore(name, { keyPath });
            if (name === "media") {
              store.createIndex("projectId", "projectId");
              store.createIndex("projectIds", "projectIds", { multiEntry: true });
            }
            if (name === "projects") store.createIndex("modifiedAt", "modifiedAt");
          }
        });
        const mediaTransaction = mediaDb.transaction("media", "readwrite");
        const mediaCommitted = done(mediaTransaction);
        for (const asset of mediaAssets) {
          const project = [...records.workspaces, ...records.nodes].map((record) => record.project).find((project) => project.mediaLibrary.items.some((item) => item.id === asset.assetId))!;
          const item = project.mediaLibrary.items.find((item) => item.id === asset.assetId)!;
          mediaTransaction.objectStore("media").put({ id: item.id, projectId: records.projects[0]!.id, projectIds: [records.projects[0]!.id], blob: blobs.get(item.id), metadata: item.metadata, contentHash: asset.sha256 });
        }
        await mediaCommitted;
        mediaDb.close();
      }, seedJson);
    } finally {
      await launched.close({ keepRunDir: true });
    }
    // Only regenerable caches in our own disposable profile are removed.
    // This creates a seeded fresh profile, not a physical-disk-cold experiment.
    const profile = path.resolve(runDir, "user-data");
    for (const name of ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"]) {
      const target = path.resolve(profile, name);
      if (path.dirname(target) !== profile) throw new Error("profile cache escaped owned directory");
      await rm(target, { recursive: true, force: true });
    }
    return runDir;
  } catch (error) {
    const directory = path.join(ARTIFACTS_DIR, "performance");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `preparation-${Date.now()}.json`), JSON.stringify({
      schema: "reelterminal.performance-preflight/v1", status: "invalid",
      reason_codes: ["profile_preparation_failed"], scenario_id: fixture.manifest.scenarioId,
      retained_profile: runDir, error_kind: error instanceof Error ? error.name : "unknown",
    }, null, 2));
    throw error;
  }
}

export async function installProbe(page: Page): Promise<void> {
  await page.waitForFunction(() => "__reelterminalPerformanceCapture" in globalThis, null, { timeout: 30_000 });
  const bundle = await build({
    entryPoints: [path.join(E2E_DIR, "harness/performance/renderer-probe.ts")],
    bundle: true, write: false, format: "iife", platform: "browser", target: "chrome142",
    alias: { "@reelterminal/core": path.resolve(E2E_DIR, "../../../packages/core/src/performance/index.ts") },
  });
  await page.evaluate(bundle.outputFiles![0]!.text);
}

function clipTarget(page: Page, id: string): Locator {
  return page.locator(`[data-live-editor-target-id="${id}"]`).first();
}

async function selectClipsWithKeyboard(page: Page, ids: readonly string[]): Promise<void> {
  await page.keyboard.press("Escape");
  for (const [index, id] of ids.entries()) {
    await clipTarget(page, id).press(index === 0 ? "Enter" : "Control+Enter");
  }
  await page.waitForFunction((ids) => ids.every((id) =>
    document.querySelector(`[data-live-editor-target-id="${id}"]`)?.getAttribute("aria-pressed") === "true",
  ), ids);
}

async function verifyHit(target: Locator, x: number, y: number, timeout: number): Promise<void> {
  const id = await target.getAttribute("data-live-editor-target-id");
  if (!id) throw new Error("clip target has no input identity");
  const read = () => target.page().evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-live-editor-target-id]")?.getAttribute("data-live-editor-target-id"), { x, y });
  let hit = await read();
  if (hit !== id) {
    console.info("PERFORMANCE_INPUT_HIT_WAIT", { expected: id, actual: hit ?? null, x, y });
    // Custom mouse input needs the same actionability synchronization that
    // Playwright's locator actions provide. Never press through an overlay.
    try {
      await target.page().waitForFunction(({ id, x, y }) =>
        document.elementFromPoint(x, y)?.closest("[data-live-editor-target-id]")?.getAttribute("data-live-editor-target-id") === id,
      { id, x, y }, { timeout, polling: "raf" });
    } catch (error) {
      // One tiny crop around this synthetic input point, never a profile or
      // full application screenshot. Preserve the original action failure.
      const page = target.page();
      if (typeof page.screenshot === "function") {
        const directory = path.join(ARTIFACTS_DIR, "performance-ci");
        await mkdir(directory, { recursive: true }).then(() =>
          page.screenshot({ path: path.join(directory, "input-hit-failure.png"), timeout: 2000,
            clip: { x: Math.max(0, x - 100), y: Math.max(0, y - 50), width: 200, height: 100 } })).catch(() => undefined);
      }
      throw error;
    }
    hit = await read();
  }
  if (hit !== id) throw new Error("real input hit the wrong clip");
}

export interface DragTiming {
  geometry_ms: number;
  input_driver_ms: number;
  verification_ms: number;
  raf_wait_ms: number;
  raf_browser_ms: number;
  raf_max_browser_ms: number;
  raf_count: number;
}

export async function dragTo(page: Page, id: string, delta: number, timeout: number, trim = false, timing?: DragTiming): Promise<void> {
  const began = performance.now();
  const frame = async () => {
    const before = performance.now();
    // Use the existing rAF call: add no browser round trip or extra frame.
    const browserMs = await page.evaluate(() => {
      const before = globalThis.performance.now();
      return new Promise<number>(resolve => requestAnimationFrame(() => resolve(globalThis.performance.now() - before)));
    });
    if (timing) {
      timing.raf_wait_ms += performance.now() - before;
      timing.raf_browser_ms += browserMs;
      timing.raf_max_browser_ms = Math.max(timing.raf_max_browser_ms, browserMs);
      timing.raf_count++;
    }
  };
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const target = clipTarget(page, id);
  await target.scrollIntoViewIfNeeded();
  const scroller = page.getByTestId("timeline-tracks-scroll");
  if (trim) {
    // scrollIntoView cannot reveal both ends of an oversized clip. Aim its
    // right trim handle inside the scroll viewport, with room for movement.
    await scroller.evaluate((element, id) => {
      const clip = element.querySelector(`[data-live-editor-target-id="${id}"]`)!;
      const viewport = element.getBoundingClientRect();
      const end = clip.getBoundingClientRect().right - 3;
      if (end > viewport.right - 80) element.scrollLeft += end - (viewport.right - 80);
      else if (end < viewport.left + 80) element.scrollLeft += end - (viewport.left + 80);
    }, id);
  } else {
    // The synthetic drag targets stay near the beginning. Keep the full
    // gesture inside the viewport even when the clip is wider than it.
    await scroller.evaluate((element) => { element.scrollLeft = 0; });
  }
  await frame();
  const box = await target.boundingBox();
  if (!box) throw new Error("clip target has no geometry");
  const x = trim ? box.x + box.width - 3 : box.x + Math.min(box.width / 2, 50);
  // Drag the clip body clear of selectable labels/native image drags.
  const y = trim ? box.y + box.height / 2 : box.y + Math.min(box.height / 4, 8);
  await verifyHit(target, x, y, timeout);
  const before = await target.evaluate((element) => ({ transform: (element as HTMLElement).style.transform, width: (element as HTMLElement).style.width }));
  if (timing) timing.geometry_ms += performance.now() - began - timing.raf_wait_ms;
  const pointerBegan = performance.now();
  const priorRafMs = timing?.raf_wait_ms ?? 0;
  await page.mouse.move(x, y);
  await page.evaluate(() => {
    const root = globalThis as typeof globalThis & { __perfPointerEvidence?: { points: { x: number; y: number }[]; listener: (event: MouseEvent) => void } };
    const points: { x: number; y: number }[] = [];
    const listener = (event: MouseEvent) => { if (points.length < 64) points.push({ x: event.clientX, y: event.clientY }); };
    root.__perfPointerEvidence = { points, listener };
    window.addEventListener("mousemove", listener, true);
  });
  await page.mouse.down();
  // Let React install its gesture listener before the first movement.
  await frame();
  const downBox = await target.boundingBox();
  if (!downBox || Math.abs(downBox.x - box.x) > 1) {
    await page.mouse.up();
    throw new Error(`pointer-down changed clip geometry: ${box.x} -> ${downBox?.x}`);
  }
  for (let step = 1; step <= 6; step++) {
    await page.mouse.move(x + delta * step / 6, y);
    // Keep the requested input rate fixed and let React install/update the
    // gesture listener before the next move or pointer-up.
    await frame();
  }
  await page.mouse.up();
  const actual = await page.evaluate(() => {
    const root = globalThis as typeof globalThis & { __perfPointerEvidence?: { points: { x: number; y: number }[]; listener: (event: MouseEvent) => void } };
    const evidence = root.__perfPointerEvidence!;
    window.removeEventListener("mousemove", evidence.listener, true);
    delete root.__perfPointerEvidence;
    return evidence.points;
  });
  const planned = Array.from({ length: 7 }, (_, step) => ({ x: x + delta * step / 6, y }));
  const unexpected = unexpectedPointerMoves(actual, planned);
  if (unexpected.length) throw new Error(`unexpected_pointer_input: ${JSON.stringify({ trim, planned, actual, unexpected })}`);
  if (timing) timing.input_driver_ms += performance.now() - pointerBegan - (timing.raf_wait_ms - priorRafMs);
  const verificationBegan = performance.now();
  // Preview styles change during pointer movement, before the async commit.
  // ClipComponent clears this interaction state only in the commit's finally.
  // Observe that release before returning (including P01's unmeasured resets).
  await page.waitForFunction((id) => {
    const element = document.querySelector<HTMLElement>(`[data-live-editor-target-id="${id}"]`);
    return element && !element.style.willChange.includes("transform") && element.style.pointerEvents !== "none";
  }, id, { timeout, polling: "raf" });
  await page.waitForFunction(({ id, before, trim }) => {
    const element = document.querySelector<HTMLElement>(`[data-live-editor-target-id="${id}"]`);
    return element && (trim ? element.style.width !== before.width : element.style.transform !== before.transform);
  }, { id, before, trim }, { timeout: Math.max(1, timeout - (performance.now() - verificationBegan)), polling: "raf" });
  if (timing) timing.verification_ms += performance.now() - verificationBegan;
}

async function seek(page: Page, time: number, pixelsPerSecond: number): Promise<void> {
  const ruler = page.getByTestId("timeline-time-ruler");
  const box = await ruler.boundingBox();
  if (!box) throw new Error("timeline ruler has no geometry");
  await page.mouse.click(box.x + time * pixelsPerSecond, box.y + box.height / 2);
}

async function timeline(agent: ExternalAgent, target: { projectId: string; workspaceId: string }) {
  const result = await agent.callCommand<TimelineState>("timeline.get", target, { timeoutMs: 30_000 });
  if (!result.ok) throw new Error(`timeline read failed: ${result.error?.code} ${result.error?.message}`);
  return result.value!;
}

export async function runPerformanceScenario(scenarioId: TimelinePerformanceScenarioId, options: PerformanceRunOptions, repeat: number, coldIndex = 0): Promise<string> {
  const parameters: Record<string, number> = scenarioId === "T02" || scenarioId === "H02" ? { fontPayloadMiB: options.fontMiB } : scenarioId === "H01" ? { nodeCount: options.nodeCount } : scenarioId === "T03" ? { clipCount: options.clipCount, trackCount: options.trackCount } : {};
  const fixture = createPerformanceFixture({ scenarioId, seed: options.seed, parameters });
  const targetIdentity = { projectId: fixture.projectId!, workspaceId: fixture.workspaceId! };
  const runId = `${scenarioId.toLowerCase()}-${Date.now()}-${repeat}-${coldIndex}`;
  const buildIdentity = await captureBuildIdentity();
  if (!buildIdentity.build_verified) throw new Error(`Performance requires a verified production build: ${buildIdentity.build_reason}`);
  const runDir = await prepareProfile(fixture);
  let launched: LaunchedApp | undefined;
  let agent: ExternalAgent | undefined;
  let environment: Awaited<ReturnType<typeof readEnvironmentIdentity>> | undefined;
  let timedOut = false;
  let failure: unknown;
  let activeCapture = false;
  const samples: RawPerformanceOperation[] = [];
  const windows: RendererWindowEvidence[] = [];
  const correctness: Record<string, boolean | null> = { target_frame_verified: null, durable_final_revision_verified: null };
  let hydratedStructureBytes: number | null = null;
  const reasonCodes: string[] = [];
  const watchdog = setTimeout(() => {
    timedOut = true;
    void launched?.close({ keepRunDir: true }).catch((error) => { failure ??= error; });
  }, options.runTimeoutSeconds * 1000);
  const capture = async (metric: string, action: () => Promise<void>, verify: () => Promise<void>) => {
    const id = `${metric}-${samples.length + 1}`;
    await launched!.page.evaluate(({ runId, id, seconds }) => (globalThis as ProbeGlobal).__reelterminalPerfDriver.start(runId, id, seconds), { runId, id, seconds: options.operationTimeoutMs / 1000 });
    activeCapture = true;
    const started = performance.now();
    try {
      await action();
      await verify();
      // Two finite rendering turns let observer callbacks arrive before freezing.
      await launched!.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      // Product spans include queued persistence; observe its actual completion
      // within this operation's existing deadline before freezing evidence.
      const evidence = await stopCaptureWhenIdle(launched!.page, {
        runId,
        requireGestureFrame: scenarioId !== "P01" && /timeline_.*_(drag|trim)_verified/.test(metric),
        requireFrame: /seek/.test(metric),
      }, options.operationTimeoutMs);
      activeCapture = false;
      windows.push(evidence);
      if (!captureComplete(evidence)) throw new Error("capture incomplete or window hidden");
      if (/timeline_.*_(drag|trim)_verified/.test(metric)) {
        const commits = evidence.report.events.filter(event => event.phase === "semantic-state.committed");
        const finals = evidence.report.events.filter(event => event.phase === "gesture.final-commit");
        if (commits.length !== 1 || finals.length !== 1) throw new Error("gesture did not commit exactly one semantic transaction");
        if ((evidence.report.counters["project.full-json-copies"] ?? 0) !== 0 ||
            (evidence.report.counters["project.full-structured-clones"] ?? 0) !== 0) {
          throw new Error("gesture copied the full project for its edit transaction");
        }
        correctness.single_transaction_per_gesture_verified = true;
        correctness.no_full_project_copy_for_gesture_transaction_verified = true;
      }
      samples.push({ operation_id: id, metric, outcome: "ok", duration_ms: evidence.report.wallDurationUs / 1000, target_verified: true });
    } catch (error) {
      if (activeCapture && !launched!.page.isClosed()) {
        windows.push(await launched!.page.evaluate(() => (globalThis as ProbeGlobal).__reelterminalPerfDriver.stop("error")));
        activeCapture = false;
      }
      samples.push({ operation_id: id, metric, outcome: timedOut || (error as Error).name === "TimeoutError" ? "timeout" : "failed", duration_ms: null, waited_ms: performance.now() - started, target_verified: false });
      throw error;
    }
  };
  try {
    if (options.cache === "reused-profile") {
      const prime = await launchApp({ runDir, skipLocaleReload: true });
      await prime.close({ keepRunDir: true });
    }
    launched = await launchApp({ runDir, skipLocaleReload: true });
    launched.page.setDefaultTimeout(options.operationTimeoutMs);
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(1280, 800);
      window.show();
      window.focus();
    });
    environment = await readEnvironmentIdentity(launched);
    if (!environment.visible || environment.devtools_open) throw new Error("invalid performance window state");
    await installProbe(launched.page);
    const openProject = () => launched!.page.getByRole("button", { name: `Open ${fixture.project!.name}`, exact: true }).click();
    const openNode = async () => {
      const target = launched!.page.getByTestId(`version-node-${fixture.targetNodeId}`);
      if (!await target.isVisible()) await launched!.page.getByTestId("current-archive-entry").click();
      await target.scrollIntoViewIfNeeded();
      await target.dblclick();
      await launched!.page.getByTestId("version-preview-banner").waitFor();
    };
    const verifyNode = async () => {
      const name = fixture.records!.nodes.find((node) => node.id === fixture.targetNodeId)!.name;
      if (!(await launched!.page.getByTestId("version-preview-banner").innerText()).includes(name)) throw new Error("history node identity mismatch");
      await waitForMarker(launched!.page, fixture, options.operationTimeoutMs);
      correctness.target_frame_verified = true;
    };
    if (scenarioId.startsWith("H")) {
      if (options.cache !== "warm") {
        await capture("history_cold_entry_content_verified_ms", async () => { await openProject(); await openNode(); }, verifyNode);
      } else {
        await openProject();
        // Fixed one-node warmup, then return to a visibly different current frame.
        await openNode();
        await verifyNode();
        await launched.page.getByTestId("version-preview-return").click();
        for (let index = 0; index < options.samples; index++) {
          await launched.page.waitForFunction(() => !document.querySelector('[data-testid="version-preview-banner"]'));
          await waitForMarker(launched.page, { ...fixture, targetMarker: { ...fixture.targetMarker!, rgb: [210, 75, 75] } }, options.operationTimeoutMs);
          if (markerMatches(await markerPixel(launched.page, fixture), fixture.targetMarker!.rgb)) throw new Error("old target frame remained before history request");
          await capture("history_warm_node_content_verified_ms", openNode, verifyNode);
          await launched.page.getByTestId("version-preview-return").click();
        }
      }
    } else {
      await openProject();
      await launched.page.getByTestId("agent-access-status").waitFor();
      await enableAgentSessionViaUI(launched.page, launched.endpointFile);
      await launched.waitForEndpointFile();
      agent = await connectExternalAgent(launched.endpointFile);
      if (scenarioId === "T02") {
        hydratedStructureBytes = await readHydratedStructureBytes(launched, targetIdentity, options.operationTimeoutMs);
        if (hydratedStructureBytes !== fixture.manifest.parameters.fontDataUrlUtf8Bytes) throw new Error("synthetic structure payload missing after hydration");
      }
      const snap = launched.page.getByRole("button", { name: "Snap on (N)", exact: true });
      if (await snap.count()) await snap.click();
      const mediaId = fixture.targetMediaClipId!;
      const textId = fixture.targetTextClipId!;
      if (scenarioId === "P01" || scenarioId === "T03") {
        const slider = launched.page.getByRole("slider", { name: "Timeline zoom", exact: true });
        const box = (await slider.boundingBox())!;
        // Real range input establishes a stable ~100 px/s view before gestures.
        await launched.page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
        await launched.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      }
      const initialBox = await clipTarget(launched.page, mediaId).boundingBox();
      if (!initialBox) throw new Error("target clip missing");
      const initial = await timeline(agent, targetIdentity);
      const initialClip = initial.tracks.flatMap((track) => track.clips).find((clip) => clip.id === mediaId)!;
      let pixelsPerSecond = initialBox.width / initialClip.duration;
      await seek(launched.page, scenarioId === "P01" ? 0.5 : 3, pixelsPerSecond);
      await waitForMarker(launched.page, fixture, options.operationTimeoutMs);
      // Fixed rendering warmup; no measured edits are used to warm history.
      await launched.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const move = async (id: string, delta: number, trim = false) => {
        const before = await timeline(agent!, targetIdentity);
        const beforeClip = id === textId ? before.textOverlays.find((clip) => clip.id === id)! : before.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
        const expected = (trim ? beforeClip.duration : beforeClip.startTime) + delta / pixelsPerSecond;
        await capture(trim ? "timeline_media_trim_verified_ms" : id === textId ? "timeline_text_drag_verified_ms" : "timeline_media_drag_verified_ms", () => dragTo(launched!.page, id, delta, options.operationTimeoutMs, trim), async () => {
          const deadline = performance.now() + options.operationTimeoutMs;
          let observed: number | undefined;
          let observedRevision: number | undefined;
          let trackVerified = false;
          while (performance.now() < deadline) {
            const after = await timeline(agent!, targetIdentity);
            observedRevision = after.revision;
            const afterClip = id === textId ? after.textOverlays.find((clip) => clip.id === id)! : after.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
            observed = trim ? afterClip.duration : afterClip.startTime;
            trackVerified = afterClip.trackId === beforeClip.trackId;
            if (trackVerified && Math.abs(observed - expected) <= 0.06) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!trackVerified || observed === undefined || Math.abs(observed - expected) > 0.06) {
            correctness.final_state_verified = false;
            const geometry = await clipTarget(launched!.page, id).evaluate((element) => ({
              width: element.getBoundingClientRect().width,
              zoom: document.querySelector('[aria-label="Timeline zoom"]')?.getAttribute("aria-valuetext"),
              scrollLeft: document.querySelector('[data-testid="timeline-tracks-scroll"]')?.scrollLeft,
            }));
            throw new Error(`gesture final state mismatch: expected ${expected}, observed ${observed}, pps ${pixelsPerSecond}, geometry ${JSON.stringify(geometry)}`);
          }
          if (observedRevision !== before.revision + 1) {
            correctness.single_revision_per_gesture_verified = false;
            throw new Error("gesture did not advance exactly one revision");
          }
          correctness.single_revision_per_gesture_verified = true;
          if (scenarioId !== "P01") await waitForMarker(launched!.page, fixture, options.operationTimeoutMs);
        });
        correctness.final_state_verified = true;
        if (scenarioId !== "P01") correctness.target_frame_verified = true;
      };
      const verifyUndoRedo = async (before: TimelineState, after: TimelineState) => {
        const equal = (actual: TimelineState, expected: TimelineState) => isDeepStrictEqual({ tracks: actual.tracks, text: actual.textOverlays }, { tracks: expected.tracks, text: expected.textOverlays });
        for (const [action, expected] of [["undo", before], ["redo", after]] as const) {
          const current = await timeline(agent!, targetIdentity);
          const reply = await agent!.callCommand("history.control", { ...targetIdentity, action, expectedRevision: current.revision, idempotencyKey: `${runId}-${current.revision}-${action}` });
          const actual = await timeline(agent!, targetIdentity);
          if (!reply.ok || !equal(actual, expected)) {
            const directory = path.join(ARTIFACTS_DIR, "performance");
            await mkdir(directory, { recursive: true });
            await writeFile(path.join(directory, `${runId}.${action}-failure.json`), JSON.stringify({ reply: { ok: reply.ok, error: reply.error }, expected, actual }, null, 2));
            throw new Error(`large timeline ${action} did not restore the full state`);
          }
        }
        await waitForMarker(launched!.page, fixture, options.operationTimeoutMs);
        correctness.undo_redo_full_state_verified = true;
      };
      if (scenarioId === "P01") {
        for (let index = 0; index < options.samples; index++) {
          if (index > 0) {
            // Repeat the fixture gesture sequence from its original duration.
            await dragTo(launched.page, mediaId, -0.5 * pixelsPerSecond, options.operationTimeoutMs, true);
          }
          for (const step of fixture.gesturePlan!.steps) {
            const state = await timeline(agent, targetIdentity);
            const clip = state.tracks.flatMap((track) => track.clips).find((clip) => clip.id === mediaId)!;
            const delta = step.kind === "trim" ? step.duration - clip.duration : step.startTime - clip.startTime;
            await move(mediaId, delta * pixelsPerSecond, step.kind === "trim");
          }
        }
        // A known different frame rules out a stale pre-gesture target bitmap.
        await seek(launched.page, 6.25, pixelsPerSecond);
        await waitForMarker(launched.page, { ...fixture, targetMarker: fixture.controlMarker! }, options.operationTimeoutMs);
        await seek(launched.page, 4.25, pixelsPerSecond);
        await waitForMarker(launched.page, fixture, options.operationTimeoutMs);
        correctness.target_frame_verified = true;
        const oldSaveToasts = launched.page.getByTestId("notification-toast").filter({ hasText: "Current edits saved" });
        for (const toast of await oldSaveToasts.all()) await toast.getByRole("button", { name: "Dismiss notification" }).click();
        await oldSaveToasts.first().waitFor({ state: "hidden" });
        await capture("save_flush_confirmed_ms", () => launched!.page.keyboard.press("Control+s"), async () => {
          await launched!.page.getByTestId("notification-toast").getByText("Current edits saved", { exact: true }).last().waitFor();
        });
        const stateBefore = await timeline(agent, targetIdentity);
        await agent.close();
        agent = undefined;
        launched = await launched.relaunch();
        await openProject();
        await enableAgentSessionViaUI(launched.page, launched.endpointFile);
        agent = await connectExternalAgent(launched.endpointFile);
        const readback = await timeline(agent, targetIdentity);
        const actual = readback.tracks.flatMap((track) => track.clips).find((clip) => clip.id === mediaId)!;
        const expected = fixture.gesturePlan!.expectedDurableState;
        if (readback.revision !== stateBefore.revision || Math.abs(actual.startTime - expected.startTime) > 0.06 || Math.abs(actual.duration - expected.duration) > 0.06) {
          correctness.durable_final_revision_verified = false;
          throw new Error("durable final revision or clip timing lost on relaunch");
        }
        correctness.durable_final_revision_verified = true;
      } else {
        for (let index = 0; index < options.samples; index++) {
          const direction = index % 2 === 0 ? 1 : -1;
          // Each single-selection distribution starts from a known selection.
          if (scenarioId === "T03") await selectClipsWithKeyboard(launched.page, [mediaId]);
          const beforeDrag = scenarioId === "T03" && index === 0 ? await timeline(agent!, targetIdentity) : null;
          await move(mediaId, direction * pixelsPerSecond * 0.5);
          if (beforeDrag) await verifyUndoRedo(beforeDrag, await timeline(agent!, targetIdentity));
          if (scenarioId === "T02") await move(textId, direction * pixelsPerSecond * 0.5);
          if (scenarioId === "T03") {
            const state = await timeline(agent, targetIdentity);
            const clips = state.tracks.flatMap((track) => track.clips);
            const primary = clips.find((clip) => clip.id === mediaId)!;
            const companion = clips.find((clip) => clip.trackId === primary.trackId && clip.id !== mediaId)!;
            const selected = [primary, companion];
            const secondId = selected[1]!.id;
            await selectClipsWithKeyboard(launched.page, [mediaId, secondId]);
            await capture("timeline_multiselect_drag_verified_ms", () => dragTo(launched!.page, mediaId, direction * pixelsPerSecond * 0.25, options.operationTimeoutMs), async () => {
              const deadline = performance.now() + options.operationTimeoutMs;
              let verified = false;
              let observed: { revision: number; times: number[] } | undefined;
              while (performance.now() < deadline) {
                const after = await timeline(agent!, targetIdentity);
                observed = { revision: after.revision, times: selected.map((before) => after.tracks.flatMap((track) => track.clips).find((clip) => clip.id === before.id)!.startTime) };
                verified = after.revision === state.revision + 1 && selected.every((before) => {
                  const actual = after.tracks.flatMap((track) => track.clips).find((clip) => clip.id === before.id)!;
                  return actual.trackId === before.trackId && Math.abs(actual.startTime - before.startTime - direction * 0.25) <= 0.06;
                });
                if (verified) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              if (!verified) throw new Error(`multi-selection gesture mismatch: revision ${state.revision} -> ${observed?.revision}; start times ${selected.map((clip) => clip.startTime)} -> ${observed?.times}`);
              await waitForMarker(launched!.page, fixture, options.operationTimeoutMs);
            });
            await selectClipsWithKeyboard(launched.page, [mediaId]);
            correctness.multiselection_transaction_verified = true;
            if (index === 0) await verifyUndoRedo(state, await timeline(agent!, targetIdentity));
          }
          if (scenarioId === "T01" || scenarioId === "T03") {
            const beforeTrim = scenarioId === "T03" && index === 0 ? await timeline(agent!, targetIdentity) : null;
            await move(mediaId, direction * pixelsPerSecond * 0.2, true);
            if (beforeTrim) await verifyUndoRedo(beforeTrim, await timeline(agent!, targetIdentity));
            const scroller = launched.page.getByTestId("timeline-tracks-scroll");
            const beforeScroll = await scroller.evaluate((element) => element.scrollLeft);
            const box = (await scroller.boundingBox())!;
            await capture("timeline_scroll_verified_ms", async () => { await launched!.page.mouse.move(box.x + 100, box.y + 30); await launched!.page.mouse.wheel(120, 0); }, async () => {
              await launched!.page.waitForFunction((before) => document.querySelector('[data-testid="timeline-tracks-scroll"]')!.scrollLeft !== before, beforeScroll);
            });
            // Restore scroll outside the measured window before aiming the next control.
            await scroller.evaluate((element) => { element.scrollLeft = 0; });
            const beforeZoom = await clipTarget(launched.page, mediaId).boundingBox();
            await capture("timeline_zoom_verified_ms", () => launched!.page.getByRole("button", { name: direction > 0 ? "Zoom in" : "Zoom out", exact: true }).click(), async () => {
              await launched!.page.waitForFunction(({ id, width }) => document.querySelector(`[data-live-editor-target-id="${id}"]`)!.getBoundingClientRect().width !== width, { id: mediaId, width: beforeZoom!.width });
            });
            const newBox = (await clipTarget(launched.page, mediaId).boundingBox())!;
            const state = await timeline(agent, targetIdentity);
            pixelsPerSecond = newBox.width / state.tracks.flatMap((track) => track.clips).find((clip) => clip.id === mediaId)!.duration;
            const requestedTime = index % 2 === 0 ? 2.5 : 3;
            await capture("timeline_seek_content_verified_ms", () => seek(launched!.page, requestedTime, pixelsPerSecond), async () => {
              const context = await agent!.callCommand<{ playheadSeconds: number }>("editor.get_context", targetIdentity, { timeoutMs: options.operationTimeoutMs });
              if (!context.ok || Math.abs(context.value!.playheadSeconds - requestedTime) > 0.06) throw new Error("seek did not reach requested playhead");
              await waitForMarker(launched!.page, fixture, options.operationTimeoutMs);
            });
          }
          if (scenarioId === "T03" && (index + 1) % 10 === 0) console.info("PERFORMANCE_TIMELINE_PROGRESS", { run_id: runId, completed_rounds: index + 1, completed_per_operation: index + 1 });
        }
      }
    }
  } catch (error) {
    failure = error;
    reasonCodes.push(timedOut ? "run_timeout" : "scenario_failed");
    if (correctness.target_frame_verified !== true) correctness.target_frame_verified = false;
    if (launched && !launched.page.isClosed()) {
      const evidenceDirectory = path.join(ARTIFACTS_DIR, "performance");
      await mkdir(evidenceDirectory, { recursive: true });
      await launched.page.screenshot({ path: path.join(evidenceDirectory, `${runId}.failure.png`) });
    }
  } finally {
    clearTimeout(watchdog);
    try { await agent?.close(); } catch (error) { failure ??= error; reasonCodes.push("connector_cleanup_failed"); }
    try { await launched?.close({ keepRunDir: true }); } catch (error) { failure ??= error; reasonCodes.push("process_cleanup_failed"); }
  }
  if (!environment) {
    const directory = path.join(ARTIFACTS_DIR, "performance");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${runId}.preflight.json`), JSON.stringify({
      schema: "reelterminal.performance-preflight/v1", status: "invalid", run_id: runId,
      reason_codes: [...reasonCodes, "environment_unavailable"], retained_profile: runDir,
      build: buildIdentity, fixture_manifest: fixture.manifest,
    }, null, 2));
    throw failure ?? new Error("environment capture missing");
  }
  if (samples.length === 0) samples.push({ operation_id: "setup", metric: "scenario_setup_failed_ms", outcome: "failed", duration_ms: null, target_verified: false });
  const result = createPerformanceResult({
    run: {
      run_id: runId, scenario_id: scenarioId, scenario_version: fixture.manifest.version, seed: options.seed,
      fixture_manifest: fixture.manifest, fixture_manifest_sha256: performanceFixtureManifestSha256(fixture.manifest),
      expected_operations: samples.length, mode: "light", cache_state: options.cache === "warm" ? "warm_fixed_prepare" : options.cache === "fresh-profile" ? "fresh_profile_process_cold" : "reused_profile_process_cold",
      sampling: { input_every_n: 1, frame_every_n: 1 }, budgets: { capture_seconds: options.operationTimeoutMs / 1000, events_capacity: 16384, run_seconds: options.runTimeoutSeconds },
      warmup: options.cache === "warm" ? (scenarioId.startsWith("H") ? "one_target_node_preview_then_return" : "two_raf_turns_marker_verified") : "none_editor_not_opened_during_seed",
      repeat, cold_launch_index: coldIndex, physical_disk_cold: "not_measured", font_decode: scenarioId === "T02" || scenarioId === "H02" ? "unsupported_missing_licensed_large_font_fixture" : "not_applicable",
      hydrated_structure_bytes: hydratedStructureBytes,
      measurement_boundary: "renderer_capture_start_to_verified_dom_canvas_and_settled_product_spans",
      frame_evidence: "canvas_pixel_marker_and_target_dom_identity", actual_presented: "unsupported", frame_token_instrumentation: "product_scheduler_seq_epoch_revision",
    },
    build: { ...buildIdentity }, environment: { ...environment }, samples, correctness,
    validity: { complete: !failure && windows.every(captureComplete), reason_codes: [...reasonCodes, ...windows.flatMap(window => window.main?.ok ? window.main.mainCapture.reasonCodes : ["main_capture_unavailable"])], events_dropped: windows.reduce((sum, window) => sum + window.report.drops.eventsDropped + (window.main?.ok ? window.main.mainCapture.eventsDropped : 0), 0), critical_endpoints_dropped: windows.reduce((sum, window) => sum + window.report.drops.criticalEndpointsDropped, 0), probe_calibrated: false },
  });
  const artifactDirectory = path.join(ARTIFACTS_DIR, "performance");
  await mkdir(artifactDirectory, { recursive: true });
  const file = path.join(artifactDirectory, `${runId}.result.json`);
  let artifactDocument: Record<string, unknown> = {
    ...result,
    action_windows: windows,
    product_measurements: windows.map(window => extractProductMeasurements(window.report)),
  };
  let json = JSON.stringify(artifactDocument, null, 2);
  let actionWindowArtifactReferences: readonly ActionWindowArtifactReference[] = [];
  if (Buffer.byteLength(json) > 10 * 1024 * 1024) {
    const bundle = createActionWindowArtifactParts(windows, runId);
    for (const part of bundle.parts) {
      await writeFile(path.join(artifactDirectory, part.reference.artifact), part.content);
    }
    actionWindowArtifactReferences = bundle.descriptor.artifacts;
    artifactDocument = {
      ...artifactDocument,
      action_windows: bundle.descriptor,
      artifacts: [...result.artifacts, ...bundle.descriptor.artifacts],
    };
    json = JSON.stringify(artifactDocument, null, 2);
  }
  if (Buffer.byteLength(json) > 10 * 1024 * 1024) {
    await writeFile(file.replace(/\.result\.json$/, ".preflight.json"), JSON.stringify({
      schema: "reelterminal.performance-preflight/v1", status: "invalid", run_id: runId,
      reason_codes: ["artifact_budget_exceeded"], requested_operations: samples.length,
      retained_profile: runDir,
      action_window_artifacts: actionWindowArtifactReferences,
    }, null, 2));
    throw new Error("performance result remains above 10 MiB after externalizing action windows");
  }
  const validation = validateResultDocument(artifactDocument);
  await writeFile(file, json);
  if (!failure) await rm(runDir, { recursive: true, force: true });
  if (!validation.valid) throw new Error(`Performance result invalid: ${validation.errors.join("; ")}`);
  if (failure) throw failure;
  return file;
}
