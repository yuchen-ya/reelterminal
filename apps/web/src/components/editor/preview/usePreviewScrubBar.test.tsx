// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const fixture = vi.hoisted(() => ({
  bridge: {
    startScrubbing: vi.fn(),
    scrubTo: vi.fn(),
    endScrubbing: vi.fn(),
    requestSeek: vi.fn(async () => {}),
    requestSeekRelative: vi.fn(async () => {}),
  },
}));

vi.mock("../../../bridges/playback-bridge", () => ({
  getPlaybackBridge: () => fixture.bridge,
}));

import { usePreviewScrubBar } from "./usePreviewScrubBar";

// jsdom has no PointerEvent; the scrub logic needs MouseEvent fields plus
// pointerId, so a minimal subclass lets fireEvent.pointer* carry
// button/clientX/pointerId (same polyfill as FloatingWindow.test.tsx).
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;

    constructor(
      type: string,
      init: ConstructorParameters<typeof MouseEvent>[1] & {
        pointerId?: number;
      } = {},
    ) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    writable: true,
    configurable: true,
    value: PointerEventPolyfill,
  });
}

/**
 * Mirrors the (unchanged) JSX wiring in Preview.tsx so the ref and handlers
 * are exercised exactly as the player binds them.
 */
function ScrubBarHarness({
  actualEndTime,
  playheadPosition,
}: {
  actualEndTime: number;
  playheadPosition: number;
}) {
  const bar = usePreviewScrubBar({ actualEndTime, playheadPosition });
  return (
    <div
      ref={bar.scrubBarRef}
      role="slider"
      aria-label="Scrub bar"
      onPointerDown={bar.handleScrubPointerDown}
      onPointerMove={bar.handleScrubPointerMove}
      onPointerUp={bar.handleScrubPointerEnd}
      onPointerCancel={bar.handleScrubPointerEnd}
      onKeyDown={bar.handleScrubKeyDown}
    />
  );
}

// Known bar rectangle: left=100, width=400 so clientX 300 is the exact
// midpoint (50%) and time = fraction * actualEndTime.
function stubBarGeometry(bar: HTMLElement, hasCapture: boolean) {
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 0,
    right: 500,
    bottom: 10,
    width: 400,
    height: 10,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // jsdom has no pointer-capture implementation; provide the surface the hook uses.
  bar.setPointerCapture = vi.fn();
  bar.hasPointerCapture = vi.fn(() => hasCapture);
  bar.releasePointerCapture = vi.fn();
}

function renderScrubBar(props = { actualEndTime: 6, playheadPosition: 0 }) {
  render(<ScrubBarHarness {...props} />);
  const bar = screen.getByRole("slider", { name: "Scrub bar" });
  return { bar };
}

function keyEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactKeyboardEvent<HTMLDivElement>;
}

describe("usePreviewScrubBar", () => {
  beforeEach(() => {
    for (const fn of Object.values(fixture.bridge)) {
      fn.mockClear();
    }
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("converts a pointer down near the bar midpoint into the proportional scrub time", () => {
    const { bar } = renderScrubBar({ actualEndTime: 6, playheadPosition: 0 });
    stubBarGeometry(bar, false);

    // (300 - 100) / 400 = 0.5 → 0.5 * 6s = 3s
    fireEvent.pointerDown(bar, { button: 0, pointerId: 7, clientX: 300 });
    expect(fixture.bridge.startScrubbing).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.scrubTo).toHaveBeenLastCalledWith(3);

    // A non-primary button never starts a gesture.
    fireEvent.pointerDown(bar, { button: 2, pointerId: 8, clientX: 480 });
    expect(fixture.bridge.startScrubbing).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(1);

    // Edges clamp: far right → end of timeline, far left → 0.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 9, clientX: 5000 });
    expect(fixture.bridge.scrubTo).toHaveBeenLastCalledWith(6);
    fireEvent.pointerUp(bar, { button: 0, pointerId: 9, clientX: 5000 });
    fireEvent.pointerDown(bar, { button: 0, pointerId: 10, clientX: 50 });
    expect(fixture.bridge.scrubTo).toHaveBeenLastCalledWith(0);
  });

  it("coalesces drags to one scrub per frame and commits the exact release position", () => {
    const { bar } = renderScrubBar({ actualEndTime: 6, playheadPosition: 0 });
    stubBarGeometry(bar, true);

    let rafId = 0;
    const scheduled: Array<{
      id: number;
      cb: FrameRequestCallback;
      cancelled: boolean;
    }> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const entry = { id: ++rafId, cb, cancelled: false };
      scheduled.push(entry);
      return entry.id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      const entry = scheduled.find((item) => item.id === id);
      if (entry) entry.cancelled = true;
    });

    // Down at the midpoint: 3s.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 7, clientX: 300 });
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(1);

    // First move schedules exactly one coalesced flush.
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 200 });
    expect(scheduled).toHaveLength(1);
    // A second move in the same frame reuses the pending flush instead of
    // scheduling another one.
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 150 });
    expect(scheduled).toHaveLength(1);
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(1);

    // The single flush carries the LATEST position, not the first move's:
    // (150-100)/400*6 = 0.75s.
    act(() => scheduled[0].cb(performance.now()));
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.scrubTo).toHaveBeenLastCalledWith(0.75);

    // Another move schedules a new frame; pointer up cancels it and commits
    // the exact release position through scrubTo + endScrubbing.
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 120 });
    expect(scheduled).toHaveLength(2);
    fireEvent.pointerUp(bar, { button: 0, pointerId: 7, clientX: 120 });
    expect(scheduled[1].cancelled).toBe(true);
    expect(bar.releasePointerCapture).toHaveBeenCalledWith(7);
    // (120-100)/400*6 = 0.3s (same float expression as the hook's math)
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(3);
    expect(fixture.bridge.scrubTo).toHaveBeenLastCalledWith(((120 - 100) / 400) * 6);
    expect(fixture.bridge.endScrubbing).toHaveBeenCalledTimes(1);

    // Even a stale cancelled flush must not scrub again (drag state cleared).
    act(() => scheduled[1].cb(performance.now()));
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(3);
    // Moves after the gesture ended are ignored.
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 480 });
    expect(fixture.bridge.scrubTo).toHaveBeenCalledTimes(3);
  });

  it("steps with arrow keys, Home and End through requestSeek with clamping", () => {
    const first = renderHook(() =>
      usePreviewScrubBar({ actualEndTime: 6, playheadPosition: 2 }),
    );

    const left = keyEvent("ArrowLeft");
    act(() => first.result.current.handleScrubKeyDown(left));
    expect(fixture.bridge.requestSeek).toHaveBeenLastCalledWith(2 - 1 / 30);
    expect(left.preventDefault).toHaveBeenCalledTimes(1);
    expect(left.stopPropagation).toHaveBeenCalledTimes(1);

    act(() => first.result.current.handleScrubKeyDown(keyEvent("ArrowRight", true)));
    expect(fixture.bridge.requestSeek).toHaveBeenLastCalledWith(3);

    act(() => first.result.current.handleScrubKeyDown(keyEvent("Home")));
    expect(fixture.bridge.requestSeek).toHaveBeenLastCalledWith(0);

    act(() => first.result.current.handleScrubKeyDown(keyEvent("End")));
    expect(fixture.bridge.requestSeek).toHaveBeenLastCalledWith(6);

    // Unhandled keys are ignored and left for other listeners.
    const unhandled = keyEvent("a");
    act(() => first.result.current.handleScrubKeyDown(unhandled));
    expect(unhandled.preventDefault).not.toHaveBeenCalled();
    expect(fixture.bridge.requestSeek).toHaveBeenCalledTimes(4);

    // Never seeks before 0…
    const fromStart = renderHook(() =>
      usePreviewScrubBar({ actualEndTime: 6, playheadPosition: 0 }),
    );
    act(() => fromStart.result.current.handleScrubKeyDown(keyEvent("ArrowLeft")));
    expect(fixture.bridge.requestSeek).toHaveBeenLastCalledWith(0);

    // …nor past the end: 6 + 1/30 clamps to 6.
    const nearEnd = renderHook(() =>
      usePreviewScrubBar({ actualEndTime: 6, playheadPosition: 6 }),
    );
    act(() => nearEnd.result.current.handleScrubKeyDown(keyEvent("ArrowRight")));
    expect(fixture.bridge.requestSeek).toHaveBeenLastCalledWith(6);
  });

  it("maps the skip buttons to ±5s relative seeks", () => {
    const { result } = renderHook(() =>
      usePreviewScrubBar({ actualEndTime: 6, playheadPosition: 2 }),
    );
    act(() => result.current.handleSkipBack());
    expect(fixture.bridge.requestSeekRelative).toHaveBeenLastCalledWith(-5);
    act(() => result.current.handleSkipForward());
    expect(fixture.bridge.requestSeekRelative).toHaveBeenLastCalledWith(5);
    expect(fixture.bridge.requestSeekRelative).toHaveBeenCalledTimes(2);
  });
});
