import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolcraftSelectableCard } from "@reelterminal/ui";

/** Verifies single callback dispatch for selectable-card activation. */
describe("ToolcraftSelectableCard activation dispatch", () => {
  it("dispatches only onClick once when both onClick and onChange are given", () => {
    const onClick = vi.fn();
    const onChange = vi.fn();
    render(
      <ToolcraftSelectableCard label="row" onClick={onClick} onChange={onChange}>
        content
      </ToolcraftSelectableCard>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "row" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not double-invoke a shared toggle handler (F06 regression)", () => {
    const toggle = vi.fn();
    render(
      <ToolcraftSelectableCard label="row" onClick={toggle} onChange={toggle} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "row" }));

    // Under the pre-fix double dispatch this was 2 (add + remove netting zero).
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("keeps onChange-only behavior: exactly one activation per click", () => {
    const onChange = vi.fn();
    render(<ToolcraftSelectableCard label="row" onChange={onChange} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "row" }));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps onClick-only behavior", () => {
    const onClick = vi.fn();
    render(<ToolcraftSelectableCard label="row" onClick={onClick} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "row" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still honors preventDefault from an inner handler for onChange-only usage", () => {
    const onChange = vi.fn();
    render(
      <ToolcraftSelectableCard label="row" onChange={onChange}>
        <span data-testid="inner" onClick={(event) => event.preventDefault()} />
      </ToolcraftSelectableCard>,
    );

    fireEvent.click(screen.getByTestId("inner"));

    expect(onChange).not.toHaveBeenCalled();
  });
});
