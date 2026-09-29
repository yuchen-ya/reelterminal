/**
 * Contract for commitRenderedFrame: failed, empty and superseded results can
 * never replace the last good frame or paint the canvas; the winning frame is
 * validated before the previous bitmap is closed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  commitRenderedFrame,
  type FrameCommitGate,
} from "./frame-commit";

const makeBitmap = (width = 100, height = 100): ImageBitmap => {
  const close = vi.fn();
  return { width, height, close } as unknown as ImageBitmap;
};

const makeGate = (
  overrides?: Partial<FrameCommitGate>,
): FrameCommitGate & { painted: ImageBitmap[] } => {
  const painted: ImageBitmap[] = [];
  return {
    painted,
    isCurrent: () => true,
    claimCommit: () => true,
    lastGood: { current: null },
    ...overrides,
  };
};

describe("commitRenderedFrame", () => {
  it("commits a valid frame and swaps the remembered bitmap", async () => {
    const previous = makeBitmap();
    const next = makeBitmap();
    const gate = makeGate();
    gate.lastGood.current = previous;

    const result = await commitRenderedFrame(gate, {
      produce: async () => next,
      paint: (frame) => gate.painted.push(frame),
    });

    expect(result).toBe("committed");
    expect(gate.lastGood.current).toBe(next);
    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(gate.painted).toEqual([next]);
  });

  it("keeps the last good frame when the encode fails", async () => {
    const previous = makeBitmap();
    const gate = makeGate();
    gate.lastGood.current = previous;

    const result = await commitRenderedFrame(gate, {
      produce: async () => {
        throw new Error("createImageBitmap failed");
      },
      paint: (frame) => gate.painted.push(frame),
    });

    expect(result).toBe("invalid");
    expect(gate.lastGood.current).toBe(previous);
    expect(previous.close).not.toHaveBeenCalled();
    expect(gate.painted).toEqual([]);
  });

  it("keeps the last good frame when the produced bitmap is empty", async () => {
    const previous = makeBitmap();
    const gate = makeGate();
    gate.lastGood.current = previous;

    const result = await commitRenderedFrame(gate, {
      produce: async () => makeBitmap(0, 0),
      paint: (frame) => gate.painted.push(frame),
    });

    expect(result).toBe("invalid");
    expect(gate.lastGood.current).toBe(previous);
    expect(previous.close).not.toHaveBeenCalled();
    expect(gate.painted).toEqual([]);
  });

  it("keeps the last good frame when the result is null (unconfirmed decode)", async () => {
    const previous = makeBitmap();
    const gate = makeGate();
    gate.lastGood.current = previous;

    const result = await commitRenderedFrame(gate, {
      produce: async () => null,
      paint: (frame) => gate.painted.push(frame),
    });

    expect(result).toBe("invalid");
    expect(gate.lastGood.current).toBe(previous);
    expect(previous.close).not.toHaveBeenCalled();
    expect(gate.painted).toEqual([]);
  });

  it("does not paint or swap when the request was invalidated", async () => {
    const previous = makeBitmap();
    const next = makeBitmap();
    const gate = makeGate({ isCurrent: () => false });
    gate.lastGood.current = previous;

    const result = await commitRenderedFrame(gate, {
      produce: async () => next,
      paint: (frame) => gate.painted.push(frame),
    });

    expect(result).toBe("stale");
    expect(gate.lastGood.current).toBe(previous);
    expect(previous.close).not.toHaveBeenCalled();
    expect(gate.painted).toEqual([]);
    expect(next.close).toHaveBeenCalledTimes(1);
  });

  it("does not paint or swap when a newer frame already claimed the canvas", async () => {
    const previous = makeBitmap();
    const next = makeBitmap();
    const gate = makeGate({ claimCommit: () => false });
    gate.lastGood.current = previous;

    const result = await commitRenderedFrame(gate, {
      produce: async () => next,
      paint: (frame) => gate.painted.push(frame),
    });

    expect(result).toBe("stale");
    expect(gate.lastGood.current).toBe(previous);
    expect(gate.painted).toEqual([]);
  });

  it("drops the old bitmap only after the replacement is confirmed", async () => {
    const previous = makeBitmap();
    const order: string[] = [];
    const gate = makeGate();
    gate.lastGood.current = previous;
    previous.close = vi.fn(() => order.push("close-previous"));

    const result = await commitRenderedFrame(gate, {
      produce: async () => {
        order.push("produce");
        return makeBitmap();
      },
      paint: () => order.push("paint"),
    });

    expect(result).toBe("committed");
    expect(order).toEqual(["produce", "paint", "close-previous"]);
  });
});
