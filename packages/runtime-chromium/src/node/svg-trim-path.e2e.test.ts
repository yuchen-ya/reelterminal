import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade } from "@reelterminal/agent-facade";

import { createChromiumProviders, type ChromiumProviders } from "./providers";

function decodeWhiteStroke(pngBytes: Buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (offset + 8 <= pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset);
    const type = pngBytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = pngBytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  expect([2, 6]).toContain(colorType);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((stride + 1) * height);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let whiteCount = 0;
  const whitePixels: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    expect(filter).toBeLessThanOrEqual(4);
    raw.copy(current, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let val = current[x]!;
      if (filter === 1) val += left;
      else if (filter === 2) val += up;
      else if (filter === 3) val += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        val += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[x] = val & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const at = x * channels;
      if (current[at]! > 200 && current[at + 1]! > 200 && current[at + 2]! > 200 && (channels === 3 || current[at + 3]! > 200)) {
        whiteCount++;
        whitePixels.push({ x, y });
      }
    }
    current.copy(previous);
  }
  return { count: whiteCount, pixels: whitePixels };
}

function countWhiteStrokePixels(pngBytes: Buffer): number {
  return decodeWhiteStroke(pngBytes).count;
}

describe("SVG trimPath rendering via preview.render_frame (real Chromium)", () => {
  const providers: ChromiumProviders = createChromiumProviders({ headless: true });
  let artifactRoot: string;

  beforeEach(async () => {
    artifactRoot = await mkdtemp(path.join(tmpdir(), "svg-trimpath-"));
  });

  afterEach(async () => {
    await rm(artifactRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await providers.close().catch(() => undefined);
  });

  it("grows SVG stroke pixels monotonically across 0%, 50%, 100% via trimPathEnd keyframes", async () => {
    const facade = createAgentFacade({
      artifactRoot,
      renderProvider: providers.renderProvider,
    });
    const proj = await facade["project.create"]({
      name: "trim-e2e",
      settings: { width: 320, height: 180 },
    });
    expect(proj.ok).toBe(true);
    const created = await facade["edit.apply"]({
      ops: [
        {
          op: "svg.create",
          svgContent:
            '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"><path d="M 10 50 L 190 50" stroke="#ffffff" stroke-width="12" fill="none"/></svg>',
          startTime: 0,
          duration: 1.5,
          keyframes: [
            { property: "trimPathEnd", time: 0, value: 0, easing: "linear" },
            { property: "trimPathEnd", time: 1.0, value: 1, easing: "linear" },
          ],
        },
      ],
    });
    expect(created.ok).toBe(true);

    const f0 = await facade["preview.render_frame"]({ timeSec: 0.0, width: 320, height: 180 });
    const fMid = await facade["preview.render_frame"]({ timeSec: 0.5, width: 320, height: 180 });
    const fFull = await facade["preview.render_frame"]({ timeSec: 1.0, width: 320, height: 180 });
    expect(f0.ok && fMid.ok && fFull.ok).toBe(true);
    if (!f0.ok || !fMid.ok || !fFull.ok) return;

    const px0 = countWhiteStrokePixels(await readFile(f0.value.artifact.path));
    const pxMid = countWhiteStrokePixels(await readFile(fMid.value.artifact.path));
    const pxFull = countWhiteStrokePixels(await readFile(fFull.value.artifact.path));

    expect(px0).toBe(0);
    expect(pxMid).toBeGreaterThan(200);
    expect(pxMid / pxFull).toBeCloseTo(0.5, 1);
    const reset = await facade["edit.apply"]({ ops: [{ op: "clip.setKeyframes", clipId: created.ok ? created.value.applied[0]!.createdIds.at(-1)! : "", keyframes: [] }] });
    expect(reset.ok).toBe(true);
    const reference = await facade["preview.render_frame"]({ timeSec: 1, width: 320, height: 180 });
    expect(reference.ok).toBe(true);
    if (!reference.ok) throw new Error(reference.error.message);
    // Full trim must recover the original solid path, including both endpoints.
    expect(decodeWhiteStroke(await readFile(fFull.value.artifact.path))).toEqual(decodeWhiteStroke(await readFile(reference.value.artifact.path)));
  }, 60_000);

  it("grows SVG stroke monotonically via entryAnimation: { type: 'draw' }", async () => {
    const facade = createAgentFacade({
      artifactRoot,
      renderProvider: providers.renderProvider,
    });
    const proj = await facade["project.create"]({
      name: "draw-e2e",
      settings: { width: 320, height: 180 },
    });
    expect(proj.ok).toBe(true);
    const created = await facade["edit.apply"]({
      ops: [
        {
          op: "svg.create",
          svgContent:
            '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"><path d="M 10 50 L 190 50" stroke="#ffffff" stroke-width="12" fill="none"/></svg>',
          startTime: 0,
          duration: 2.0,
          entryAnimation: { type: "draw", duration: 1.0, easing: "linear" },
        },
      ],
    });
    expect(created.ok).toBe(true);

    const f0 = await facade["preview.render_frame"]({ timeSec: 0.0, width: 320, height: 180 });
    const fMid = await facade["preview.render_frame"]({ timeSec: 0.5, width: 320, height: 180 });
    const fFull = await facade["preview.render_frame"]({ timeSec: 1.2, width: 320, height: 180 });
    expect(f0.ok && fMid.ok && fFull.ok).toBe(true);
    if (!f0.ok || !fMid.ok || !fFull.ok) return;

    const px0 = countWhiteStrokePixels(await readFile(f0.value.artifact.path));
    const pxMid = countWhiteStrokePixels(await readFile(fMid.value.artifact.path));
    const pxFull = countWhiteStrokePixels(await readFile(fFull.value.artifact.path));

    expect(px0).toBe(0);
    expect(pxMid).toBeGreaterThan(200);
    expect(pxMid / pxFull).toBeCloseTo(0.5, 1);
  }, 60_000);

  it("renders middle segments, wrapped offsets, empty ranges and full paths at their actual positions", async () => {
    const facade = createAgentFacade({ artifactRoot, renderProvider: providers.renderProvider });
    expect((await facade["project.create"]({ name: "trim-windows", settings: { width: 320, height: 180 } })).ok).toBe(true);
    const created = await facade["edit.apply"]({ ops: [{
      op: "svg.create", startTime: 0, duration: 2,
      svgContent: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path d="M 10 50 L 190 50" stroke="white" stroke-width="12" stroke-linecap="round" fill="none"/></svg>',
    }] });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const overlayId = created.value.applied[0]!.createdIds.at(-1)!;
    async function render() {
      const frame = await facade["preview.render_frame"]({ timeSec: 0.5, width: 320, height: 180 });
      if (!frame.ok) throw new Error(frame.error.message);
      return decodeWhiteStroke(await readFile(frame.value.artifact.path));
    }
    const full = await render();
    expect(full.count).toBeGreaterThan(1000);
    const minX = Math.min(...full.pixels.map(p => p.x));
    const maxX = Math.max(...full.pixels.map(p => p.x));
    for (const [start, end, offset, visibleQuarters] of [
      [0.25, 0.75, 0, [false, true, true, false]],
      [0, 0.5, 0.75, [true, false, false, true]],
      [0.8, 0.2, 0, [false, false, false, false]],
      [0, 0, 0, [false, false, false, false]],
      [0, 1, 1, [true, true, true, true]],
    ] as const) {
      const update = await facade["edit.apply"]({ ops: [{ op: "svg.update", overlayId, trimPathStart: start, trimPathEnd: end, trimPathOffset: offset }] });
      expect(update.ok).toBe(true);
      const image = await render();
      if (start >= end) expect(image.count).toBe(0); // round caps must leave no dot
      else if (end - start === 1) expect(image).toEqual(full);
      else {
        // Wrapped windows have extra round caps; verify location below rather
        // than assuming their pixel area is exactly half the original stroke.
        expect(image.count).toBeGreaterThan(0);
        expect(image.count).toBeLessThan(full.count);
      }
      for (const [quarter, visible] of visibleQuarters.entries()) {
        const x = Math.round(minX + (maxX - minX) * (quarter + 0.5) / 4);
        expect(image.pixels.some(p => p.x === x), `range ${start}..${end}, offset ${offset}, quarter ${quarter}`).toBe(visible);
      }
    }
  }, 60_000);

  it("seeks draw entry and exit in clip-local time, including repeated out-of-order renders", async () => {
    const facade = createAgentFacade({ artifactRoot, renderProvider: providers.renderProvider });
    expect((await facade["project.create"]({ name: "draw-local", settings: { width: 320, height: 180 } })).ok).toBe(true);
    expect((await facade["edit.apply"]({ ops: [{
      op: "svg.create", startTime: 2, duration: 3,
      svgContent: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path d="M 10 50 L 190 50" stroke="white" stroke-width="12" fill="none"/></svg>',
      entryAnimation: { type: "draw", duration: 1, easing: "linear" },
      exitAnimation: { type: "draw", duration: 1, easing: "linear" },
    }] })).ok).toBe(true);
    const counts: number[] = [];
    for (const timeSec of [3.5, 2, 2.5, 4, 4.5, 4.9, 2.5]) {
      const frame = await facade["preview.render_frame"]({ timeSec, width: 320, height: 180 });
      if (!frame.ok) throw new Error(frame.error.message);
      counts.push(countWhiteStrokePixels(await readFile(frame.value.artifact.path)));
    }
    expect(counts[0]).toBeGreaterThan(1000);
    expect(counts[1]).toBe(0);
    expect(counts[2]! / counts[0]!).toBeCloseTo(0.5, 1);
    expect(counts[3]).toBe(counts[0]);
    expect(counts[4]).toBe(counts[2]);
    expect(counts[5]! / counts[0]!).toBeCloseTo(0.1, 1);
    expect(counts[6]).toBe(counts[2]);
  }, 60_000);

  it.each([
    '<path d="M10 50L190 50"/>', '<line x1="10" y1="50" x2="190" y2="50"/>',
    '<polyline points="10,70 100,20 190,70"/>', '<polygon points="20,20 180,20 100,80"/>',
    '<circle cx="100" cy="50" r="35"/>', '<rect x="20" y="20" width="160" height="60"/>',
    '<ellipse cx="100" cy="50" rx="80" ry="30"/>',
  ])("renders empty, partial and restored complete geometry: %s", async (geometry) => {
    const facade = createAgentFacade({ artifactRoot, renderProvider: providers.renderProvider });
    expect((await facade["project.create"]({ name: "trim-geometry", settings: { width: 320, height: 180 } })).ok).toBe(true);
    const created = await facade["edit.apply"]({ ops: [{
      op: "svg.create", startTime: 0, duration: 2,
      svgContent: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g stroke="white" stroke-width="6" fill="none">${geometry}</g></svg>`,
    }] });
    if (!created.ok) throw new Error(created.error.message);
    const overlayId = created.value.applied[0]!.createdIds.at(-1)!;
    const images: ReturnType<typeof decodeWhiteStroke>[] = [];
    for (const trimPathEnd of [1, 0, 0.5, 1]) {
      expect((await facade["edit.apply"]({ ops: [{ op: "svg.update", overlayId, trimPathEnd }] })).ok).toBe(true);
      const frame = await facade["preview.render_frame"]({ timeSec: 0.5, width: 320, height: 180 });
      if (!frame.ok) throw new Error(frame.error.message);
      images.push(decodeWhiteStroke(await readFile(frame.value.artifact.path)));
    }
    expect(images[0]!.count).toBeGreaterThan(100);
    expect(images[1]!.count).toBe(0);
    // Closed shapes have different joins and raster coverage when dashed;
    // the exact length/position assertions use the straight-line fixture above.
    expect(images[2]!.count).toBeGreaterThan(0);
    expect(images[2]!.count).toBeLessThan(images[0]!.count);
    if (geometry.startsWith("<rect")) {
      // Half the rectangular perimeter is its top and right edges. Sample
      // centerlines rather than comparing solid and dashed corner pixel area.
      const hasStrokeNear = (x: number, y: number) => images[2]!.pixels.some(p => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1);
      expect(hasStrokeNear(160, 42)).toBe(true);
      expect(hasStrokeNear(288, 90)).toBe(true);
      expect(hasStrokeNear(288, 136)).toBe(true); // reaches the right-bottom endpoint
      expect(hasStrokeNear(280, 138)).toBe(false); // does not continue along the bottom
      expect(hasStrokeNear(160, 138)).toBe(false);
      expect(hasStrokeNear(32, 90)).toBe(false);
    }
    expect(images[3]).toEqual(images[0]);
  });

  it.each(["trimPath", "trimPathStart", "trimPathOffset"])("seeks animated %s on the visible stroke", async (property) => {
    const facade = createAgentFacade({ artifactRoot, renderProvider: providers.renderProvider });
    expect((await facade["project.create"]({ name: "trim-properties", settings: { width: 320, height: 180 } })).ok).toBe(true);
    const created = await facade["edit.apply"]({ ops: [{
      op: "svg.create", startTime: 0, duration: 2,
      svgContent: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path d="M10 50L190 50" stroke="white" stroke-width="6" fill="none"/></svg>',
      trimPathEnd: property === "trimPathOffset" ? 0.5 : 1,
      keyframes: [{ property, time: 0, value: 0, easing: "linear" }, { property, time: 1, value: 1, easing: "linear" }],
    }] } as Parameters<typeof facade["edit.apply"]>[0]);
    if (!created.ok) throw new Error(created.error.message);
    const expected = property === "trimPath" ? [[false, false], [true, false], [true, true]]
      : property === "trimPathStart" ? [[true, true], [false, true], [false, false]]
      : [[true, false], [false, true], [true, false]];
    for (const [i, timeSec] of [0, 0.5, 1].entries()) {
      const frame = await facade["preview.render_frame"]({ timeSec, width: 320, height: 180 });
      if (!frame.ok) throw new Error(frame.error.message);
      const image = decodeWhiteStroke(await readFile(frame.value.artifact.path));
      // Centers of the first and second halves of the authored straight line.
      expect(image.pixels.some(p => p.x === 88 && p.y === 90)).toBe(expected[i]![0]);
      expect(image.pixels.some(p => p.x === 232 && p.y === 90)).toBe(expected[i]![1]);
    }
  });
});
