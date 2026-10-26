/**
 * Contract for the desktop shortcut wiring: rendering the desktop shortcut
 * mount must attach the shared keyboard-shortcut service to the window, so
 * bindings like the arrow keys actually reach their handlers (the desktop
 * tree never mounted the hook and every shortcut stayed dead). Also guards
 * the defaultPrevented dedupe between the service and the desktop shell's
 * own undo/redo listener — one press must fire one action.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopKeyboardShortcuts } from "./DesktopKeyboardShortcuts";
import { useTimelineStore } from "../../stores/timeline-store";
import { useProjectStore } from "../../stores/project-store";

describe("DesktopKeyboardShortcuts", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
    // Frame steps run through the playback bridge, which clamps to the
    // timeline end on the project's frame grid; an empty project (duration 0)
    // must not step anywhere.
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        timeline: { ...state.project.timeline, duration: 60 },
      },
    }));
    useTimelineStore.getState().seekTo(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounting the desktop component dispatches window shortcuts (arrow keys seek)", async () => {
    render(<DesktopKeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" }),
    );

    // The unified seek commits through the playback bridge (master clock +
    // store), so the store update lands asynchronously.
    await waitFor(() =>
      expect(useTimelineStore.getState().playheadPosition).toBeCloseTo(
        10 + 1 / 30,
        5,
      ),
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
