import { expect, test } from "vitest";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { openOrCreateBoard } from "./harness/workspace-tabs";
import { writeRgbaPng } from "./harness/repair-acceptance-fixtures";

test("region capture includes text just entered with the text tool", async () => {
  const launched = await launchApp();
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    const pixels = Buffer.alloc(200 * 100 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([100, 200, 100, 255], i);
    const imagePath = path.join(launched.runDir, "capture-source.png");
    writeRgbaPng(imagePath, 200, 100, pixels);
    await page.getByTestId("human-board-import-files").setInputFiles(imagePath);
    await page.getByTestId("human-board-single-file").waitFor();
    const stage = page.getByTestId("human-board-scene").locator(".excalidraw");
    const bounds = (await stage.boundingBox())!;
    await stage.focus();
    await page.keyboard.press("p");
    await page.mouse.move(bounds.x + 220, bounds.y + 300);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 400, bounds.y + 320, { steps: 10 });
    await page.mouse.up();
    await stage.focus();
    await page.keyboard.press("t");
    await page.mouse.click(bounds.x + 300, bounds.y + 250);
    const editor = page.locator('[data-type="wysiwyg"]');
    await editor.fill("点击投币10次 English");
    await page.getByTestId("human-board-capture-region").click();
    await page.getByTestId("human-board-capture-overlay").waitFor();
    await page.mouse.move(bounds.x + 50, bounds.y + 50);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 650, bounds.y + 350);
    await page.mouse.up();
    await page.getByTestId("human-board-capture-confirm").click();
    const image = page.getByTestId("human-board-output-image");
    await image.waitFor();
    const counts = await image.evaluate(async node => {
      const source = node as HTMLImageElement;
      await source.decode();
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const scale = canvas.width / 600;
      let chinese = 0, english = 0, stroke = 0, green = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const sx = x / scale, sy = y / scale;
        if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) {
          if (sy >= 190 && sy < 240 && sx >= 240 && sx < 390) chinese++;
          if (sy >= 190 && sy < 240 && sx >= 390 && sx < 500) english++;
          if (sy >= 245 && sy < 280 && sx >= 165 && sx < 360) stroke++;
        }
        if (pixels[i] === 100 && pixels[i + 1] === 200 && pixels[i + 2] === 100) green++;
      }
      return { chinese, english, stroke, green };
    });
    expect(counts.chinese).toBeGreaterThan(30);
    expect(counts.english).toBeGreaterThan(20);
    expect(counts.stroke).toBeGreaterThan(20);
    expect(counts.green).toBeGreaterThan(100);
  } finally { await launched.close(); }
}, 120_000);

