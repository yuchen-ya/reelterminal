/**
 * Constrained HTML→PNG renderer tests over REAL headless Chromium (the
 * runtime-chromium convention: browser-backed behavior is tested against a
 * real browser, not a mock). Covers:
 *   - transparent-background alpha + opaque mode (real pixel decode),
 *   - raster bounds / timeout bounds validation (no browser needed),
 *   - policy rejections before any browser work,
 *   - missing/remote/out-of-root assets → aborted requests recorded in
 *     missingAssets while the render still succeeds,
 *   - in-root relative assets actually render (pixel check),
 *   - PNG signature/IHDR discipline on the written file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HTML_RENDER_MAX_DIMENSION,
  HtmlRenderError,
  renderHtmlPng,
} from "./html-render";
import { ChromiumRuntime } from "./runtime";

/* --------------------------- PNG decoding --------------------------- */

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  /** Raw RGBA bytes, filters undone. */
  readonly rgba: Buffer;
}

/**
 * Minimal PNG decoder for the 8-bit non-interlaced RGB/RGBA images
 * Playwright's screenshot produces: enough to assert real pixels (alpha!)
 * and IHDR dimensions without pulling an image dependency.
 */
function decodePng(bytes: Buffer): DecodedPng {
  expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // bit depth
      colorType = data[9];
      expect(data[12]).toBe(0); // no interlace
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  expect(colorType === 6 || colorType === 2).toBe(true);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((stride + 1) * height);
  const rgba = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(current, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const bpp = channels;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? current[x - bpp] : 0;
      const up = previous[x];
      const upLeft = x >= bpp ? previous[x - bpp] : 0;
      let value = current[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const readAt = x * channels;
      const writeAt = (y * width + x) * 4;
      rgba[writeAt] = current[readAt];
      rgba[writeAt + 1] = current[readAt + 1];
      rgba[writeAt + 2] = current[readAt + 2];
      rgba[writeAt + 3] = channels === 4 ? current[readAt + 3] : 255;
    }
    current.copy(previous);
  }
  return { width, height, colorType, rgba };
}

/* ------------------------------ harness ----------------------------- */

describe("html render (real Chromium)", () => {
  let workDir: string;
  let assetsDir: string;
  let runtime: ChromiumRuntime;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "html-render-test-"));
    assetsDir = path.join(workDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    runtime = new ChromiumRuntime();
  });

  afterEach(async () => {
    await runtime.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const destPath = () => path.join(workDir, "out.png");

  /* --------------------- parameter validation --------------------- */

  it("rejects odd, sub-2 and over-ceiling dimensions without touching a browser", async () => {
    const html = "<p>x</p>";
    for (const bad of [101, 1, 0, HTML_RENDER_MAX_DIMENSION + 2, -4]) {
      await expect(
        renderHtmlPng(runtime, {
          source: { kind: "inline", html },
          width: bad,
          height: 64,
          destPath: destPath(),
        }),
      ).rejects.toBeInstanceOf(HtmlRenderError);
    }
  });

  it("rejects out-of-range timeouts", async () => {
    for (const bad of [0, 500, 121_000, 10.5]) {
      await expect(
        renderHtmlPng(runtime, {
          source: { kind: "inline", html: "<p>x</p>" },
          width: 64,
          height: 64,
          timeoutMs: bad as unknown as number,
          destPath: destPath(),
        }),
      ).rejects.toBeInstanceOf(HtmlRenderError);
    }
  });

  it("rejects policy-violating markup before any browser work", async () => {
    await expect(
      renderHtmlPng(runtime, {
        source: { kind: "inline", html: '<script>alert(1)</script><p>x</p>' },
        width: 64,
        height: 64,
        destPath: destPath(),
      }),
    ).rejects.toBeInstanceOf(HtmlRenderError);
    await expect(
      renderHtmlPng(runtime, {
        source: { kind: "inline", html: '<img src="https://cdn.example/x.png">' },
        width: 64,
        height: 64,
        destPath: destPath(),
      }),
    ).rejects.toBeInstanceOf(HtmlRenderError);
    await expect(
      renderHtmlPng(runtime, {
        source: { kind: "path", path: path.join(workDir, "does-not-exist.html") },
        width: 64,
        height: 64,
        destPath: destPath(),
      }),
    ).rejects.toBeInstanceOf(HtmlRenderError);
  });

  /* --------------------------- rendering --------------------------- */

  it("renders transparent and opaque backgrounds with real alpha", async () => {
    // A 32x32 red tile on a 64x64 canvas: the corners expose the page
    // background, so omitBackground is observable.
    const html = '<html><body style="margin:0"><div style="width:32px;height:32px;background:rgb(255,0,0)"></div></body></html>';
    const transparentPath = destPath();
    const transparent = await renderHtmlPng(runtime, {
      source: { kind: "inline", html },
      width: 64,
      height: 64,
      transparent: true,
      destPath: transparentPath,
    });
    expect(transparent.missingAssets).toEqual([]);
    const transparentPng = decodePng(await readFile(transparentPath));
    expect([transparentPng.width, transparentPng.height]).toEqual([64, 64]);
    const at = (x: number, y: number) => {
      const i = (y * 64 + x) * 4;
      return [transparentPng.rgba[i], transparentPng.rgba[i + 1], transparentPng.rgba[i + 2], transparentPng.rgba[i + 3]];
    };
    expect(at(8, 8)).toEqual([255, 0, 0, 255]);
    expect(at(48, 48)[3]).toBe(0);

    const opaquePath = path.join(workDir, "opaque.png");
    await renderHtmlPng(runtime, {
      source: { kind: "inline", html },
      width: 64,
      height: 64,
      transparent: false,
      destPath: opaquePath,
    });
    const opaquePng = decodePng(await readFile(opaquePath));
    const opaqueCorner = opaquePng.rgba[3];
    expect(opaqueCorner).toBe(255);
  }, 120_000);

  it("renders even dimensions up to the ceiling and reports the written bytes", async () => {
    const outPath = destPath();
    const info = await renderHtmlPng(runtime, {
      source: { kind: "inline", html: '<html><body style="margin:0;background:rgb(0,0,255)"></body></html>' },
      width: 32,
      height: 16,
      transparent: false,
      destPath: outPath,
    });
    const fileStat = await stat(outPath);
    expect(info.bytesWritten).toBe(fileStat.size);
    const png = decodePng(await readFile(outPath));
    expect([png.width, png.height]).toEqual([32, 16]);
    expect(png.rgba[0]).toBe(0);
    expect(png.rgba[2]).toBe(255);
  }, 120_000);

  it("keeps relative in-root assets rendering and records missing ones", async () => {
    await writeFile(path.join(assetsDir, "dot.png"), await tinyPng(255, 0, 0));
    // NOTE: remote http(s) references never reach the renderer — the core
    // string policy rejects them (covered by the rejection test above and
    // the core html-policy suite). The runtime allowlist backstop below is
    // for what the string gate legitimately lets through: relative paths.
    const html = [
      '<html><head><style>body{margin:0}img{width:16px;height:16px;display:block}</style></head><body>',
      `<img src="dot.png">`,
      `<img src="missing.png">`,
      "</body></html>",
    ].join("");
    const outPath = destPath();
    const info = await renderHtmlPng(runtime, {
      source: { kind: "inline", html },
      assetsRoot: assetsDir,
      width: 16,
      height: 32,
      transparent: true,
      destPath: outPath,
    });
    // The render SUCCEEDS; blocked/missing subresources are disclosed.
    expect(info.missingAssets.some((entry: string) => entry.includes("missing.png"))).toBe(true);
    expect(info.missingAssets.length).toBe(1);
    const png = decodePng(await readFile(outPath));
    // The in-root dot.png rendered (top pixel red); the missing ones left
    // transparent pixels below.
    const at = (x: number, y: number) => {
      const i = (y * 16 + x) * 4;
      return [png.rgba[i], png.rgba[i + 1], png.rgba[i + 2], png.rgba[i + 3]];
    };
    expect(at(8, 8)).toEqual([255, 0, 0, 255]);
    expect(at(8, 24)[3]).toBe(0);
  }, 120_000);

  it("blocks subresources that escape the assets root (../ traversal and symlink escapes)", async () => {
    await writeFile(path.join(workDir, "secret.png"), await tinyPng(0, 255, 0));
    // link.png → ../secret.png escapes the root through a symlink. When the
    // filesystem refuses symlinks (Windows without the privilege), the
    // placeholder is removed instead and the same URL takes the not-found
    // branch — either way the request must be blocked and disclosed.
    try {
      await symlink(path.join(workDir, "secret.png"), path.join(assetsDir, "link.png"));
    } catch {
      // no symlink privilege: link.png stays absent
    }
    const html = [
      '<html><head><style>body{margin:0}img{width:16px;height:16px;display:block}</style></head><body>',
      '<img src="../secret.png">',
      '<img src="link.png">',
      "</body></html>",
    ].join("");
    const info = await renderHtmlPng(runtime, {
      source: { kind: "inline", html },
      assetsRoot: assetsDir,
      width: 16,
      height: 32,
      transparent: true,
      destPath: destPath(),
    });
    expect(info.missingAssets.some((entry: string) => entry.includes("secret.png"))).toBe(true);
    expect(info.missingAssets.some((entry: string) => entry.includes("link.png"))).toBe(true);
    const png = decodePng(await readFile(destPath()));
    // NOT the secret's green: every escaped pixel stays blank.
    const at = (x: number, y: number) => {
      const i = (y * 16 + x) * 4;
      return [png.rgba[i], png.rgba[i + 1], png.rgba[i + 2], png.rgba[i + 3]];
    };
    expect(at(8, 0)).toEqual([0, 0, 0, 0]);
    expect(at(8, 16)).toEqual([0, 0, 0, 0]);
  }, 120_000);

  it("path mode renders a file and defaults the assets root to its directory", async () => {
    await writeFile(path.join(workDir, "page.html"), [
      '<html><head><style>body{margin:0}</style></head><body>',
      '<div style="width:16px;height:16px;background:rgb(0,128,0)"></div>',
      "</body></html>",
    ].join(""));
    const outPath = destPath();
    await renderHtmlPng(runtime, {
      source: { kind: "path", path: path.join(workDir, "page.html") },
      width: 16,
      height: 16,
      transparent: false,
      destPath: outPath,
    });
    const png = decodePng(await readFile(outPath));
    expect(png.rgba[1]).toBe(128);
  }, 120_000);

  it("deadline mechanism: closing the context rejects pending page work", async () => {
    // The renderer's cancellation primitive is context.close() rejecting
    // every pending page operation (a deterministic mid-render hang cannot
    // be manufactured portably: the string policy removes every remote
    // stall, and local file fetches always settle). This pins the primitive
    // itself over a REAL context.
    let sawRejection: unknown = null;
    await runtime.withIsolatedContext({ javaScriptEnabled: false }, async (context) => {
      const page = await context.newPage();
      const pending = page
        .waitForSelector("#never-arrives", { state: "attached", timeout: 30_000 })
        .catch((error) => {
          sawRejection = error;
          return null;
        });
      await context.close();
      await pending;
    });
    expect(String(sawRejection)).toContain("closed");
  }, 60_000);

  it("a 1s deadline does not false-fire on a small render", async () => {
    const outPath = destPath();
    const info = await renderHtmlPng(runtime, {
      source: { kind: "inline", html: "<p>fast</p>" },
      width: 8,
      height: 8,
      timeoutMs: 1_000,
      destPath: outPath,
    });
    expect(info.bytesWritten).toBeGreaterThan(0);
    expect(info.missingAssets).toEqual([]);
  }, 60_000);

  it("writes a real PNG file (signature + IHDR discipline)", async () => {
    const outPath = destPath();
    await renderHtmlPng(runtime, {
      source: { kind: "inline", html: "<p>png check</p>" },
      width: 8,
      height: 8,
      destPath: outPath,
    });
    const bytes = await readFile(outPath);
    expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    // IHDR: width/height big-endian at offsets 16/20.
    expect(bytes.readUInt32BE(16)).toBe(8);
    expect(bytes.readUInt32BE(20)).toBe(8);
  }, 120_000);
});

/* --------------------------- tiny PNG writer -------------------------- */

/** Builds a 1x1 solid-color PNG via Node's zlib (no image dependency). */
async function tinyPng(r: number, g: number, b: number): Promise<Buffer> {
  const { deflateSync } = await import("node:zlib");
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = (() => {
      const table: number[] = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      return table;
    })();
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBytes]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.from([0, r, g, b]); // filter 0 + one RGB pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
