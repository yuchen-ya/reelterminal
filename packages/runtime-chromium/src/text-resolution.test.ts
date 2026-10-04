import { expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

it("rasterizes enlarged titles as target-resolution glyphs rather than enlarged source pixels", async () => {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../core/src/text/title-engine.ts", import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "TitleModule",
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.REELTERMINAL_TEST_CHROMIUM
      ? { executablePath: process.env.REELTERMINAL_TEST_CHROMIUM }
      : {}),
  });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(() => {
      const module = (
        globalThis as unknown as {
          TitleModule: typeof import("@reelterminal/core/text/title-engine");
        }
      ).TitleModule;
      const engine = new module.TitleEngine();
      const clip = engine.createTextClip({
        trackId: "text",
        startTime: 0,
        text: "Review 123",
        style: {
          fontFamily: "Arial",
          fontSize: 18,
          strokeWidth: 0,
          shadowColor: "transparent",
        },
      });
      const source = engine.renderText(clip, 320, 180);
      const target = engine.renderText(clip, 640, 360, 0, {
        width: 320,
        height: 180,
      });
      const reference = engine.renderText(
        { ...clip, style: { ...clip.style, fontSize: 36 } },
        640,
        360,
      );
      const old = new OffscreenCanvas(640, 360);
      old.getContext("2d")!.drawImage(source.canvas, 0, 0, 640, 360);
      const pixels = (canvas: OffscreenCanvas | HTMLCanvasElement) =>
        (
          canvas.getContext("2d") as OffscreenCanvasRenderingContext2D
        ).getImageData(0, 0, 640, 360).data;
      const expected = pixels(reference.canvas);
      const error = (canvas: OffscreenCanvas | HTMLCanvasElement) =>
        pixels(canvas).reduce(
          (sum, value, index) => sum + Math.abs(value - expected[index]),
          0,
        );
      return {
        targetError: error(target.canvas),
        scaledError: error(old),
        width: target.canvas.width,
        height: target.canvas.height,
        originalFontSize: clip.style.fontSize,
      };
    });
    expect(result).toMatchObject({
      width: 640,
      height: 360,
      originalFontSize: 18,
    });
    expect(result.targetError).toBeLessThan(result.scaledError / 2);
  } finally {
    await browser.close();
  }
});
