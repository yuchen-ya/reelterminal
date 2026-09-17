/**
 * Shared artifact core for the media.render_html verb.
 *
 * Both session flavors (headless AgentFacadeSession and the live desktop
 * facade) produce the SAME artifact through this module — identical
 * containment wording, output-dir convention, temp-then-publish discipline,
 * PNG re-inspection and request-keyed, content-addressed naming — so a
 * rendered HTML→PNG artifact is byte-for-byte the same contract in headless
 * and live mode. The sessions own only what differs: auth gate, param
 * validation, idempotency ledger.
 *
 * Containment model (mirrors media.import's three-state refusal):
 *  - the path-mode source must be a real file inside a configured media root;
 *  - assetsRoot (explicit, or defaulted to the source file's directory) must
 *    stay inside a media root — subresources can never be fetched from
 *    outside it (the renderer enforces this again at request time);
 *  - outputDir (explicit or the default `jobs/html-render/<requestKey>/`
 *    under the first root) must be a real directory inside a media root.
 *
 * Artifact discipline (same as preview.render_frame / visual.inspect):
 * prepareArtifactDir → provider renders to a pending temp path →
 * assertContainedWrittenFile → PNG magic/IHDR re-inspection →
 * publishArtifact (atomic link, never replaces) → sha256.
 */
import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { FacadeError } from "./errors";
import {
  assertContainedWrittenFile,
  prepareArtifactDir,
  sha256File,
} from "./artifact-io";
import {
  fingerprintFile,
  pendingArtifactPath,
  publishArtifact,
} from "./inspection-artifacts";
import { hasUrlScheme, resolveContainedPathDetailed } from "./media/path-roots";
import { readImageHeaderFacts } from "./media/image-probe";
import { stableStringify } from "./idempotency";
import type {
  HtmlRenderSource,
  RenderProvider,
} from "./providers";

/** Hard ceiling for one render's PNG output (dims are capped at 4096²). */
export const MAX_HTML_RENDER_PNG_BYTES = 16 * 1024 * 1024;

export interface MediaRenderHtmlCoreParams {
  readonly source: HtmlRenderSource;
  readonly assetsRoot?: string;
  readonly width: number;
  readonly height: number;
  readonly transparent?: boolean;
  readonly timeoutMs?: number;
  readonly outputDir?: string;
}

export interface MediaRenderHtmlArtifact {
  /** The VERIFIED published path (inside a media root). */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: number;
  /** Blocked/missing subresources, disclosed — never a silent blank. */
  readonly missingAssets: readonly string[];
}

export interface HtmlRenderVerbDeps {
  readonly provider: RenderProvider;
  readonly mediaRoots: readonly string[];
  readonly params: MediaRenderHtmlCoreParams;
}

const VERB = "media.render_html";

/**
 * Produce one HTML→PNG artifact under the session's media roots. All
 * rejections are coded FacadeErrors; wording follows the media.import
 * three-state convention (escapes / unreadable / URL).
 */
export async function produceHtmlRenderArtifact(
  deps: HtmlRenderVerbDeps,
): Promise<MediaRenderHtmlArtifact> {
  const { provider, mediaRoots, params } = deps;
  const roots = mediaRoots;
  if (roots.length === 0) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${VERB}: no media roots configured — the rendered PNG must be written inside a media root`,
    );
  }

  // ---- source containment (media.import three-state wording) ---------
  let sourceReal: string | null = null;
  if (params.source.kind === "path") {
    const rawPath = params.source.path;
    if (hasUrlScheme(rawPath)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: URLs are not accepted in this runtime — pass a local file path inside a configured media root`,
        { path: rawPath },
      );
    }
    const resolution = resolveContainedPathDetailed(rawPath, roots);
    if (resolution.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: path escapes the configured media roots`,
        { path: rawPath, mediaRoots: [...roots] },
      );
    }
    if (resolution.kind === "unresolvable") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: path cannot be read (not found or unreadable)`,
        { path: rawPath },
      );
    }
    const fileStat = await stat(resolution.path).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: path is not a regular file`,
        { path: rawPath },
      );
    }
    sourceReal = resolution.path;
  }

  // ---- assetsRoot containment ----------------------------------------
  let assetsRootReal: string | undefined;
  if (params.assetsRoot !== undefined) {
    const resolution = resolveContainedPathDetailed(params.assetsRoot, roots);
    if (resolution.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: assetsRoot escapes the configured media roots`,
        { assetsRoot: params.assetsRoot, mediaRoots: [...roots] },
      );
    }
    if (resolution.kind === "unresolvable") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: assetsRoot cannot be read (not found or unreadable)`,
        { assetsRoot: params.assetsRoot },
      );
    }
    const dirStat = await stat(resolution.path).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: assetsRoot is not a directory`,
        { assetsRoot: params.assetsRoot },
      );
    }
    assetsRootReal = resolution.path;
  }

  const transparent = params.transparent ?? true;
  const width = params.width;
  const height = params.height;

  // ---- content-addressed request key ---------------------------------
  // Keys exactly what shapes the rendered bytes: source content (path mode
  // adds the resolved real path and its size/mtime/sha256 fingerprint;
  // inline mode the markup digest), assetsRoot, size, transparency.
  // Identical inputs land on the same published path, so an idempotent
  // retry (or an equal concurrent request) reuses the artifact instead of
  // clobbering it; any input change lands elsewhere. Render-invariant knobs
  // (timeoutMs, outputDir) deliberately do not change the key — the
  // idempotency payload comparison below still sees them.
  const sourceFingerprint =
    params.source.kind === "path"
      ? await fingerprintFile(sourceReal ?? params.source.path)
      : {
          sizeBytes: Buffer.byteLength(params.source.html, "utf8"),
          mtimeMs: -1,
          sha256: createHash("sha256").update(params.source.html).digest("hex"),
        };
  const requestKey = createHash("sha256")
    .update(
      stableStringify({
        v: 1,
        kind: "html-render",
        source:
          sourceReal !== null
            ? { kind: "path", path: sourceReal, fingerprint: sourceFingerprint }
            : { kind: "inline", sha256: sourceFingerprint.sha256 },
        assetsRoot: assetsRootReal ?? null,
        width,
        height,
        transparent,
      }),
    )
    .digest("hex");

  // ---- output directory ----------------------------------------------
  let outputDir: string;
  let containingRoot: string;
  if (params.outputDir !== undefined) {
    const resolution = resolveContainedPathDetailed(params.outputDir, roots);
    if (resolution.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: outputDir escapes the configured media roots`,
        { outputDir: params.outputDir, mediaRoots: [...roots] },
      );
    }
    if (resolution.kind === "unresolvable") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${VERB}: outputDir cannot be read (not found or unreadable)`,
        { outputDir: params.outputDir },
      );
    }
    outputDir = resolution.path;
    containingRoot = containingRootOf(outputDir, roots);
  } else {
    containingRoot = resolvePath(roots[0] as string);
    outputDir = resolvePath(containingRoot, "jobs", "html-render", requestKey);
  }

  await prepareArtifactDir(outputDir, containingRoot, VERB);
  const stem = `html-${requestKey}-${width}x${height}`;
  const tempPath = pendingArtifactPath(outputDir, stem, "png");
  const finalPath = resolvePath(outputDir, `${stem}.png`);

  try {
    // Narrow once: kind "path" guarantees sourceReal was resolved (we threw
    // otherwise), "inline" carries the markup itself.
    const renderSource: HtmlRenderSource =
      params.source.kind === "path"
        ? { kind: "path", path: sourceReal ?? params.source.path }
        : { kind: "inline", html: params.source.html };
    const rendered = await provider.renderHtmlPng!({
      source: renderSource,
      ...(assetsRootReal !== undefined ? { assetsRoot: assetsRootReal } : {}),
      width,
      height,
      transparent,
      timeoutMs: params.timeoutMs ?? 30_000,
      destPath: tempPath,
    });
    // Post-write containment, then prove the bytes are the PNG we promised
    // (magic + IHDR dims straight from the file header — never trust the
    // provider's self-report).
    const verifiedTemp = await assertContainedWrittenFile(tempPath, containingRoot, VERB);
    let probe: Awaited<ReturnType<typeof readImageHeaderFacts>>;
    try {
      probe = await readImageHeaderFacts(verifiedTemp, rendered.bytesWritten);
    } catch (error) {
      // Non-image garbage from the provider is a job failure, not an
      // infrastructure error.
      throw new FacadeError(
        "JOB_FAILED",
        `${VERB}: rendered artifact failed PNG re-inspection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      probe.mimeType !== "image/png" ||
      probe.width !== width ||
      probe.height !== height
    ) {
      throw new FacadeError(
        "JOB_FAILED",
        `${VERB}: rendered artifact failed PNG re-inspection (got ${probe.mimeType} ${probe.width}x${probe.height}, expected image/png ${width}x${height})`,
      );
    }
    const published = await publishArtifact({
      tempPath: verifiedTemp,
      finalPath,
      artifactRoot: containingRoot,
      verb: VERB,
    });
    const publishedStat = await stat(published);
    if (publishedStat.size > MAX_HTML_RENDER_PNG_BYTES) {
      throw new FacadeError(
        "JOB_FAILED",
        `${VERB}: published PNG exceeds the ${MAX_HTML_RENDER_PNG_BYTES}-byte artifact budget`,
      );
    }
    return {
      path: published,
      width,
      height,
      sha256: await sha256File(published),
      bytes: publishedStat.size,
      missingAssets: rendered.missingAssets,
    };
  } catch (error) {
    // A failed attempt discards only its own temp file (a no-op when
    // publishArtifact already consumed it); never a published artifact.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The media root that contains `dir` (comparable-form prefix match). */
function containingRootOf(dir: string, roots: readonly string[]): string {
  const comparable = (p: string): string => {
    let out = p.replace(/[\\/]+/g, "/");
    if (out.length > 1 && out.endsWith("/")) out = out.replace(/\/+$/, "");
    return process.platform === "win32" ? out.toLowerCase() : out;
  };
  const comparableDir = comparable(dir);
  for (const root of roots) {
    const comparableRoot = comparable(root);
    if (
      comparableDir === comparableRoot ||
      comparableDir.startsWith(`${comparableRoot}/`)
    ) {
      return resolvePath(root);
    }
  }
  // resolveContainedPathDetailed already proved containment; unreachable.
  return resolvePath(roots[0] as string);
}
