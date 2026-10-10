// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

import { SelectionTransformOverlay } from "./SelectionTransformOverlay";
import type { HandlePosition } from "./types";

const RESIZE_CURSORS: HandlePosition[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

type OverlayProps = ComponentProps<typeof SelectionTransformOverlay>;

function makeProps(overrides: Partial<OverlayProps> = {}): OverlayProps {
  return {
    bounds: { x: 12, y: 34, width: 200, height: 100 },
    lockAspectRatio: true,
    theme: "primary",
    moveTitle: "Drag to move",
    onToggleLock: vi.fn(),
    onMoveHandleMouseDown: vi.fn(),
    onHandleMouseDown: vi.fn(),
    ...overrides,
  };
}

function renderOverlay(props: OverlayProps = makeProps()) {
  return render(<SelectionTransformOverlay {...props} />);
}

describe("SelectionTransformOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the positioned container with move handle, lock toggle and all 8 resize handles", () => {
    const props = makeProps();
    const { container } = renderOverlay(props);
    const root = container.firstElementChild as HTMLElement;

    expect(root.className).toBe("absolute pointer-events-none");
    expect(root.style.left).toBe("12px");
    expect(root.style.top).toBe("34px");
    expect(root.style.width).toBe("200px");
    expect(root.style.height).toBe("100px");

    // Center move handle carries the caller's title and mousedown handler.
    const moveHandle = screen.getByTitle("Drag to move");
    expect(moveHandle.className).toContain("cursor-move");
    fireEvent.mouseDown(moveHandle);
    expect(props.onMoveHandleMouseDown).toHaveBeenCalledTimes(1);

    // One resize handle per direction, nothing more.
    for (const handle of RESIZE_CURSORS) {
      expect(root.querySelector(`.cursor-${handle}-resize`)).toBeTruthy();
    }
    expect(root.querySelectorAll("[class*='-resize']")).toHaveLength(8);
  });

  it("reports which resize handle went down as the second mousedown argument", () => {
    const onHandleMouseDown = vi.fn();
    const { container } = renderOverlay(makeProps({ onHandleMouseDown }));
    const root = container.firstElementChild as HTMLElement;

    fireEvent.mouseDown(root.querySelector(".cursor-nw-resize")!);
    fireEvent.mouseDown(root.querySelector(".cursor-se-resize")!);
    fireEvent.mouseDown(root.querySelector(".cursor-w-resize")!);

    expect(onHandleMouseDown).toHaveBeenCalledTimes(3);
    expect(onHandleMouseDown.mock.calls[0][1]).toBe("nw");
    expect(onHandleMouseDown.mock.calls[1][1]).toBe("se");
    expect(onHandleMouseDown.mock.calls[2][1]).toBe("w");
  });

  it("shows the lock state text and toggles the lock through onToggleLock", () => {
    const lockedProps = makeProps({ lockAspectRatio: true });
    const { container } = renderOverlay(lockedProps);

    const lockedButton = screen.getByText("🔒 Locked").closest("button");
    expect(lockedButton).toBeTruthy();
    // Locked state uses the theme accent on the pill button.
    expect(
      (container.firstElementChild as HTMLElement).querySelector(
        "button[class*='bg-primary']",
      ),
    ).toBeTruthy();
    expect(lockedButton!.getAttribute("aria-label")).toBe(
      "Unlock aspect ratio",
    );

    fireEvent.click(lockedButton!);
    expect(lockedProps.onToggleLock).toHaveBeenCalledTimes(1);
    cleanup();

    const freeProps = makeProps({ lockAspectRatio: false });
    renderOverlay(freeProps);

    expect(screen.getByText("🔓 Free")).toBeTruthy();
    const freeButton = screen.getByText("🔓 Free").closest("button")!;
    expect(freeButton.className).toContain("bg-background-tertiary");
    expect(freeButton.getAttribute("aria-label")).toBe("Lock aspect ratio");

    fireEvent.click(freeButton);
    expect(freeProps.onToggleLock).toHaveBeenCalledTimes(1);
  });

  it("renders the primary and cyan accent palettes for the two callers", () => {
    const primary = renderOverlay(makeProps({ theme: "primary" }));
    const primaryRoot = primary.container.firstElementChild as HTMLElement;
    const primaryBorder = primaryRoot.querySelector(".border-primary");
    expect(primaryBorder).toBeTruthy();
    expect(primaryBorder?.className).toContain("border-2");
    expect(primaryRoot.querySelector("[class*='bg-primary/80']")).toBeTruthy();
    expect(primaryRoot.querySelector("[class*='hover:bg-primary']")).toBeTruthy();
    expect(primaryRoot.querySelector("[class*='border-cyan-500']")).toBeNull();
    cleanup();

    const cyan = renderOverlay(
      makeProps({ theme: "cyan", moveTitle: "Drag to move text" }),
    );
    const cyanRoot = cyan.container.firstElementChild as HTMLElement;
    const cyanBorder = cyanRoot.querySelector(".border-cyan-500");
    expect(cyanBorder).toBeTruthy();
    expect(cyanBorder?.className).toContain("border-2");
    expect(cyanRoot.querySelector("[class*='bg-cyan-500/80']")).toBeTruthy();
    expect(
      cyanRoot.querySelector("[class*='hover:bg-cyan-500']"),
    ).toBeTruthy();
    expect(cyanRoot.querySelector("[class*='border-primary']")).toBeNull();
    expect(screen.getByTitle("Drag to move text")).toBeTruthy();
  });
});
