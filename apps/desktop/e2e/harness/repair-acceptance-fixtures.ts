import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PixelRect { x: number; y: number; width: number; height: number }

/** Small, original pixel-art fixture with three visible, separately repairable defects. */
export function createRepairAcceptanceFixture(root: string) {
  const width = 256;
  const height = 192;
  const clean = Buffer.alloc(width * height * 4);
  const fill = (pixels: Buffer, rect: PixelRect, color: number[]) => {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) pixels.set(color, (y * width + x) * 4);
    }
  };
  fill(clean, { x: 0, y: 0, width, height }, [235, 244, 249, 255]);
  fill(clean, { x: 0, y: 144, width, height: 48 }, [111, 168, 113, 255]);
  fill(clean, { x: 56, y: 64, width: 144, height: 92 }, [236, 194, 123, 255]);
  fill(clean, { x: 48, y: 56, width: 160, height: 8 }, [56, 68, 88, 255]);
  fill(clean, { x: 56, y: 64, width: 8, height: 92 }, [56, 68, 88, 255]);
  fill(clean, { x: 192, y: 64, width: 8, height: 92 }, [56, 68, 88, 255]);
  fill(clean, { x: 104, y: 108, width: 40, height: 48 }, [56, 68, 88, 255]);
  fill(clean, { x: 76, y: 84, width: 20, height: 20 }, [123, 195, 215, 255]);
  fill(clean, { x: 160, y: 84, width: 20, height: 20 }, [123, 195, 215, 255]);
  const damaged = Buffer.from(clean);
  const defects = [
    { name: "extra-line", rect: { x: 16, y: 28, width: 34, height: 6 }, color: [56, 68, 88, 255] },
    { name: "gap", rect: { x: 112, y: 56, width: 24, height: 8 }, color: [235, 244, 249, 255] },
    { name: "stain", rect: { x: 162, y: 120, width: 14, height: 12 }, color: [142, 53, 73, 255] },
  ];
  for (const defect of defects) fill(damaged, defect.rect, defect.color);
  mkdirSync(root, { recursive: true });
  const damagedPath = path.join(root, "damaged-house.png");
  const cleanPath = path.join(root, "clean-house.png");
  writeRgbaPng(damagedPath, width, height, damaged);
  writeRgbaPng(cleanPath, width, height, clean);
  return { width, height, clean, damaged, damagedPath, cleanPath, defects };
}

export function writeRgbaPng(file: string, width: number, height: number, pixels: Buffer): void {
  const png = execFileSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { input: pixels, windowsHide: true });
  writeFileSync(file, png);
}

export function decodeRgbaPng(file: string): { width: number; height: number; pixels: Buffer } {
  const size = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { windowsHide: true }).toString()).streams[0] as { width: number; height: number };
  const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { windowsHide: true, maxBuffer: size.width * size.height * 4 + 1024 });
  return { ...size, pixels };
}

/** Returns differing pixel counts, rather than accepting a content hash as visual evidence. */
export function comparePixels(before: Buffer, after: Buffer, width: number, regions: PixelRect[]) {
  if (before.length !== after.length) throw new Error("Pixel dimensions differ");
  let inside = 0;
  let outside = 0;
  for (let index = 0; index < before.length; index += 4) {
    if (before.subarray(index, index + 4).equals(after.subarray(index, index + 4))) continue;
    const x = (index / 4) % width;
    const y = Math.floor(index / 4 / width);
    const inRegion = regions.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
    if (inRegion) inside++;
    else outside++;
  }
  return { inside, outside };
}
