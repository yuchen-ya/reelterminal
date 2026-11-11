import { afterAll, describe, expect, it } from "vitest";
import type { Project } from "@reelterminal/core/types/project";
import type { ShapeClip } from "@reelterminal/core/graphics/types";
import { DEFAULT_GRAPHIC_TRANSFORM } from "@reelterminal/core/graphics/types";
import { DEFAULT_TEXT_STYLE, DEFAULT_TEXT_TRANSFORM } from "@reelterminal/core/text/types";
import { DEFAULT_PARTICLE_CONFIG } from "@reelterminal/core/effects/particle-types";
import { ChromiumRuntime } from "./node/runtime";

interface Pixels {
  width: number;
  height: number;
  rgba: number[];
}

const runtime = new ChromiumRuntime();

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "timeline-overlays", name: "Timeline overlay regression",
    createdAt: 1, modifiedAt: 1,
    settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: {
      duration: 4, subtitles: [], markers: [],
      tracks: [{
        id: "overlay-track", name: "Overlay", type: "graphics", clips: [],
        transitions: [], hidden: false, locked: false, muted: false, solo: false,
      }],
    },
    ...overrides,
  };
}

// Reuse Chromium's native PNG decoder rather than maintaining a test PNG codec.
async function pixels(png: Buffer): Promise<Pixels> {
  return runtime.withIsolatedContext({ javaScriptEnabled: true }, async (context) => {
    const page = await context.newPage();
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return {
        width: image.width, height: image.height,
        rgba: Array.from(ctx.getImageData(0, 0, image.width, image.height).data),
      };
    }, png.toString("base64"));
  });
}

function coloredBounds(image: Pixels, match = (r: number, g: number, b: number) => r + g + b > 120) {
  let left = image.width;
  let right = -1;
  let top = image.height;
  let bottom = -1;
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * 4;
      if (!match(image.rgba[index]!, image.rgba[index + 1]!, image.rgba[index + 2]!)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      count++;
    }
  }
  return { count, left, top, width: right - left + 1, height: bottom - top + 1 };
}

describe("real Chromium timeline overlay content", () => {
  afterAll(async () => runtime.close());

  it("draws the active subtitle word and scales its project-pixel layout", async () => {
    const fixture = project();
    const captioned = {
      ...fixture,
      timeline: {
        ...fixture.timeline,
        subtitles: [{
          id: "words", text: "I MMMMMM", startTime: 0, endTime: 4,
          animationStyle: "word-by-word" as const,
          style: {
            fontFamily: "Arial", fontSize: 40, color: "#ffffff",
            backgroundColor: "#000000", position: "center" as const,
          },
          words: [
            { text: "I", startTime: 0, endTime: 2 },
            { text: "MMMMMM", startTime: 2, endTime: 4 },
          ],
        }],
      },
    };
    const frames = await runtime.withHydratedSession(captioned, {}, async (session) => [
      await session.renderPng(0.5, 320, 180),
      await session.renderPng(2.5, 320, 180),
      await session.renderPng(2.5, 160, 90),
    ]);
    const [narrow, wide, half] = await Promise.all(frames.map(pixels));
    const narrowBounds = coloredBounds(narrow!);
    const wideBounds = coloredBounds(wide!);
    const halfBounds = coloredBounds(half!);
    expect(narrowBounds.count).toBeGreaterThan(30);
    expect(wideBounds.width).toBeGreaterThan(narrowBounds.width * 4);
    expect(wideBounds.height).toBeGreaterThan(20);
    expect(Math.abs(halfBounds.width * 2 - wideBounds.width)).toBeLessThanOrEqual(4);
    expect(Math.abs(halfBounds.height * 2 - wideBounds.height)).toBeLessThanOrEqual(4);
  });

  it("renders persisted particles identically after backward seek and clears them at the project boundary", async () => {
    const fixture = project({
      shapeClips: [{
        id: "owner", trackId: "overlay-track", type: "shape", shapeType: "rectangle",
        startTime: 1, duration: 0.1, keyframes: [], transform: DEFAULT_GRAPHIC_TRANSFORM,
        style: {
          fill: { type: "none", opacity: 0 },
          stroke: { color: "#000000", width: 0, opacity: 0 },
        },
      }],
      particleEffects: [{
        id: "green-particles", clipId: "owner", type: "dust", startTime: 1, duration: 2, enabled: true,
        config: {
          ...DEFAULT_PARTICLE_CONFIG, colors: ["#00ff00"], particleCount: 10,
          emissionRate: 20, emissionShape: "rectangle", emissionRadius: 35,
          speed: 30, speedVariance: 0, gravity: 0, turbulence: 0,
          lifetime: { min: 2, max: 2 }, opacity: { start: 1, end: 1 },
          fadeIn: 0, fadeOut: 0, size: { min: 8, max: 8 }, blendMode: "normal",
        },
      }],
    });
    const frames = await runtime.withHydratedSession(fixture, {}, async (session) => [
      await session.renderPng(0.5, 320, 180),
      await session.renderPng(1.5, 320, 180),
      await session.renderPng(2.5, 320, 180),
      await session.renderPng(1.5, 320, 180),
      await session.renderPng(3, 320, 180),
    ]);
    const [before, first, later, replay, ended] = await Promise.all(frames.map(pixels));
    const green = (r: number, g: number, b: number) => g > 100 && r < 20 && b < 20;
    expect(coloredBounds(before!, green).count).toBe(0);
    expect(coloredBounds(first!, green).count).toBeGreaterThan(100);
    expect(later!.rgba).not.toEqual(first!.rgba);
    expect(replay!.rgba).toEqual(first!.rgba);
    expect(coloredBounds(ended!, green).count).toBe(0);
    const emptyProject = await pixels(await runtime.renderPng(project({ id: "other-project" }), {}, 1.5, 320, 180));
    expect(coloredBounds(emptyProject, green).count).toBe(0);
    const hidden = {
      ...fixture,
      timeline: {
        ...fixture.timeline,
        tracks: fixture.timeline.tracks.map((track) => ({ ...track, hidden: true })),
      },
    };
    const hiddenOwner = await pixels(await runtime.renderPng(hidden, {}, 1.5, 320, 180));
    const deletedOwner = await pixels(await runtime.renderPng({ ...fixture, shapeClips: [] }, {}, 1.5, 320, 180));
    expect(coloredBounds(hiddenOwner, green).count).toBe(0);
    expect(coloredBounds(deletedOwner, green).count).toBe(0);
  });

  it("draws a mesh torus with a real central hole", async () => {
    const torus: ShapeClip = {
      id: "mesh", trackId: "overlay-track", type: "shape", shapeType: "mesh-torus",
      startTime: 0, duration: 4, keyframes: [],
      transform: { ...DEFAULT_GRAPHIC_TRANSFORM, scale: { x: 3, y: 3 }, rotate3d: { x: 15, y: 25, z: 0 } },
      style: {
        fill: { type: "solid", color: "#00ff00", opacity: 1 },
        stroke: { color: "#000000", width: 0, opacity: 0 }, material3d: { kind: "basic" },
      },
    };
    const frame = await pixels(await runtime.renderPng(project({ shapeClips: [torus] }), {}, 0.5, 320, 180));
    const bounds = coloredBounds(frame, (r, g, b) => g > 100 && r < 20 && b < 20);
    expect(bounds.count).toBeGreaterThan(1000);
    expect(bounds.width).toBeGreaterThan(60);
    expect(bounds.height).toBeGreaterThan(60);
    for (let y = 86; y <= 94; y++) {
      for (let x = 156; x <= 164; x++) {
        expect(frame.rgba[(y * frame.width + x) * 4 + 1]).toBeLessThan(20);
      }
    }
  });

  it("draws separate front and extrusion colors for tilted 3D text", async () => {
    const base = project();
    const fixture = project({
      timeline: { ...base.timeline, tracks: [{ ...base.timeline.tracks[0]!, type: "text" }] },
      textClips: [{
        id: "extruded-text", trackId: "overlay-track", startTime: 0, duration: 4,
        text: "HI", keyframes: [],
        style: { ...DEFAULT_TEXT_STYLE, fontSize: 52, color: "#ff0000", strokeWidth: 0 },
        transform: { ...DEFAULT_TEXT_TRANSFORM, rotate3d: { x: 10, y: 35, z: 0 } },
        text3d: {
          enabled: true, depth: 18, bevelThickness: 0, bevelSize: 0, bevelSegments: 1,
          frontColor: "#ff0000", sideColor: "#00ffff", material: "basic",
        },
      }],
    });
    const frame = await pixels(await runtime.renderPng(fixture, {}, 0.5, 320, 180));
    expect(coloredBounds(frame, (r, g, b) => r > 150 && g < 40 && b < 40).count).toBeGreaterThan(200);
    expect(coloredBounds(frame, (r, g, b) => g > 150 && b > 150 && r < 40).count).toBeGreaterThan(50);
  });
});
