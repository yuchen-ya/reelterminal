import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHoverTip } from "./task-tooltip";

afterEach(() => {
  cleanup();
});

/** Minimal consumer: one bound button, the tip node rendered inside the card root. */
function TipHarness() {
  const { tipNode, bindTip } = useHoverTip();
  return (
    <div>
      <button
        type="button"
        data-testid="tip-trigger"
        {...bindTip("翠绿动作行", "浅灰副文行")}
      >
        触发
      </button>
      {tipNode}
    </div>
  );
}

describe("useHoverTip", () => {
  it("shows both tip lines immediately on mouseEnter without any timer", () => {
    render(<TipHarness />);
    // No tip before hover: the native ~1s title delay is gone by construction.
    expect(screen.queryByText("翠绿动作行")).toBeNull();

    fireEvent.mouseEnter(screen.getByTestId("tip-trigger"));

    // Asserted synchronously — no timers advanced, nothing awaited.
    const title = screen.getByText("翠绿动作行");
    expect(title.tagName).toBe("STRONG");
    expect(title.className).toContain("text-accent");
    const detail = screen.getByText("浅灰副文行");
    expect(detail.className).toContain("text-fg-2");
    // Fixed-position overlay element exists for the active tip.
    expect(title.closest(".pointer-events-none.fixed")).not.toBeNull();
  });

  it("hides the tip on mouseLeave", () => {
    render(<TipHarness />);
    const trigger = screen.getByTestId("tip-trigger");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByText("翠绿动作行")).toBeTruthy();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByText("翠绿动作行")).toBeNull();
    expect(screen.queryByText("浅灰副文行")).toBeNull();
  });

  it("hides the tip via onClickCapture after a click", () => {
    render(<TipHarness />);
    const trigger = screen.getByTestId("tip-trigger");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByText("翠绿动作行")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByText("翠绿动作行")).toBeNull();
  });
});
