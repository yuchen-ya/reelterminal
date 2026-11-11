import { describe, expect, it, vi } from "vitest";
import type { Subtitle } from "../types/timeline";
import { getActiveSubtitles, renderSubtitleToCanvas } from "./subtitle-canvas-renderer";

const subtitle: Subtitle = {
  id: "caption", text: "hello world", startTime: 1, endTime: 3,
  style: { fontFamily: "Inter", fontSize: 48, color: "#ffffff", backgroundColor: "#000000", position: "bottom", highlightColor: "#ff0000" },
  words: [ { text: "hello", startTime: 1, endTime: 2 }, { text: "world", startTime: 2, endTime: 3 } ],
};

function context() {
  const glyphs: Array<{ text: string; color: string; font: string; x: number; y: number }> = [];
  const ctx = {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    fillStyle: "", font: "", globalAlpha: 1, textAlign: "", textBaseline: "",
    fillRect: vi.fn(), measureText: (text: string) => ({ width: text.length * 24 }),
    fillText(text: string, x: number, y: number) { glyphs.push({ text, color: this.fillStyle, font: this.font, x, y }); },
  };
  return { ctx: ctx as unknown as OffscreenCanvasRenderingContext2D, calls: ctx, glyphs };
}

describe("shared subtitle canvas renderer", () => {
  it("draws static multiline captions in project pixels at every raster size", () => {
    const full = context();
    const preview = context();
    const multiline = { ...subtitle, text: "hello\nworld" };
    renderSubtitleToCanvas(full.ctx, multiline, 1920, 1080, 1.5);
    renderSubtitleToCanvas(preview.ctx, multiline, 480, 270, 1.5, { width: 1920, height: 1080 });
    expect(preview.calls.scale).toHaveBeenCalledWith(0.25, 0.25);
    expect(preview.glyphs).toEqual(full.glyphs);
    expect(full.glyphs.map((glyph) => glyph.text)).toEqual(["hello", "world"]);
    expect(full.glyphs[0].font).toBe('bold 48px "Inter"');
  });

  it("uses the requested timeline time for per-word captions", () => {
    const first = context();
    const second = context();
    const animated = { ...subtitle, animationStyle: "word-by-word" as const };
    renderSubtitleToCanvas(first.ctx, animated, 1920, 1080, 1.5);
    renderSubtitleToCanvas(second.ctx, animated, 1920, 1080, 2.5);
    expect(first.glyphs.map((glyph) => glyph.text)).toEqual(["hello"]);
    expect(second.glyphs.map((glyph) => glyph.text)).toEqual(["world"]);
  });

  it("preserves highlighted word colors through downscaled rendering", () => {
    const frame = context();
    renderSubtitleToCanvas(frame.ctx, { ...subtitle, animationStyle: "word-highlight" }, 480, 270, 2.5, { width: 1920, height: 1080 });
    expect(frame.glyphs.map(({ text, color }) => ({ text, color }))).toEqual([
      { text: "hello", color: "#ffffff" }, { text: "world", color: "#ff0000" },
    ]);
  });

  it("selects half-open subtitle intervals and skips empty text", () => {
    expect(getActiveSubtitles([subtitle], 1)).toEqual([subtitle]);
    expect(getActiveSubtitles([subtitle], 3)).toEqual([]);
    const frame = context();
    renderSubtitleToCanvas(frame.ctx, { ...subtitle, text: "  " }, 1920, 1080, 2);
    expect(frame.calls.save).not.toHaveBeenCalled();
  });
});
