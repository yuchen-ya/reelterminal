import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampBoundsToViewport,
  FloatingWindow,
  type WindowBounds,
} from "./FloatingWindow";

// jsdom 24 has no PointerEvent; the drag/resize logic only needs MouseEvent
// fields plus pointerId, so a minimal subclass lets fireEvent.pointer* carry
// clientX/clientY/pointerId.
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

const VIEWPORT = { width: 1024, height: 768 };
const DEFAULT_BOUNDS: WindowBounds = { x: 100, y: 100, width: 400, height: 300 };

const originalInnerWidth = window.innerWidth;

afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: originalInnerWidth,
  });
});

function renderWindow(
  overrides: Partial<{
    title: ReactNode;
    bounds: WindowBounds;
    minSize: { width: number; height: number };
    maximized: boolean;
    minimized: boolean;
    children: ReactNode;
  }> = {},
) {
  const handlers = {
    onBoundsChange: vi.fn(),
    onMinimize: vi.fn(),
    onToggleMaximize: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <FloatingWindow
      title={overrides.title ?? "Agent"}
      bounds={overrides.bounds ?? DEFAULT_BOUNDS}
      minSize={overrides.minSize}
      maximized={overrides.maximized}
      minimized={overrides.minimized}
      {...handlers}
    >
      {overrides.children ?? <div>panel content</div>}
    </FloatingWindow>,
  );
  return handlers;
}

describe("FloatingWindow", () => {
  it("renders the title and children with a visible body", () => {
    renderWindow();

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("panel content")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-body").style.display).not.toBe(
      "none",
    );
  });

  it("portals into a provided container so themed shells keep their tokens", () => {
    const shell = document.createElement("div");
    shell.className = "reelterminal-desktop";
    document.body.appendChild(shell);
    try {
      render(
        <FloatingWindow
          title="Agent"
          bounds={DEFAULT_BOUNDS}
          onBoundsChange={vi.fn()}
          onMinimize={vi.fn()}
          onToggleMaximize={vi.fn()}
          onClose={vi.fn()}
          portalContainer={shell}
        >
          <div>panel content</div>
        </FloatingWindow>,
      );
      expect(shell.querySelector("[data-testid='floating-window']")).not.toBeNull();
      expect(screen.getByText("panel content").closest(".reelterminal-desktop")).toBe(shell);
    } finally {
      shell.remove();
    }
  });

  it("moves the window by dragging the titlebar", () => {
    const { onBoundsChange } = renderWindow();
    const titlebar = screen.getByTestId("floating-window-titlebar");

    fireEvent.pointerDown(titlebar, {
      button: 0,
      clientX: 500,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 560, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 560, clientY: 140, pointerId: 1 });

    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    expect(onBoundsChange).toHaveBeenCalledWith({
      x: 160,
      y: 140,
      width: 400,
      height: 300,
    });
  });

  it("resizes from the se corner", () => {
    const { onBoundsChange } = renderWindow();
    const handle = screen.getByTestId("floating-window-resize-se");

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 500,
      clientY: 400,
      pointerId: 2,
    });
    fireEvent.pointerMove(window, { clientX: 580, clientY: 450, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 580, clientY: 450, pointerId: 2 });

    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    expect(onBoundsChange).toHaveBeenCalledWith({
      x: 100,
      y: 100,
      width: 480,
      height: 350,
    });
  });

  it("clamps a resize to the minimum size", () => {
    const { onBoundsChange } = renderWindow();
    const handle = screen.getByTestId("floating-window-resize-se");

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 500,
      clientY: 400,
      pointerId: 3,
    });
    fireEvent.pointerMove(window, {
      clientX: -900,
      clientY: -900,
      pointerId: 3,
    });
    fireEvent.pointerUp(window, { clientX: -900, clientY: -900, pointerId: 3 });

    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    expect(onBoundsChange).toHaveBeenCalledWith({
      x: 100,
      y: 100,
      width: 320,
      height: 280,
    });
  });

  it("covers the viewport minus the margin when maximized and hides resize handles", () => {
    renderWindow({ maximized: true });

    const win = screen.getByTestId("floating-window");
    expect(win.style.width).toBe(`${window.innerWidth - 16}px`);
    expect(win.style.height).toBe(`${window.innerHeight - 16}px`);
    expect(win.style.left).toBe("8px");
    expect(win.style.top).toBe("8px");
    expect(screen.queryByTestId("floating-window-resize-se")).toBeNull();
  });

  it("keeps children mounted but hidden when minimized", () => {
    renderWindow({ minimized: true });

    expect(screen.getByText("panel content")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-body").style.display).toBe(
      "none",
    );
  });

  it("retracts out-of-viewport bounds into the viewport on mount", () => {
    const { onBoundsChange } = renderWindow({
      bounds: { x: 5000, y: 100, width: 400, height: 300 },
    });

    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    const next = onBoundsChange.mock.calls[0][0] as WindowBounds;
    expect(next).toEqual({ x: 616, y: 100, width: 400, height: 300 });
    expect(next.x).toBeLessThanOrEqual(window.innerWidth - 8 - next.width);
  });

  it("clamps bounds when the viewport shrinks", () => {
    const { onBoundsChange } = renderWindow();
    expect(onBoundsChange).not.toHaveBeenCalled();

    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 400,
    });
    fireEvent(window, new Event("resize"));

    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    expect(onBoundsChange).toHaveBeenCalledWith({
      x: 8,
      y: 100,
      width: 384,
      height: 300,
    });
  });

  it("calls onClose from the close button", () => {
    const { onClose } = renderWindow();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("clampBoundsToViewport", () => {
  it("shrinks a window larger than the viewport to fit", () => {
    expect(
      clampBoundsToViewport(
        { x: 0, y: 0, width: 2000, height: 1000 },
        undefined,
        VIEWPORT,
      ),
    ).toEqual({ x: 8, y: 8, width: 1008, height: 752 });
  });

  it("clamps x/y below the margin up to the margin", () => {
    expect(
      clampBoundsToViewport(
        { x: -50, y: -20, width: 400, height: 300 },
        undefined,
        VIEWPORT,
      ),
    ).toEqual({ x: 8, y: 8, width: 400, height: 300 });
  });

  it("enforces the default minimum size", () => {
    expect(
      clampBoundsToViewport(
        { x: 100, y: 100, width: 10, height: 10 },
        undefined,
        VIEWPORT,
      ),
    ).toEqual({ x: 100, y: 100, width: 320, height: 280 });
  });
});
