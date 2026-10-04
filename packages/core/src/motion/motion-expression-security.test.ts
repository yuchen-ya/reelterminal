import { describe, expect, it, vi } from "vitest";
import {
  createMotionExpression,
  evaluateMotionPropertyValueAtTime,
  getMotionExpressionError,
} from "./motion-expressions";

function evaluate(code: string): number {
  const expression = { ...createMotionExpression("expression", "opacity", code), code };
  return evaluateMotionPropertyValueAtTime({
    expressions: [expression], keyframes: [], property: "opacity",
    localTime: 0, fallback: 1, duration: 1,
  });
}

describe("imported animation expressions", () => {
  it("cannot access a desktop bridge, globals or constructors", () => {
    const readFile = vi.fn();
    vi.stubGlobal("reelterminal", { fs: { readFile } });
    try {
      for (const code of [
        'globalThis.reelterminal.fs.readFile("private")',
        'window.reelterminal.fs.readFile("private")',
        'reelterminal.fs.readFile("private")',
        'Math.sin.constructor("return globalThis")()',
        'Math["constructor"]',
        '"".__proto__.constructor',
        'value.constructor.constructor("return globalThis")()',
        'Function("return globalThis")()',
        'import("node:fs")',
      ]) {
        expect(evaluate(code)).toBe(1);
        expect(getMotionExpressionError(code)).not.toBeNull();
      }
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects loops, functions, mutations and excessive input before execution", () => {
    for (const code of [
      "while (true) {}", "for (;;) {}", "(() => 99)()",
      "Math.PI = 99", "let a = 1; a++; return a;", "1+".repeat(5000) + "1",
    ]) {
      expect(evaluate(code)).toBe(1);
      expect(getMotionExpressionError(code)).not.toBeNull();
    }
    expect(Math.PI).toBeCloseTo(3.141592653589793);
  });

  it("keeps arithmetic, conditional values and local constants usable", () => {
    expect(evaluate("const scale = Math.pow(2, 3); return time === 0 ? scale + value : 0;")).toBe(9);
  });
});
