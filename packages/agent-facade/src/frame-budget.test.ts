import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fitFrameToBudget, isFrameBudget, MIN_FRAME_BUDGET_BYTES } from "./frame-budget";

const execute = promisify(execFile);

/** Incompressible noise frame — the honest worst case for PNG delivery. */
async function noisePng(dir: string, name = "noise.png", size = "640x360"): Promise<string> {
  const path = join(dir, name);
  await execute("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", `nullsrc=s=${size},geq=random(1)*255:random(1)*255:random(1)*255`, "-frames:v", "1", "-y", path], { timeout: 30000 });
  return path;
}

describe("frame byte-budget ladder", () => {
  const dirs: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rt-frame-budget-"));
    dirs.push(dir);
    return dir;
  }
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("keeps a lossless PNG when it already fits the budget", async () => {
    const dir = await tempDir();
    const png = await noisePng(dir);
    const fitted = await fitFrameToBudget({ pngPath: png, width: 640, height: 360, budgetBytes: 8 * 1024 * 1024, sourceWidth: 1920, sourceHeight: 1080 });
    expect(fitted.format).toBe("png");
    expect(fitted.path).toBe(png);
    expect(fitted.fidelity).toMatchObject({ format: "png", withinBudget: true, deliveredWidth: 640, deliveredHeight: 360, sourceWidth: 1920, sourceHeight: 1080, sizeBytes: fitted.bytes });
    expect(fitted.fidelity.note).toContain("Lossless PNG");
  });

  it("re-encodes oversized PNGs to budget-fitting JPEG and removes the original", async () => {
    const dir = await tempDir();
    const png = await noisePng(dir);
    const pngBytes = (await stat(png)).size;
    expect(pngBytes).toBeGreaterThan(120_000);
    const fitted = await fitFrameToBudget({ pngPath: png, width: 640, height: 360, budgetBytes: 120_000, sourceWidth: 1920, sourceHeight: 1080 });
    expect(fitted.format).toBe("jpeg");
    expect(fitted.bytes).toBeLessThanOrEqual(120_000);
    expect(fitted.path.endsWith(".jpg")).toBe(true);
    expect(fitted.fidelity).toMatchObject({ format: "jpeg", withinBudget: true, budgetBytes: 120_000 });
    expect(fitted.fidelity.note).toContain("recompress");
    // The lossless original is removed once the budget copy exists.
    await expect(stat(png)).rejects.toThrow();
    // The delivered bytes are a real JPEG.
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(fitted.path);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it("falls to the smallest ladder rung and flags it when nothing fits", async () => {
    const dir = await tempDir();
    const png = await noisePng(dir);
    const fitted = await fitFrameToBudget({ pngPath: png, width: 640, height: 360, budgetBytes: MIN_FRAME_BUDGET_BYTES, sourceWidth: 1920, sourceHeight: 1080 });
    expect(fitted.fidelity.withinBudget).toBe(false);
    expect(fitted.fidelity.deliveredWidth).toBeLessThanOrEqual(320);
    expect(fitted.fidelity.note).toContain("still exceeds");
  });

  it("validates budget bounds", () => {
    expect(isFrameBudget(32_768)).toBe(true);
    expect(isFrameBudget(8 * 1024 * 1024)).toBe(true);
    expect(isFrameBudget(1000)).toBe(false);
    expect(isFrameBudget(9 * 1024 * 1024)).toBe(false);
    expect(isFrameBudget(1_572_864)).toBe(true); // 1.5 MiB default, still an exact integer
    expect(isFrameBudget(1000.5)).toBe(false);
  });

  it("labels roi crops in the fidelity note", async () => {
    const dir = await tempDir();
    const png = await noisePng(dir, "region.png");
    const fitted = await fitFrameToBudget({ pngPath: png, width: 640, height: 360, budgetBytes: 8 * 1024 * 1024, sourceWidth: 1920, sourceHeight: 1080, regionLabel: "the roi {\"x\":0.1} crop" });
    expect(fitted.fidelity.note).toContain("roi");
  });
});
