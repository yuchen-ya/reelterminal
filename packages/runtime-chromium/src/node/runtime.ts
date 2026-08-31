/**
 * ChromiumRuntime — the Node-side host for the real browser (ADR 0002).
 *
 * One runtime = one Chromium process = one page. All page operations are
 * serialized through a mutex EXCEPT cooperative aborts, which must reach the
 * page while a long export evaluate is still running (the in-page export
 * loop yields between frames, so the abort evaluate interleaves).
 *
 * Media never crosses the bridge: files are assigned to the page's file
 * input as disk-backed File objects (Chromium streams slices on demand).
 * Output bytes cross the bridge the other way as bounded 4 MiB chunks and
 * land in a `.part` file that is only renamed into place on success — a
 * failed/cancelled export never leaves a success-looking MP4 behind.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Project } from "@openreel/core/types/project";

import { buildBrowserEntry } from "./bundle";

export interface ChromiumRuntimeOptions {
  /** Explicit chromium executable; defaults to the Playwright-managed one. */
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly launchArgs?: readonly string[];
  /** Forward in-page console messages and page errors (diagnostics). */
  readonly onConsole?: (line: string) => void;
  /**
   * Hard ceiling for ONE probe/hydrate/render page evaluate (default
   * 120_000). Export evaluates are governed by the export watchdog instead.
   * (playwright-core 1.60 has no protocol-level evaluate timeout at all —
   * verified: a 185 s evaluate completes — so the watchdog really is the
   * only ceiling an export needs.)
   */
  readonly pageOpTimeoutMs?: number;
}

export interface PageProbeFacts {
  readonly offscreenCanvas: boolean;
  readonly offscreenPngEncode: boolean;
  readonly videoDecoder: Record<string, boolean>;
  readonly videoEncoder: Record<string, boolean>;
  readonly audioEncoderAac: boolean | null;
  readonly videoEngineInit: boolean;
  readonly exportEngineInit: boolean;
  readonly webCodecsSupported?: boolean;
  readonly mediabunnyLoaded: boolean;
  readonly firstEncodableVideo: {
    readonly avc: string | null;
    readonly vp9: string | null;
    readonly vp8: string | null;
  } | null;
  readonly decodeSample: {
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly codec?: string;
    readonly width?: number;
    readonly height?: number;
    readonly reason?: string;
  } | null;
  readonly errors: readonly string[];
}

export interface WebcodecsExportOutcome {
  readonly success: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly framesRendered?: number;
  readonly bytesWritten?: number;
}

export interface ExportProgressJson {
  readonly phase: "preparing" | "rendering" | "encoding" | "muxing" | "complete";
  readonly progress: number;
  readonly currentFrame: number;
  readonly totalFrames: number;
  readonly bytesWritten: number;
}

/** Random-access writer for the streaming MP4 shim (`.part` until success). */
export class PartFileWriter {
  private fd: FileHandle | null = null;
  private position = 0;
  // High-water mark of written end positions, not a write sum: the chunked
  // StreamTarget rewrites regions (e.g. header patches after a mid-stream
  // flush), and summing those bytes would overcount the real file size.
  private bytesWritten = 0;

  private constructor(
    readonly partPath: string,
    readonly finalPath: string,
  ) {}

  static async open(finalPath: string): Promise<PartFileWriter> {
    const writer = new PartFileWriter(`${finalPath}.part`, finalPath);
    writer.fd = await open(writer.partPath, "w");
    return writer;
  }

  get bytes(): number {
    return this.bytesWritten;
  }

  async seek(position: number): Promise<void> {
    this.position = position;
  }

  async writeBase64(base64: string): Promise<void> {
    if (!this.fd) throw new Error("PartFileWriter is closed");
    const buffer = Buffer.from(base64, "base64");
    await this.fd.write(buffer, 0, buffer.length, this.position);
    this.position += buffer.length;
    if (this.position > this.bytesWritten) this.bytesWritten = this.position;
  }

  /** Close and atomically rename into place. Only route to real artifacts. */
  async finalize(): Promise<number> {
    if (this.fd) {
      await this.fd.close();
      this.fd = null;
    }
    await rename(this.partPath, this.finalPath);
    return this.bytesWritten;
  }

  /**
   * Close and remove BOTH the partial and any finalized file — a cancelled
   * or failed export must leave nothing success-looking behind, including a
   * file that raced through finalize() before the cancel landed.
   */
  async discard(): Promise<void> {
    if (this.fd) {
      try {
        await this.fd.close();
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    await rm(this.partPath, { force: true });
    await rm(this.finalPath, { force: true });
  }
}

interface SinkBridge {
  seek(position: number): Promise<void>;
  writeBase64(base64: string): Promise<void>;
  finalize(): Promise<unknown>;
  discard(): Promise<unknown>;
  progress(event: ExportProgressJson): void;
}

const MEDIA_INPUT_SELECTOR = "#__openreel-media";

/** Bound on graceful browser/server teardown during close()/recycle(). */
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Default ceiling for ONE page evaluate (probe/hydrate/render). Exports are
 * NOT covered here — the export watchdog owns that ceiling. On fire the
 * runtime recycles the browser (which rejects the wedged evaluate) and the
 * caller fails loudly instead of hanging the page lock forever.
 */
const DEFAULT_PAGE_OP_TIMEOUT_MS = 120_000;

/** Thrown inside the lock chain when a queued op outlived its browser. */
class RuntimeRecycledWhileQueued extends Error {
  constructor() {
    super("runtime was recycled while this operation was queued");
    this.name = "RuntimeRecycledWhileQueued";
  }
}

/** Thrown when a hydrated session is cancelled before any work began. */
export class HydratedSessionCancelled extends Error {
  constructor() {
    super("cancelled before the page session started");
    this.name = "HydratedSessionCancelled";
  }
}

/** Thrown when one page evaluate exceeds the page-op ceiling. */
class PageOpTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(
      `${label} evaluate exceeded the ${timeoutMs}ms page-op ceiling — recycling the runtime`,
    );
    this.name = "PageOpTimeoutError";
  }
}

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>openreel-render</title></head>
<body><input id="__openreel-media" type="file" multiple style="display:none"></body></html>`;

export class ChromiumRuntime {
  private readonly options: ChromiumRuntimeOptions;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private server: Server | null = null;
  private launchPromise: Promise<Page> | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private sinkBridge: SinkBridge | null = null;
  private sinkBindingsReady = false;
  private closed = false;
  /**
   * Bumped every time the browser instance is replaced (recycle or crash).
   * Consumers key any per-browser cached state (probe results, exposed
   * bindings) on this so a stale success can never outlive its browser.
   */
  private generationCounter = 0;

  constructor(options: ChromiumRuntimeOptions = {}) {
    this.options = options;
  }

  /** Identity of the current browser instance; changes on recycle/crash. */
  get generation(): number {
    return this.generationCounter;
  }

  /** True while a launched browser still reports itself connected. */
  get isBrowserConnected(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * TEST-ONLY crash switch: kill the browser out from under the runtime
   * WITHOUT the orderly teardown of close()/recycle(). The resulting
   * 'disconnected' event drives the exact same recovery path a real crash
   * (OOM kill, segfault) would — nothing in production code may call this.
   */
  async simulateBrowserCrashForTesting(): Promise<void> {
    const browser = this.browser;
    if (!browser) return;
    await browser.close().catch(() => undefined);
  }

  /**
   * TEST-ONLY page-loss switch: kill the RENDERER while the browser stays
   * connected — the scenario the crash/close handler exists for. Tries CDP
   * `Page.crash` first (not every platform build implements it; the call
   * never acknowledges since the renderer dies first); if the page is
   * still alive a moment later, closes it out from under the runtime —
   * either way the page-loss recovery path is exercised. Never call this
   * in production code.
   */
  async simulateRendererCrashForTesting(): Promise<void> {
    const page = this.page;
    if (!page) return;
    try {
      const session = await page.context().newCDPSession(page);
      void session.send("Page.crash").catch(() => undefined);
    } catch {
      /* CDP unavailable on this build */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    if (this.page === page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }

  /* --------------------------- lifecycle --------------------------- */

  private async ensurePage(): Promise<Page> {
    if (this.closed) throw new Error("ChromiumRuntime is closed");
    this.launchPromise ??= this.launch().catch((error: unknown) => {
      // A failed launch must neither brick the runtime forever nor leak a
      // half-started browser: clear the memo so the next call retries.
      this.launchPromise = null;
      throw error;
    });
    return this.launchPromise;
  }

  /**
   * The browser died without us closing it (crash, OOM kill). Drop every
   * reference and bump the generation so the next operation relaunches and
   * cached per-browser state (probe facts, exposed functions) is rebuilt
   * instead of trusted blindly.
   */
  private onBrowserDisconnected(browser: Browser): void {
    if (this.browser !== browser) return;
    this.browser = null;
    this.page = null;
    this.launchPromise = null;
    this.sinkBridge = null;
    this.sinkBindingsReady = false;
    this.generationCounter += 1;
  }

  private async launch(): Promise<Page> {
    let browser: Browser | null = null;
    let server: Server | null = null;
    try {
      const launchedBrowser = await chromium.launch({
        headless: this.options.headless ?? true,
        // ADR 0003 Decision 7: signal ownership belongs to the embedding
        // transport — Playwright's default SIGINT/SIGTERM/SIGHUP handlers
        // would kill the browser out from under the bounded cancel/dispose
        // path. Nothing else about the launch changes.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(this.options.executablePath
          ? { executablePath: this.options.executablePath }
          : {}),
        args: [
          "--disable-dev-shm-usage",
          // OfflineAudioContext/AudioContext rendering must not stall on the
          // autoplay policy in headless export sessions.
          "--autoplay-policy=no-user-gesture-required",
          ...(this.options.launchArgs ?? []),
        ],
      });
      browser = launchedBrowser;
      this.browser = launchedBrowser;
      launchedBrowser.on("disconnected", () =>
        this.onBrowserDisconnected(launchedBrowser),
      );

      // WebCodecs (VideoDecoder/VideoEncoder) is gated on a secure context;
      // about:blank/setContent is NOT one, but 127.0.0.1 is. Serve the harness
      // page + bundle from a loopback-only server on an ephemeral port.
      const bundle = await buildBrowserEntry();
      server = createServer((req, res) => {
        if (req.url === "/bundle.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(bundle);
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
      });
      this.server = server;
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.once("error", rejectListen);
        server!.listen(0, "127.0.0.1", () => resolveListen());
      });
      const { port } = server.address() as AddressInfo;

      const page = await browser.newPage();
      // A lost RENDERER (OOM in a big raster, GPU process death, or the
      // page otherwise vanishing out from under us) does NOT fire the
      // browser's 'disconnected': the browser stays connected and the page
      // stays assigned, so without this handler the pool would serve stale
      // capabilities against a corpse forever. Crash and unexpected close
      // take the same recycle path — the generation bump is synchronous.
      const onPageGone = () => {
        if (this.page !== page) return;
        void this.recycle().catch(() => undefined);
      };
      page.on("crash", onPageGone);
      page.on("close", onPageGone);
      const onConsole = this.options.onConsole;
      if (onConsole) {
        page.on("console", (msg) => onConsole(`[page:${msg.type()}] ${msg.text()}`));
        page.on("pageerror", (error) => onConsole(`[page:error] ${error.message}`));
      }
      await page.goto(`http://127.0.0.1:${port}/`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.addScriptTag({ url: "/bundle.js", type: "module" });
      await page.waitForFunction(
        () =>
          (window as { __openreelRender?: unknown }).__openreelRender !==
          undefined,
        undefined,
        { timeout: 60_000 },
      );
      this.page = page;
      return page;
    } catch (error) {
      // Reap the partial launch: no orphaned browser/server on any failure
      // between browser start and a ready page.
      this.browser = null;
      this.server = null;
      this.page = null;
      if (browser) await browser.close().catch(() => undefined);
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.teardownBrowser();
  }

  /**
   * Kill the current browser but keep the runtime USABLE: the next operation
   * launches a fresh browser on a bumped generation. This is the watchdog /
   * post-crash recovery path — a wedged page must never brick the pool.
   *
   * The page mutex is deliberately NOT reset: there is exactly ONE lock
   * chain for the runtime's whole life. The wedged operation's evaluate
   * rejects when its browser dies, which advances the chain; anything that
   * was queued before the recycle sees the generation change and re-enqueues
   * at the tail (see withPageLock), so two operations can never find
   * themselves running concurrently on the fresh page.
   */
  async recycle(): Promise<void> {
    if (this.closed) return;
    this.generationCounter += 1;
    await this.teardownBrowser();
  }

  private async teardownBrowser(): Promise<void> {
    const browser = this.browser;
    const server = this.server;
    this.browser = null;
    this.page = null;
    this.server = null;
    this.launchPromise = null;
    this.sinkBridge = null;
    this.sinkBindingsReady = false;
    if (browser) {
      // A wedged browser must not hold recovery hostage: bound the close.
      // (Playwright has no public process handle to force-kill here.)
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise<void>((resolveTimeout) =>
          setTimeout(resolveTimeout, BROWSER_CLOSE_TIMEOUT_MS),
        ),
      ]);
    }
    if (server) {
      await Promise.race([
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
        new Promise<void>((resolveTimeout) =>
          setTimeout(resolveTimeout, SERVER_CLOSE_TIMEOUT_MS),
        ),
      ]);
    }
  }

  /**
   * Serialize page operations; exports hold the lock for their duration.
   *
   * There is exactly ONE lock chain for the runtime's lifetime (recycle
   * never resets it). An operation enqueued before a recycle/crash sees the
   * generation change before its turn comes and re-enqueues at the CURRENT
   * tail — so it still runs, serialized, on the fresh browser, and two
   * operations can never execute concurrently on one page.
   */
  private async withPageLock<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    for (;;) {
      const generationAtEnqueue = this.generationCounter;
      const run = this.mutex.then(async () => {
        if (this.generationCounter !== generationAtEnqueue) {
          throw new RuntimeRecycledWhileQueued();
        }
        return fn(await this.ensurePage());
      });
      this.mutex = run.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await run;
      } catch (error) {
        if (error instanceof RuntimeRecycledWhileQueued && !this.closed) {
          continue; // to the back of the (single) line, on the fresh browser
        }
        throw error;
      }
    }
  }

  /**
   * page.evaluate with a hard ceiling. A wedged evaluate must not hold the
   * page lock (and thereby the whole pool) forever: on timeout the browser
   * is recycled — which rejects the wedged evaluate — and the caller gets a
   * loud error. Export evaluates are deliberately NOT routed through this
   * (the export watchdog owns that ceiling).
   *
   * NB: Playwright serializes the function source — values cross the bridge
   * ONLY via `arg`, never via closures.
   */
  private async boundedEvaluate<R, A = undefined>(
    page: Page,
    fn: (arg: A) => Promise<R> | R,
    label: string,
    arg?: A,
  ): Promise<R> {
    const timeoutMs = this.options.pageOpTimeoutMs ?? DEFAULT_PAGE_OP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        // Playwright's Unboxed<Arg> generic cannot be satisfied for an
        // arbitrary A; the call sites keep full typing, so the cast is
        // contained to this one bridge line.
        page.evaluate(fn as never, arg as never) as Promise<R>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new PageOpTimeoutError(label, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof PageOpTimeoutError) {
        await this.recycle().catch(() => undefined);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---------------------------- probe ---------------------------- */

  /** Run the in-page probe. A sample path enables the real decode smoke. */
  async probeOnPage(sampleMediaPath?: string): Promise<{
    facts: PageProbeFacts;
    browserVersion: string;
    userAgent: string;
  }> {
    return this.withPageLock(async (page) => {
      if (sampleMediaPath !== undefined) {
        // Bounded by Playwright's default action timeout (not an evaluate).
        await page.locator(MEDIA_INPUT_SELECTOR).setInputFiles(sampleMediaPath);
      }
      const facts = (await this.boundedEvaluate(
        page,
        () =>
          (window as never as { __openreelRender: { probe(): Promise<PageProbeFacts> } }).__openreelRender.probe(),
        "probe",
        undefined,
      )) as PageProbeFacts;
      const userAgent = await this.boundedEvaluate(
        page,
        () => navigator.userAgent,
        "userAgent",
        undefined,
      );
      return {
        facts,
        browserVersion: this.browser?.version() ?? "unknown",
        userAgent,
      };
    });
  }

  /* --------------------------- hydrate --------------------------- */

  private async hydrateOnPage(
    page: Page,
    project: Project,
    mediaFiles: Readonly<Record<string, string>>,
  ): Promise<void> {
    const mediaIds = Object.keys(mediaFiles);
    const paths = mediaIds.map((id) => mediaFiles[id] as string);
    const projectJson = JSON.stringify(project);
    // setInputFiles is not a page evaluate (bounded by Playwright's own
    // default action timeout, not the page-op ceiling); the evaluate below
    // is the one boundedEvaluate covers.
    await page.locator(MEDIA_INPUT_SELECTOR).setInputFiles(paths);
    const report = (await this.boundedEvaluate(
      page,
      ({ projectJson: json, ids }: { projectJson: string; ids: string[] }) =>
        (window as never as {
          __openreelRender: {
            hydrate(
              projectJson: string,
              mediaIds: string[],
            ): Promise<{ ok: boolean; mediaMissing: string[]; error?: string }>;
          };
        }).__openreelRender.hydrate(json, ids),
      "hydrate",
      { projectJson, ids: mediaIds },
    )) as { ok: boolean; mediaMissing: string[]; error?: string };
    if (!report.ok) {
      throw new Error(
        `browser hydrate failed${report.error ? `: ${report.error}` : ""}${
          report.mediaMissing.length > 0
            ? ` (media not attached: ${report.mediaMissing.join(", ")})`
            : ""
        }`,
      );
    }
  }

  private async renderPngOnPage(
    page: Page,
    timeSec: number,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const base64 = await this.boundedEvaluate(
      page,
      ({ timeSec: t, width: w, height: h }: { timeSec: number; width: number; height: number }) =>
        (window as never as {
          __openreelRender: {
            renderPngBase64(t: number, w: number, h: number): Promise<string>;
          };
        }).__openreelRender.renderPngBase64(t, w, h),
      "renderPng",
      { timeSec, width, height },
    );
    return Buffer.from(base64, "base64");
  }

  /**
   * One atomic hydrated page session: hydrate from the canonical project,
   * then run `fn` with a render handle — all under the single page lock, so
   * no other operation can clobber the hydrated state mid-export. Long
   * exports hold the page for their whole duration; other previews/exports
   * simply queue behind (one browser, one page — documented contract).
   *
   * `cancelCheck` runs ONCE right after the lock is acquired (before any
   * hydrate work): an operation that was cancelled while it waited —
   * including while a recycle re-enqueued it — bails before producing
   * anything instead of running as a zombie behind an already-terminal job.
   */
  async withHydratedSession<T>(
    project: Project,
    mediaFiles: Readonly<Record<string, string>>,
    fn: (session: {
      renderPng(timeSec: number, width: number, height: number): Promise<Buffer>;
    }) => Promise<T>,
    options: { cancelCheck?: () => boolean } = {},
  ): Promise<T> {
    return this.withPageLock(async (page) => {
      if (options.cancelCheck?.() === true) {
        throw new HydratedSessionCancelled();
      }
      await this.hydrateOnPage(page, project, mediaFiles);
      return fn({
        renderPng: (timeSec, width, height) =>
          this.renderPngOnPage(page, timeSec, width, height),
      });
    });
  }

  /* ---------------------------- render ---------------------------- */

  /** Hydrate + render one composited frame atomically; returns PNG bytes. */
  async renderPng(
    project: Project,
    mediaFiles: Readonly<Record<string, string>>,
    timeSec: number,
    width: number,
    height: number,
  ): Promise<Buffer> {
    return this.withHydratedSession(project, mediaFiles, (session) =>
      session.renderPng(timeSec, width, height),
    );
  }

  /* --------------------- export: WebCodecs route --------------------- */

  private async ensureSinkBindings(page: Page): Promise<void> {
    if (this.sinkBindingsReady) return;
    await page.exposeFunction("__exportSeek", (position: number) =>
      this.sinkBridge?.seek(position),
    );
    await page.exposeFunction("__exportWrite", (base64: string) =>
      this.sinkBridge?.writeBase64(base64),
    );
    await page.exposeFunction("__exportClose", async () => {
      await this.sinkBridge?.finalize();
    });
    await page.exposeFunction("__exportAbort", () => this.sinkBridge?.discard());
    await page.exposeFunction("__exportProgress", (json: string) => {
      try {
        this.sinkBridge?.progress(JSON.parse(json) as ExportProgressJson);
      } catch {
        /* malformed progress must not kill the export */
      }
    });
    this.sinkBindingsReady = true;
  }

  /**
   * Run the in-page ExportEngine over the streaming shim: hydrate + encode
   * + mux atomically (holds the page lock for the whole export).
   * Cancellation arrives via abortInPageExport(), which deliberately
   * bypasses the lock — the export loop yields between frames.
   */
  async exportWebcodecsStreaming(
    project: Project,
    mediaFiles: Readonly<Record<string, string>>,
    settings: {
      width: number;
      height: number;
      frameRate: number;
      videoBitrateKbps: number;
    },
    writer: PartFileWriter,
    onProgress: (event: ExportProgressJson) => void,
    options: { cancelCheck?: () => boolean } = {},
  ): Promise<WebcodecsExportOutcome> {
    return this.withPageLock(async (page) => {
      if (options.cancelCheck?.() === true) {
        throw new HydratedSessionCancelled();
      }
      await this.hydrateOnPage(page, project, mediaFiles);
      await this.ensureSinkBindings(page);
      this.sinkBridge = {
        seek: (position) => writer.seek(position),
        writeBase64: (base64) => writer.writeBase64(base64),
        finalize: () => writer.finalize(),
        discard: () => writer.discard(),
        progress: onProgress,
      };
      try {
        return (await page.evaluate(
          (exportSettings) =>
            (window as never as {
              __openreelRender: {
                exportToMp4Webcodecs(s: typeof exportSettings): Promise<WebcodecsExportOutcome>;
              };
            }).__openreelRender.exportToMp4Webcodecs(exportSettings),
          settings,
        )) as WebcodecsExportOutcome;
      } finally {
        this.sinkBridge = null;
      }
    });
  }

  /**
   * Cooperative abort of the in-page export. NOT serialized: it must reach
   * the page while exportWebcodecsStreaming is still awaiting its evaluate
   * (the export loop yields between frames, letting this call through).
   */
  async abortInPageExport(): Promise<void> {
    const page = this.page;
    if (!page) return;
    await page
      .evaluate(() =>
        (window as never as {
          __openreelRender: { abortExport(): void };
        }).__openreelRender.abortExport(),
      )
      .catch(() => undefined);
  }
}
