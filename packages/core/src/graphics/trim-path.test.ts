import { describe, expect, it } from "vitest";
import { applySvgTrimPathMarkup } from "./graphics-engine";

const BASE_SVG =
  '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"><path d="M 10 50 L 190 50" stroke="#ffffff" stroke-width="8" fill="none"/></svg>';

describe("applySvgTrimPathMarkup", () => {
  it("returns full stroke markup unchanged when trim values are defaults", () => {
    expect(applySvgTrimPathMarkup(BASE_SVG, 0, 1, 0)).toBe(BASE_SVG);
  });

  it("hides zero-length stroke cleanly including stroke-opacity=0", () => {
    const out = applySvgTrimPathMarkup(BASE_SVG, 0, 0, 0);
    expect(out).toContain('pathLength="1"');
    expect(out).toContain('stroke-dasharray="0 2"');
    expect(out).toContain('stroke-opacity="0"');
  });

  it("injects normalized dasharray and dashoffset for partial growth [0, 0.5]", () => {
    const out = applySvgTrimPathMarkup(BASE_SVG, 0, 0.5, 0);
    expect(out).toContain('pathLength="1"');
    expect(out).toContain('stroke-dasharray="0.500000 2"');
    expect(out).toContain('stroke-dashoffset="0"');
    expect(out).not.toContain('stroke-opacity="0"');
  });

  it("injects shifted negative dashoffset for non-zero start/offset", () => {
    const out = applySvgTrimPathMarkup(BASE_SVG, 0.25, 0.75, 0.1);
    expect(out).toContain('stroke-dasharray="0.500000 2"');
    expect(out).toContain('stroke-dashoffset="-0.350000"');
  });

  it("splits dasharray across wrap boundary when start + offset + length > 1", () => {
    const out = applySvgTrimPathMarkup(BASE_SVG, 0, 0.5, 0.75);
    expect(out).toContain('stroke-dasharray="0.250000 0.500000 0.250000 2"');
    expect(out).toContain('stroke-dashoffset="0"');
  });

  it("replaces pre-existing dasharray/dashoffset attributes without duplication", () => {
    const preDashed =
      '<svg viewBox="0 0 100 100"><line x1="0" y1="0" x2="100" y2="0" pathLength="100" stroke-dasharray="10 5" stroke-dashoffset="4" style="stroke-dasharray: 9 9; stroke:#fff" /></svg>';
    const out = applySvgTrimPathMarkup(preDashed, 0, 0.4, 0);
    expect(out.match(/stroke-dasharray=/g)).toHaveLength(1);
    expect(out.match(/pathLength=/g)).toHaveLength(1);
    expect(out).toContain('stroke-dasharray="0.400000 2"');
    expect(out).toContain('style="stroke:#fff"');
  });

  it.each([0, 0.25, 1, -1])("preserves authored fills, dashes and opacity for a complete path at offset %s", (offset) => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0 0L100 100" fill="red" stroke="white" pathLength="100" stroke-dasharray="10 5" style="stroke-opacity:.4;fill-opacity:.8"/></svg>';
    expect(applySvgTrimPathMarkup(svg, 0, 1, offset)).toBe(svg);
  });

  it("treats negative and multi-turn offsets as the same position on the path", () => {
    const reference = applySvgTrimPathMarkup(BASE_SVG, 0, 0.5, 0.75);
    expect(applySvgTrimPathMarkup(BASE_SVG, 0, 0.5, -0.25)).toBe(reference);
    expect(applySvgTrimPathMarkup(BASE_SVG, 0, 0.5, 2.75)).toBe(reference);
  });

  it("keeps the source SVG reusable when switching between empty, partial and full paths", () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0 0L100 0" stroke="white" stroke-linecap="round" stroke-opacity=".6" style="stroke-opacity:.4;fill:red"/></svg>';
    const empty = applySvgTrimPathMarkup(svg, 0.8, 0.2, 0);
    expect(empty).toContain('stroke-opacity="0"');
    expect(empty).not.toContain('stroke-opacity:.4');
    expect(empty).toContain('fill:red');
    const partial = applySvgTrimPathMarkup(svg, 0, 0.5, 0);
    expect(partial).toContain('stroke-opacity=".6"');
    expect(partial).toContain('stroke-opacity:.4');
    expect(applySvgTrimPathMarkup(svg, 0, 1, 0)).toBe(svg);
  });
});
