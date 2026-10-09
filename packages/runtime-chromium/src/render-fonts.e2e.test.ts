import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { Project } from "@reelterminal/core/types/project";
import { DEFAULT_TEXT_STYLE, DEFAULT_TEXT_TRANSFORM } from "@reelterminal/core/text/types";
import type { TextClip } from "@reelterminal/core/text/types";
import { ChromiumRuntime } from "./node/runtime";

interface PixelBounds {
  readonly width: number;
  readonly height: number;
}

function textBounds(png: Buffer): PixelBounds {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (data[8] !== 8 || channels === 0 || data[12] !== 0) throw new Error("Unsupported PNG shape");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += size + 12;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor] as number;
    cursor += 1;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] as number : 0;
      const above = previous ? previous[x] as number : 0;
      const upperLeft = previous && x >= channels ? previous[x - channels] as number : 0;
      const value = raw[cursor + x] as number;
      const predictor = filter === 1 ? left
        : filter === 2 ? above
          : filter === 3 ? Math.floor((left + above) / 2)
            : filter === 4 ? paeth(left, above, upperLeft)
              : 0;
      row[x] = (value + predictor) & 0xff;
    }
    cursor += stride;
  }

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * channels;
      if ((pixels[pixel] as number) + (pixels[pixel + 1] as number) + (pixels[pixel + 2] as number) < 90) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const runtime = new ChromiumRuntime();

function fixtureProject(renderFonts?: Project["renderFonts"]): Project {
  const clip: TextClip = {
    id: "font-fixture-text",
    trackId: "font-fixture-track",
    startTime: 0,
    duration: 1,
    text: "MWM",
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontFamily: "Fixture Render Font",
      fontSize: 56,
      fontWeight: 400,
      color: "#ffffff",
      strokeWidth: 0,
    },
    transform: DEFAULT_TEXT_TRANSFORM,
    keyframes: [],
  };
  return {
    id: "font-render-project",
    name: "Font render fixture",
    createdAt: 1,
    modifiedAt: 1,
    settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: {
      tracks: [{
        id: "font-fixture-track",
        type: "text",
        name: "Text",
        clips: [],
        transitions: [],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      }],
      subtitles: [],
      duration: 1,
      markers: [],
    },
    textClips: [clip],
    ...(renderFonts ? { renderFonts } : {}),
  };
}

describe("project render font hydration", () => {
  afterAll(async () => runtime.close());

  it("loads captured face geometry and clears it before rendering another project", async () => {
    const fontPath = fileURLToPath(new URL("../../../apps/web/public/fonts/N0bU2SZBIuF2PU_0DXR1C9zfmQ.woff2", import.meta.url));
    const fontBytes = await readFile(fontPath);
    const fallback = await runtime.renderPng(fixtureProject(), {}, 0.25, 320, 180);
    const withFont = await runtime.renderPng(fixtureProject([{
      family: "Fixture Render Font",
      style: "normal",
      weight: "400",
      unicodeRange: "U+0000-00FF",
      dataUrl: `data:font/woff2;base64,${fontBytes.toString("base64")}`,
    }]), {}, 0.25, 320, 180);
    const afterSwitch = await runtime.renderPng(fixtureProject(), {}, 0.25, 320, 180);

    const fallbackBounds = textBounds(fallback);
    const capturedBounds = textBounds(withFont);
    expect(capturedBounds.width).not.toBe(fallbackBounds.width);
    expect(capturedBounds.height).not.toBe(fallbackBounds.height);
    expect(afterSwitch).toEqual(fallback);
  });
});
