/**
 * Constrained HTML/CSS → PNG renderer over the pool's real Chromium.
 *
 * This is the substrate behind the facade's media.render_html verb (and the
 * desktop wiring that reuses the same verb). It renders local markup into a
 * raster with a two-layer defense:
 *
 *  1. STRING GATE — every document (inline or file) passes the core
 *     html-policy (scripts, frames, event handlers, unsafe/external URL
 *     schemes… are rejected before a browser ever sees the markup).
 *  2. RUNTIME ALLOWLIST — the render runs in a throwaway incognito context
 *     with JavaScript disabled at the switch level, and a page.route
 *     wildcard allowlist that only ever lets through:
 *       - the entry document itself (file:// of the rendered HTML), and
 *       - file:// subresources whose realpath stays inside the assets root
 *         (relative traversal and symlink escapes both fail the realpath
 *         containment check),
 *       - data: URIs whose MIME is not a document/executor type.
 *     Everything else (http/https/ws/ftp/blob, file:// escapes) is aborted
 *     and recorded in missingAssets.
 *
 * The context is NEVER the shared preview/export hydrate page: an isolated
 * context cannot pollute project render state, and closing it is the cancel
 * primitive — the outer deadline closes the context, which rejects every
 * pending goto/screenshot immediately.
 *
 * Missing resources do not fail the render (the SVG ingest precedent:
 * a relative reference that cannot resolve degrades to blank pixels);
 * they are disclosed via missingAssets instead.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  assertValidHtmlContent,
  HtmlValidationError,
} from "@reelterminal/core/security/html-policy";

import type { ChromiumRuntime } from "./runtime";
import type {
  RenderedHtmlPngInfo,
  RenderHtmlPngRequest,
} from "@reelterminal/agent-facade";

export const HTML_RENDER_DEFAULT_TIMEOUT_MS = 30_000;
export const HTML_RENDER_MAX_TIMEOUT_MS = 120_000;
export const HTML_RENDER_MIN_TIMEOUT_MS = 1_000;
/** Raster ceiling (even dimensions, ≥2) — mirrors the facade verb bounds. */
export const HTML_RENDER_MAX_DIMENSION = 4096;

/** Grace between the load event and the screenshot (compositor settle). */
const HTML_RENDER_PAINT_SETTLE_MS = 250;
/** Two consecutive identical frames prove the raster settled; cap the loop. */
const HTML_RENDER_MAX_SETTLE_ROUNDS = 4;

/** Ceiling for reading one file-based HTML document before the policy runs. */
const HTML_FILE_READ_CEILING_BYTES = 8 * 1024 * 1024;

/** PNG signature; the renderer double-checks its own output before writing. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class HtmlRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlRenderError";
  }
}

export class HtmlRenderTimeoutError extends HtmlRenderError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`HTML render exceeded the ${timeoutMs}ms deadline — the render context was closed`);
    this.name = "HtmlRenderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function assertEvenDimension(value: number, label: string): void {
  if (
    !Number.isInteger(value) ||
    value < 2 ||
    value > HTML_RENDER_MAX_DIMENSION ||
    value % 2 !== 0
  ) {
    throw new HtmlRenderError(
      `${label} must be an even integer in [2, ${HTML_RENDER_MAX_DIMENSION}], got ${value}`,
    );
  }
}

/**
 * Normalized compare form of a path (mirrors the facade's containment
 * comparison: forward slashes, no trailing slash, lowercased on Windows).
 */
function comparablePath(p: string): string {
  let out = p.replace(/[\\/]+/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.replace(/\/+$/, "");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

function isContainedRealPath(candidateReal: string, rootReal: string): boolean {
  const candidate = comparablePath(candidateReal);
  const root = comparablePath(rootReal);
  return candidate === root || candidate.startsWith(`${root}/`);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** data: URIs are allowed unless the MIME is a document/executor type. */
function isAllowedDataUri(url: string): boolean {
  const mime = /^data:([^;,]*)/i.exec(url)?.[1]?.toLowerCase() ?? "";
  return !(
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "text/xml" ||
    mime === "application/xml" ||
    mime.endsWith("javascript")
  );
}

interface RequestVerdict {
  readonly allow: boolean;
  /** Set when the request is denied or failed to resolve (missingAssets). */
  readonly blockedReason?: string;
}

/** Chromium's automatic favicon fetch for file:// documents (housekeeping). */
function isFaviconRequestUrl(url: string): boolean {
  try {
    return /\/favicon(?:\.[a-z]+)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function classifyRequestUrl(
  url: string,
  entryReal: string,
  assetsRootReal: string | null,
): Promise<RequestVerdict> {
  if (url.startsWith("data:")) {
    return isAllowedDataUri(url)
      ? { allow: true }
      : { allow: false, blockedReason: "executable data: URI" };
  }
  if (url.startsWith("file://")) {
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return { allow: false, blockedReason: "malformed file URL" };
    }
    const real = await realpathOrNull(filePath);
    if (real === null) {
      return { allow: false, blockedReason: "not found" };
    }
    if (real === entryReal) return { allow: true };
    if (assetsRootReal !== null && isContainedRealPath(real, assetsRootReal)) {
      return { allow: true };
    }
    return { allow: false, blockedReason: "outside the assets root" };
  }
  // http/https/ws/ftp/blob/about and every exotic scheme: no network, ever.
  return { allow: false, blockedReason: "remote or unsupported scheme" };
}

/**
 * The renderer's error contract is HtmlRenderError; policy rejections keep
 * their coded message but surface under the renderer's type so callers can
 * match on one class.
 */
function assertPolicyAllows(html: string): void {
  try {
    assertValidHtmlContent(html);
  } catch (error) {
    if (error instanceof HtmlValidationError) {
      throw new HtmlRenderError(error.message);
    }
    throw error;
  }
}

export interface RenderHtmlPngOptions
  extends Omit<RenderHtmlPngRequest, "transparent" | "timeoutMs"> {
  readonly transparent?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Render one constrained HTML document and write the PNG to `destPath`.
 * See the module doc block for the defense model.
 */
export async function renderHtmlPng(
  runtime: ChromiumRuntime,
  request: RenderHtmlPngOptions,
): Promise<RenderedHtmlPngInfo> {
  const width = request.width;
  const height = request.height;
  assertEvenDimension(width, "width");
  assertEvenDimension(height, "height");
  const transparent = request.transparent ?? true;
  const timeoutMs = request.timeoutMs ?? HTML_RENDER_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < HTML_RENDER_MIN_TIMEOUT_MS ||
    timeoutMs > HTML_RENDER_MAX_TIMEOUT_MS
  ) {
    throw new HtmlRenderError(
      `timeoutMs must be an integer in [${HTML_RENDER_MIN_TIMEOUT_MS}, ${HTML_RENDER_MAX_TIMEOUT_MS}], got ${timeoutMs}`,
    );
  }

  // ---- content + entry file resolution ------------------------------
  let entryFile: string;
  let cleanupEntry: (() => Promise<void>) | null = null;
  try {
    let inlineHtml: string | null = null;
    if (request.source.kind === "inline") {
      const html = request.source.html;
      assertPolicyAllows(html);
      inlineHtml = html;
      // The inline document needs a file:// address for relative resources
      // to resolve; a throwaway temp dir OUTSIDE the media roots keeps the
      // agent workspace free of non-artifact files.
      const tempDir = await mkdtemp(path.join(tmpdir(), "openreel-html-render-"));
      entryFile = path.join(tempDir, `${randomUUID()}.html`);
      cleanupEntry = () => rm(tempDir, { recursive: true, force: true });
    } else {
      const sourcePath = request.source.path;
      const realEntry = await realpathOrNull(sourcePath);
      if (realEntry === null) {
        throw new HtmlRenderError(`HTML source file cannot be read: ${sourcePath}`);
      }
      const fileStat = await stat(realEntry);
      if (!fileStat.isFile()) {
        throw new HtmlRenderError(`HTML source is not a regular file: ${sourcePath}`);
      }
      if (fileStat.size > HTML_FILE_READ_CEILING_BYTES) {
        throw new HtmlRenderError(
          `HTML source exceeds the ${HTML_FILE_READ_CEILING_BYTES}-byte read ceiling`,
        );
      }
      const html = await readFile(realEntry, "utf8");
      assertPolicyAllows(html);
      entryFile = realEntry;
    }

    // ---- assets root -------------------------------------------------
    const assetsRootReal =
      request.assetsRoot !== undefined
        ? await realpathOrNull(request.assetsRoot)
        : // Path mode defaults to the HTML file's own directory (where the
          // browser already resolves relative references).
          request.source.kind === "path"
          ? path.dirname(entryFile)
          : null;
    if (request.assetsRoot !== undefined && assetsRootReal === null) {
      throw new HtmlRenderError(`assets root cannot be read: ${request.assetsRoot}`);
    }
    if (assetsRootReal !== null && !(await stat(assetsRootReal)).isDirectory()) {
      throw new HtmlRenderError(`assets root is not a directory: ${assetsRootReal}`);
    }

    // Inline documents resolve relative references against the TEMP entry
    // file, so the renderer injects a <base href> pointing at the assets
    // root (with a trailing slash — required for child-relative URLs).
    // Caller-supplied <base> stays rejected by the policy; this injected one
    // is renderer-owned and can only ever point at assetsRoot.
    if (inlineHtml !== null && assetsRootReal !== null) {
      const baseHref = String(pathToFileURL(`${assetsRootReal}${path.sep}`));
      const baseTag = `<base href="${baseHref}">`;
      inlineHtml = /<head[^>]*>/i.test(inlineHtml)
        ? inlineHtml.replace(/<head[^>]*>/i, (match) => `${match}${baseTag}`)
        : `${baseTag}${inlineHtml}`;
      await writeFile(entryFile, inlineHtml, "utf8");
    } else if (inlineHtml !== null) {
      await writeFile(entryFile, inlineHtml, "utf8");
    }

    return await renderViaContext(runtime, {
      entryFile,
      assetsRootReal,
      width,
      height,
      transparent,
      timeoutMs,
      destPath: request.destPath,
    });
  } finally {
    if (cleanupEntry) await cleanupEntry().catch(() => undefined);
  }
}

async function renderViaContext(
  runtime: ChromiumRuntime,
  plan: {
    readonly entryFile: string;
    readonly assetsRootReal: string | null;
    readonly width: number;
    readonly height: number;
    readonly transparent: boolean;
    readonly timeoutMs: number;
    readonly destPath: string;
  },
): Promise<RenderedHtmlPngInfo> {
  const entryReal = await realpath(plan.entryFile);
  const entryUrl = String(pathToFileURL(entryReal));
  const missingAssets: string[] = [];
  const seenBlocked = new Set<string>();

  const work = runtime.withIsolatedContext(
    { javaScriptEnabled: false, viewport: { width: plan.width, height: plan.height } },
    async (context) => {
      // Outer deadline: closing the context rejects every pending
      // goto/screenshot — this close IS the cancellation primitive. The
      // losing branch of the race is cleaned up by withIsolatedContext's
      // own close (idempotent).
      const deadline = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          void context.close().catch(() => undefined);
          reject(new HtmlRenderTimeoutError(plan.timeoutMs));
        }, plan.timeoutMs);
        // Do not hold the process open on an already-settled render.
        timer.unref?.();
      });

      const render = (async () => {
        const page = await context.newPage();
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          const verdict = await classifyRequestUrl(url, entryReal, plan.assetsRootReal);
          if (verdict.allow) {
            await route.continue();
            return;
          }
          // Chromium fetches /favicon.ico on its own for file:// documents;
          // that head-housekeeping request is aborted silently instead of
          // polluting the caller's missing-assets disclosure.
          if (!isFaviconRequestUrl(url) && verdict.blockedReason && !seenBlocked.has(url)) {
            seenBlocked.add(url);
            missingAssets.push(url);
          }
          await route.abort().catch(() => undefined);
        });
        try {
          await page.goto(entryUrl, {
            waitUntil: "load",
            timeout: plan.timeoutMs,
          });
          // The load event fires when resources are fetched, not when the
          // compositor has produced its first contentful frame (a cold
          // browser can lag the load event by hundreds of ms). Wait one
          // paint beat FIRST (two consecutive blank frames would otherwise
          // look "stable"), then screenshot into stability: two identical
          // frames mean the raster settled. The cap keeps animated content
          // moving instead of waiting forever (animations are not this
          // verb's target).
          await page.waitForTimeout(HTML_RENDER_PAINT_SETTLE_MS);
          let png = await page.screenshot({
            omitBackground: plan.transparent,
            type: "png",
            clip: { x: 0, y: 0, width: plan.width, height: plan.height },
          });
          for (let settle = 0; settle < HTML_RENDER_MAX_SETTLE_ROUNDS; settle++) {
            await page.waitForTimeout(HTML_RENDER_PAINT_SETTLE_MS);
            const next = await page.screenshot({
              omitBackground: plan.transparent,
              type: "png",
              clip: { x: 0, y: 0, width: plan.width, height: plan.height },
            });
            const stable = next.equals(png);
            png = next;
            if (stable) break;
          }
          return png;
        } finally {
          await page.close().catch(() => undefined);
        }
      })();

      return Promise.race([render, deadline]);
    },
  );

  const png = await work;
  if (!png || png.length === 0) {
    throw new HtmlRenderError("Chromium returned an empty PNG");
  }
  // Never write a success-looking file that is not a PNG.
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new HtmlRenderError("Chromium returned bytes that are not a PNG image");
  }
  await writeFile(plan.destPath, png);
  return { bytesWritten: png.length, missingAssets };
}
