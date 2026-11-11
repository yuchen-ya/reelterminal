import { expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

it("keeps snapshot shader pixels across an editor project switch and recompiles same-id definitions", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { VideoEngine } from "@reelterminal/core/video/video-engine";
        import { TitleEngine } from "@reelterminal/core/text/title-engine";
        import { GraphicsEngine } from "@reelterminal/core/graphics/graphics-engine";
        import { registerProjectGeneratedShaders } from "@reelterminal/core/motion/shaders/project-shaders";
        import { DEFAULT_MOTION_TRANSFORM, DEFAULT_MOTION_INSTANCE_TRANSFORM } from "@reelterminal/core/motion/types";
        globalThis.SnapshotShaders = { VideoEngine, TitleEngine, GraphicsEngine, registerProjectGeneratedShaders, DEFAULT_MOTION_TRANSFORM, DEFAULT_MOTION_INSTANCE_TRANSFORM };
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true, write: false, platform: "browser", format: "esm",
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.REELTERMINAL_TEST_CHROMIUM ? { executablePath: process.env.REELTERMINAL_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: bundle.outputFiles[0].text });
    const results = await page.evaluate(async () => {
      type Project = import("@reelterminal/core/types/project").Project;
      type Shader = import("@reelterminal/core/motion/shaders/types").MotionShaderDef;
      const api = (globalThis as unknown as {
        SnapshotShaders: {
          VideoEngine: typeof import("@reelterminal/core/video/video-engine").VideoEngine;
          TitleEngine: typeof import("@reelterminal/core/text/title-engine").TitleEngine;
          GraphicsEngine: typeof import("@reelterminal/core/graphics/graphics-engine").GraphicsEngine;
          registerProjectGeneratedShaders: typeof import("@reelterminal/core/motion/shaders/project-shaders").registerProjectGeneratedShaders;
          DEFAULT_MOTION_TRANSFORM: typeof import("@reelterminal/core/motion/types").DEFAULT_MOTION_TRANSFORM;
          DEFAULT_MOTION_INSTANCE_TRANSFORM: typeof import("@reelterminal/core/motion/types").DEFAULT_MOTION_INSTANCE_TRANSFORM;
        };
      }).SnapshotShaders;
      const shader = (color: string, category: Shader["category"]): Shader => ({
        id: "snapshot-color", name: "Snapshot color", category, params: [], origin: "generated",
        glsl: `#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor=vec4(${color},1.0); }`,
      });
      const factory = new api.GraphicsEngine();
      const shape = factory.createShape({ shapeType: "rectangle", width: 50, height: 50 }, "overlay", 0, 2);
      const title = new api.TitleEngine().createTextClip({
        trackId: "overlay", startTime: 0, duration: 2, text: "MMMM",
        style: { fontFamily: "Arial", fontSize: 30, strokeWidth: 0, shadowColor: "transparent", shader: { shaderId: "snapshot-color", params: {} } },
      });
      const shapeStyle = { ...shape.style, fill: { type: "shader" as const, opacity: 1, shader: { shaderId: "snapshot-color", params: {} } } };
      const fixture = (kind: string, definition: Shader): Project => {
        const project: Project = {
          id: "snapshot", name: "Snapshot", createdAt: 0, modifiedAt: 0,
          settings: { width: 128, height: 72, frameRate: 30, sampleRate: 48000, channels: 2 },
          mediaLibrary: { items: [{ id: "video", name: "source", type: "video", blob: new Blob(["fixture"]), metadata: { duration: 2, width: 128, height: 72, frameRate: 30 } } as Project["mediaLibrary"]["items"][number]] },
          generatedShaders: [definition],
          timeline: {
            duration: 2, subtitles: [], markers: [], tracks: [
              { id: "overlay", type: kind === "text" ? "text" : "graphics", name: "Overlay", clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false },
              { id: "video", type: "video", name: "Video", transitions: [], locked: false, hidden: false, muted: false, solo: false, clips: [{
                id: "source", trackId: "video", mediaId: "video", startTime: 0, duration: 2, inPoint: 0, outPoint: 2,
                transform: api.DEFAULT_MOTION_INSTANCE_TRANSFORM, volume: 0, audioEffects: [], keyframes: [],
                effects: kind === "effect" ? [{ id: "effect", type: "shader", enabled: true, params: { shaderId: "snapshot-color" } }] : [],
              }] },
            ],
          },
        };
        if (kind === "shape") return { ...project, shapeClips: [{ ...shape, transform: { ...shape.transform, scale: { x: 4, y: 4 } }, style: shapeStyle }] };
        if (kind === "text") return { ...project, textClips: [title] };
        if (kind === "motion") return {
          ...project,
          motionCompositions: [{
            id: "composition", name: "Shader composition", width: 128, height: 72, duration: 2, frameRate: 30,
            backgroundColor: "transparent", assets: [], variables: [], markers: [], createdAt: 0, modifiedAt: 0,
            layers: [{ id: "layer", name: "Shader layer", type: "shape", shapeType: "rectangle", startTime: 0, duration: 2, visible: true, locked: false, keyframes: [], width: 60, height: 40, style: shapeStyle, transform: { ...api.DEFAULT_MOTION_TRANSFORM, position: { x: 64, y: 36 } } }],
          }],
          motionInstances: [{ id: "instance", compositionId: "composition", trackId: "overlay", startTime: 0, duration: 2, opacity: 1, transform: api.DEFAULT_MOTION_INSTANCE_TRANSFORM }],
        };
        return project;
      };
      const black = new OffscreenCanvas(128, 72);
      const blackCtx = black.getContext("2d")!;
      blackCtx.fillStyle = "black";
      blackCtx.fillRect(0, 0, 128, 72);
      const countColors = (image: ImageBitmap) => {
        const canvas = new OffscreenCanvas(128, 72);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        image.close();
        const data = ctx.getImageData(0, 0, 128, 72).data;
        const result = { red: 0, blue: 0, green: 0 };
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! > 150 && data[i + 1]! < 40 && data[i + 2]! < 40) result.red++;
          if (data[i + 2]! > 150 && data[i]! < 40 && data[i + 1]! < 40) result.blue++;
          if (data[i + 1]! > 150 && data[i]! < 40 && data[i + 2]! < 40) result.green++;
        }
        return result;
      };
      const output = [];
      for (const kind of ["shape", "text", "effect", "motion"]) {
        const category = kind === "effect" ? "effect" : "fill";
        const engine = new api.VideoEngine();
        await engine.initialize();
        let start!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => { start = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const pending = engine.renderFrame(fixture(kind, shader("1.0,0.0,0.0", category)), 0.5, 128, 72, {
          decodeSourceFrame: async () => { start(); await gate; return createImageBitmap(black); },
        });
        await started;
        api.registerProjectGeneratedShaders({ generatedShaders: [shader("0.0,1.0,0.0", category)] });
        release();
        const first = countColors((await pending).image);
        const second = countColors((await engine.renderFrame(fixture(kind, shader("0.0,0.0,1.0", category)), 0.5, 128, 72, {
          decodeSourceFrame: async () => createImageBitmap(black),
        })).image);
        output.push({ kind, first, second });
        engine.dispose();
      }
      return output;
    });
    for (const { kind, first, second } of results) {
      expect(first.red, `${kind}: original snapshot`).toBeGreaterThan(50);
      expect(first.green, `${kind}: editor switch must not retarget shader`).toBe(0);
      expect(first.blue, kind).toBe(0);
      expect(second.blue, `${kind}: changed same-id definition`).toBeGreaterThan(50);
      expect(second.red, `${kind}: stale compiled program`).toBe(0);
      expect(second.green, kind).toBe(0);
    }
  } finally {
    await browser.close();
  }
});
