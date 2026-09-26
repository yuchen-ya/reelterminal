/**
 * Contract for the desktop shortcut wiring: rendering the desktop shortcut
 * mount must attach the shared keyboard-shortcut service to the window, so
 * bindings like the arrow keys actually reach their handlers (the desktop
 * tree never mounted the hook and every shortcut stayed dead). Also guards
 * the defaultPrevented dedupe between the service and the desktop shell's
 * own undo/redo listener — one press must fire one action.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopKeyboardShortcuts } from "./DesktopKeyboardShortcuts";
import { useTimelineStore } from "../../stores/timeline-store";
import { useProjectStore } from "../../stores/project-store";

describe("DesktopKeyboardShortcuts", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
    useTimelineStore.getState().seekTo(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounting the desktop component dispatches window shortcuts (arrow keys seek)", () => {
    render(<DesktopKeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" }),
    );

    // frameForward = 1/30s from the playhead at 10s
    expect(useTimelineStore.getState().playheadPosition).toBeCloseTo(
      10 + 1 / 30,
      5,
    );
  });

  it("unmounting stops dispatching", () => {
    const { unmount } = render(<DesktopKeyboardShortcuts />);
    unmount();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" }),
    );

    expect(useTimelineStore.getState().playheadPosition).toBe(10);
  });

  it("does not fire when an earlier listener already consumed the key", () => {
    const prevent = (e: KeyboardEvent): void => e.preventDefault();
    // Registered before the component mounts → runs first on the shared
    // window target, exactly like the desktop shell's undo/redo handler.
    window.addEventListener("keydown", prevent);
    try {
      render(<DesktopKeyboardShortcuts />);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          code: "ArrowRight",
          cancelable: true,
        }),
      );

      expect(useTimelineStore.getState().playheadPosition).toBe(10);
    } finally {
      window.removeEventListener("keydown", prevent);
    }
  });
});
