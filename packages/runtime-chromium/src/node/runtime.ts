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
    this.bytesWritten += buffer.length;
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

  constructor(options: ChromiumRuntimeOptions = {}) {
    this.options = options;
  }

  /* --------------------------- lifecycle --------------------------- */

  private async ensurePage(): Promise<Page> {
    if (this.closed) throw new Error("ChromiumRuntime is closed");
    this.launchPromise ??= this.launch();
    return this.launchPromise;
  }

  private async launch(): Promise<Page> {
    const browser = await chromium.launch({
      headless: this.options.headless ?? true,
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
    this.browser = browser;

    // WebCodecs (VideoDecoder/VideoEncoder) is gated on a secure context;
    // about:blank/setContent is NOT one, but 127.0.0.1 is. Serve the harness
    // page + bundle from a loopback-only server on an ephemeral port.
    const bundle = await buildBrowserEntry();
    const server = createServer((req, res) => {
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
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const { port } = server.address() as AddressInfo;

    const page = await browser.newPage();
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
  }

  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    const server = this.server;
    this.browser = null;
    this.page = null;
    this.server = null;
    this.launchPromise = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  /** Serialize page operations; exports hold the lock for their duration. */
  private async withPageLock<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const run = this.mutex.then(async () => fn(await this.ensurePage()));
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
        await page.locator(MEDIA_INPUT_SELECTOR).setInputFiles(sampleMediaPath);
      }
      const facts = (await page.evaluate(() =>
        (window as never as { __openreelRender: { probe(): Promise<PageProbeFacts> } }).__openreelRender.probe(),
      )) as PageProbeFacts;
      const userAgent = await page.evaluate(() => navigator.userAgent);
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
    await page.locator(MEDIA_INPUT_SELECTOR).setInputFiles(paths);
    const report = await page.evaluate(
      ({ projectJson: json, ids }) =>
        (window as never as {
          __openreelRender: {
            hydrate(
              projectJson: string,
              mediaIds: string[],
            ): Promise<{ ok: boolean; mediaMissing: string[]; error?: string }>;
          };
        }).__openreelRender.hydrate(json, ids),
      { projectJson, ids: mediaIds },
    );
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
    const base64 = await page.evaluate(
      ({ timeSec: t, width: w, height: h }) =>
        (window as never as {
          __openreelRender: {
            renderPngBase64(t: number, w: number, h: number): Promise<string>;
          };
        }).__openreelRender.renderPngBase64(t, w, h),
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
   */
  async withHydratedSession<T>(
    project: Project,
    mediaFiles: Readonly<Record<string, string>>,
    fn: (session: {
      renderPng(timeSec: number, width: number, height: number): Promise<Buffer>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.withPageLock(async (page) => {
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
  ): Promise<WebcodecsExportOutcome> {
    return this.withPageLock(async (page) => {
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
