/**
 * Occlusion regression: with the agent session open, the floating window
 * (fixed z-[60]) must not cover the desktop collab strip — the strip's
 * right-side entries (`collab-agent-media-entry`, the agent-session toggle)
 * must stay reachable. jsdom cannot lay out, so the assertions compare the
 * window's inline-style rectangle against the strip rectangle the desktop
 * Edit page grid produces (viewport bottom minus collab row + timeline dock).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";

import { ExternalAgentFloatingWindow } from "./ExternalAgentFloatingWindow";
import { useUIStore, type PanelState } from "../../../stores/ui-store";

// The window geometry under test does not involve the panel content; stub
// the heavy container like the EditPage tests do.
vi.mock("./ExternalAgentPanelContainer", () => ({
  ExternalAgentPanelContainer: (): React.ReactElement => (
    <div data-testid="stub-agent-panel" />
  ),
}));

const VIEWPORT = { width: 1280, height: 720 };
/** Desktop Edit page bottom strip: collab row (h-8) + timeline dock (320). */
const BOTTOM_RESERVE = 32 + 320;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function stubViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    writable: true,
    configurable: true,
    value: height,
  });
}

function setExternalAgentPanel(overrides: Partial<PanelState> = {}): void {
  const panels = useUIStore.getState().panels;
  useUIStore.setState({
    panels: {
      ...panels,
      externalAgent: { ...panels.externalAgent, visible: true, ...overrides },
    },
  });
}

function windowRect(): Rect {
  const element = screen.getByTestId("floating-window");
  const style = element.style;
  return {
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top),
    right: Number.parseFloat(style.left) + Number.parseFloat(style.width),
    bottom: Number.parseFloat(style.top) + Number.parseFloat(style.height),
  };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function collabStripRect(viewportHeight: number): Rect {
  return {
    left: 0,
    top: viewportHeight - BOTTOM_RESERVE,
    right: VIEWPORT.width,
    bottom: viewportHeight,
  };
}

describe("ExternalAgentFloatingWindow default geometry (occlusion reserve)", () => {
  afterEach(() => {
    // Unmount before touching the store so the hide re-render stays in act.
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, "innerHeight", {
      writable: true,
      configurable: true,
      value: originalInnerHeight,
    });
    setExternalAgentPanel({
      visible: false,
      x: undefined,
      y: undefined,
      width: 400,
      height: 560,
      restoreBounds: null,
    });
  });

  it("keeps the never-dragged window above the collab strip that hosts the media entry", async () => {
    stubViewport(VIEWPORT.width, VIEWPORT.height);
    setExternalAgentPanel();

    // act: the lazy panel chunk settles and re-renders after mount.
    await act(async () => {
      render(<ExternalAgentFloatingWindow defaultBottomReserve={BOTTOM_RESERVE} />);
    });

    const rect = windowRect();
    const strip = collabStripRect(VIEWPORT.height);
    // The entry button lives at the strip's right edge, so a full-strip
    // non-intersection is the strict form of "entry stays clickable".
    expect(rect.bottom).toBeLessThanOrEqual(strip.top);
    expect(rectsIntersect(rect, strip)).toBe(false);
  });

  it("keeps the default geometry clear on a different viewport too", async () => {
    stubViewport(1152, 800);
    setExternalAgentPanel();

    await act(async () => {
      render(<ExternalAgentFloatingWindow defaultBottomReserve={BOTTOM_RESERVE} />);
    });

    const strip = {
      left: 0,
      top: 800 - BOTTOM_RESERVE,
      right: 1152,
      bottom: 800,
    };
    expect(rectsIntersect(windowRect(), strip)).toBe(false);
  });

  it("leaves dragged windows on their persisted bounds", async () => {
    stubViewport(VIEWPORT.width, VIEWPORT.height);
    // Fits the viewport (so the pre-existing viewport retract is a no-op)
    // but deliberately overlaps the strip: the user put it there, and the
    // occlusion reserve only reshapes the never-dragged default geometry.
    setExternalAgentPanel({ x: 400, y: 300, width: 400, height: 280 });

    await act(async () => {
      render(<ExternalAgentFloatingWindow defaultBottomReserve={BOTTOM_RESERVE} />);
    });

    expect(windowRect()).toEqual({ left: 400, top: 300, right: 800, bottom: 580 });
  });

  it("keeps the web-editor default sizing when no bottom strip is reserved", async () => {
    stubViewport(VIEWPORT.width, VIEWPORT.height);
    setExternalAgentPanel();

    await act(async () => {
      render(<ExternalAgentFloatingWindow />);
    });

    // Factory default: 400x560 at the top-right.
    expect(windowRect()).toEqual({
      left: VIEWPORT.width - 400 - 24,
      top: 72,
      right: VIEWPORT.width - 24,
      bottom: 72 + 560,
    });
  });
});
