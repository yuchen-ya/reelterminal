/**
 * media.render_html verb tests — headless session with a FAKE render
 * provider (no browser; the real-Chromium renderer has its own suite in
 * runtime-chromium). Covers: param validation, media-root containment for
 * source/assetsRoot/outputDir (media.import three-state wording), artifact
 * discipline (temp-then-publish, sha256, PNG magic/IHDR re-inspection),
 * idempotent replay/conflict, capability honesty, and default propagation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade } from "./index";
import type { RenderProvider, RenderHtmlPngRequest } from "./providers";

/** Minimal valid PNG with explicit dims (RGBA) — enough for IHDR checks. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBytes]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const at = y * (stride + 1) + 1 + x * 4;
      raw[at] = 200;
      raw[at + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface FakeProviderOptions {
  readonly bytes?: (request: RenderHtmlPngRequest) => Buffer;
  readonly preflightAvailable?: boolean;
}

function fakeProvider(options: FakeProviderOptions = {}): {
  provider: RenderProvider;
  requests: RenderHtmlPngRequest[];
} {
  const requests: RenderHtmlPngRequest[] = [];
  const provider: RenderProvider = {
    id: "fake-html-render",
    preflight: async () =>
      options.preflightAvailable === false
        ? { available: false, reason: "fake preflight failure" }
        : { available: true, details: { chromium: "fake" } },
    renderFramePng: async () => ({ bytesWritten: 0 }),
    renderHtmlPng: async (request) => {
      requests.push(request);
      const bytes = options.bytes
        ? options.bytes(request)
        : makePng(request.width, request.height);
      await writeFile(request.destPath, bytes);
      return {
        bytesWritten: bytes.length,
        missingAssets:
          request.source.kind === "inline" &&
          request.source.html.includes("missing.png")
            ? ["file:///fake/missing.png"]
            : [],
      };
    },
  };
  return { provider, requests };
}

describe("media.render_html", () => {
  let mediaRoot: string;
  let otherRoot: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "htmlrender-media-"));
    otherRoot = await mkdtemp(path.join(tmpdir(), "htmlrender-other-"));
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });

  function facadeWith(provider: RenderProvider | undefined, roots: string[] = [mediaRoot]) {
    return createAgentFacade({
      mediaRoots: roots,
      ...(provider ? { renderProvider: provider } : {}),
    });
  }

  const inline = (html: string) => ({ source: { kind: "inline", html } as const });

  it("renders inline HTML to the default jobs/html-render/<requestKey>/ dir", async () => {
    const { provider, requests } = fakeProvider();
    const facade = facadeWith(provider);
    const result = await facade["media.render_html"]({
      ...inline("<p>card</p>"),
      width: 320,
      height: 200,
      idempotencyKey: "k1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replayed).toBe(false);
    expect(result.value.width).toBe(320);
    expect(result.value.height).toBe(200);
    expect(result.value.missingAssets).toEqual([]);
    expect(result.value.path.startsWith(path.join(mediaRoot, "jobs", "html-render"))).toBe(true);
    expect(result.value.path.endsWith(".png")).toBe(true);
    expect(result.value.sha256).toMatch(/^[0-9a-f]{64}$/);
    const fileStat = await stat(result.value.path);
    expect(fileStat.isFile()).toBe(true);
    expect(result.value.bytes).toBe(fileStat.size);
    // Defaults reached the provider: transparent true, timeout 30000, no
    // assetsRoot for an inline source without one.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.transparent).toBe(true);
    expect(requests[0]?.timeoutMs).toBe(30_000);
    expect(requests[0]?.assetsRoot).toBeUndefined();
    // No project needed, no revision bump — the file write is the mutation.
  });

  it("renders a path-mode file and passes the source through contained", async () => {
    const { provider, requests } = fakeProvider();
    const htmlPath = path.join(mediaRoot, "card.html");
    await writeFile(htmlPath, "<html><body>card</body></html>");
    const facade = facadeWith(provider);
    const result = await facade["media.render_html"]({
      source: { kind: "path", path: htmlPath },
      width: 64,
      height: 64,
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.source).toEqual({ kind: "path", path: htmlPath });
    // The facade passes no assetsRoot for path mode; the RENDERER defaults
    // relative resolution to the HTML file's own directory (covered by the
    // runtime-chromium suite).
    expect(requests[0]?.assetsRoot).toBeUndefined();
  });

  it("propagates missingAssets from the provider", async () => {
    const { provider } = fakeProvider();
    const facade = facadeWith(provider);
    const result = await facade["media.render_html"]({
      ...inline('<img src="missing.png">'),
      width: 32,
      height: 32,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missingAssets).toEqual(["file:///fake/missing.png"]);
  });

  it("rejects path sources outside the media roots (three-state wording)", async () => {
    const { provider } = fakeProvider();
    const facade = facadeWith(provider);
    // A path that RESOLVES but lives in another root is a genuine escape.
    const outsideFile = path.join(otherRoot, "x.html");
    await writeFile(outsideFile, "<p>outside</p>");
    const outside = await facade["media.render_html"]({
      source: { kind: "path", path: outsideFile },
      width: 64,
      height: 64,
    });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error.code).toBe("INVALID_PARAMS");
    expect(outside.error.message).toContain("escapes the configured media roots");

    const missing = await facade["media.render_html"]({
      source: { kind: "path", path: path.join(mediaRoot, "nope.html") },
      width: 64,
      height: 64,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("INVALID_PARAMS");
    expect(missing.error.message).toContain("cannot be read");

    const url = await facade["media.render_html"]({
      source: { kind: "path", path: "https://cdn.example/x.html" },
      width: 64,
      height: 64,
    });
    expect(url.ok).toBe(false);
    if (url.ok) return;
    expect(url.error.code).toBe("INVALID_PARAMS");
    expect(url.error.message).toContain("URLs are not accepted");
  });

  it("rejects assetsRoot and outputDir outside the media roots", async () => {
    const { provider } = fakeProvider();
    const facade = facadeWith(provider);
    const badAssets = await facade["media.render_html"]({
      ...inline("<p>x</p>"),
      assetsRoot: otherRoot,
      width: 64,
      height: 64,
    });
    expect(badAssets.ok).toBe(false);
    if (badAssets.ok) return;
    expect(badAssets.error.message).toContain("assetsRoot escapes the configured media roots");

    const badOut = await facade["media.render_html"]({
      ...inline("<p>x</p>"),
      outputDir: otherRoot,
      width: 64,
      height: 64,
    });
    expect(badOut.ok).toBe(false);
    if (badOut.ok) return;
    expect(badOut.error.message).toContain("outputDir escapes the configured media roots");
  });

  it("fails UNSUPPORTED without a provider, without renderHtmlPng, or without roots", async () => {
    const noProvider = facadeWith(undefined);
    const r1 = await noProvider["media.render_html"]({ ...inline("<p>x</p>"), width: 8, height: 8 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("UNSUPPORTED");

    const { provider: plain } = { provider: fakeProvider().provider };
    const plainWithoutHtml: RenderProvider = { ...plain, renderHtmlPng: undefined };
    const r2 = await facadeWith(plainWithoutHtml)["media.render_html"]({
      ...inline("<p>x</p>"),
      width: 8,
      height: 8,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("UNSUPPORTED");

    const { provider: noRootsProvider } = fakeProvider();
    const r3 = await facadeWith(noRootsProvider, [])["media.render_html"]({
      ...inline("<p>x</p>"),
      width: 8,
      height: 8,
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe("UNSUPPORTED");
  });

  it("fails UNSUPPORTED when the provider preflight fails", async () => {
    const { provider } = fakeProvider({ preflightAvailable: false });
    const facade = facadeWith(provider);
    const result = await facade["media.render_html"]({ ...inline("<p>x</p>"), width: 8, height: 8 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED");
    expect(result.error.message).toContain("fake preflight failure");
  });

  it("re-inspects the produced PNG (dims and magic) and refuses liars", async () => {
    // Wrong IHDR dims (real PNG, 8x8, while the verb asked 16x16).
    const lyingDims = fakeProvider({ bytes: () => makePng(8, 8) });
    const r1 = await facadeWith(lyingDims.provider)["media.render_html"]({
      ...inline("<p>x</p>"),
      width: 16,
      height: 16,
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.code).toBe("JOB_FAILED");
    expect(r1.error.message).toContain("PNG re-inspection");

    // Not a PNG at all.
    const garbage = fakeProvider({ bytes: () => Buffer.from("not a png") });
    const r2 = await facadeWith(garbage.provider)["media.render_html"]({
      ...inline("<p>x</p>"),
      width: 16,
      height: 16,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe("JOB_FAILED");
  });

  it("replays the same idempotencyKey+payload and conflicts on payload changes", async () => {
    const { provider, requests } = fakeProvider();
    const facade = facadeWith(provider);
    const first = await facade["media.render_html"]({
      ...inline("<p>same</p>"),
      width: 64,
      height: 64,
      idempotencyKey: "k",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await facade["media.render_html"]({
      ...inline("<p>same</p>"),
      width: 64,
      height: 64,
      idempotencyKey: "k",
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.replayed).toBe(true);
      expect(second.value.path).toBe(first.value.path);
    }
    expect(requests).toHaveLength(1); // replay did not re-render

    const conflict = await facade["media.render_html"]({
      ...inline("<p>different</p>"),
      width: 64,
      height: 64,
      idempotencyKey: "k",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("CONFLICT");
    expect(conflict.error.message).toContain("different payload");
  });

  it("reports capability availability honestly", async () => {
    const withProvider = await facadeWith(fakeProvider().provider)["capabilities.get"]();
    expect(withProvider.ok).toBe(true);
    if (withProvider.ok) {
      expect(withProvider.value.mediaRenderHtml.available).toBe(true);
      expect(withProvider.value.mediaRenderHtml.details?.renderer).toContain("Chromium");
    }

    const withoutProvider = await facadeWith(undefined)["capabilities.get"]();
    expect(withoutProvider.ok).toBe(true);
    if (withoutProvider.ok) {
      expect(withoutProvider.value.mediaRenderHtml.available).toBe(false);
      expect(withoutProvider.value.mediaRenderHtml.requires).toContain("renderHtmlPng");
    }

    const plain = fakeProvider().provider;
    const withoutHtml = await facadeWith({ ...plain, renderHtmlPng: undefined })[
      "capabilities.get"
    ]();
    if (withoutHtml.ok) {
      expect(withoutHtml.value.mediaRenderHtml.available).toBe(false);
    }

    const withoutRoots = await facadeWith(fakeProvider().provider, [])[
      "capabilities.get"
    ]();
    if (withoutRoots.ok) {
      expect(withoutRoots.value.mediaRenderHtml.available).toBe(false);
      expect(withoutRoots.value.mediaRenderHtml.reason).toContain("media roots");
    }
  });

  it("registers the verb in the contract (49 tools) and validates params", async () => {
    const facade = facadeWith(fakeProvider().provider);
    const described = await facade["session.describe"]();
    expect(described.ok).toBe(true);
    if (described.ok) {
      expect(described.value.verbs).toContain("media.render_html");
      expect(described.value.verbs).toHaveLength(49);
    }
    const bad = await facade["media.render_html"]({
      ...inline("<p>x</p>"),
      width: 101, // odd — schema-valid superset, validator rejects
      height: 64,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("INVALID_PARAMS");
    const unknown = await facade["media.render_html"]({
      ...inline("<p>x</p>"),
      width: 64,
      height: 64,
      ...( { url: "https://nope" } as unknown as Record<string, never> ),
    });
    expect(unknown.ok).toBe(false);
  });

  it("publishes bytes that match the sha256 it reports", async () => {
    const { createHash } = await import("node:crypto");
    const { provider } = fakeProvider();
    const facade = facadeWith(provider);
    const result = await facade["media.render_html"]({
      ...inline("<p>hash</p>"),
      width: 48,
      height: 48,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = await readFile(result.value.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.value.sha256);
  });
});
