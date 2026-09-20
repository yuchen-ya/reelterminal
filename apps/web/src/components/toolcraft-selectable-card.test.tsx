import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolcraftSelectableCard } from "@reelterminal/ui";

/**
 * Contract tests for ToolcraftSelectableCard's activation dispatch.
 *
 * The component consumes @reelterminal/ui source directly (same resolution as
 * production code). It lives in the web suite because packages/ui has no
 * test runner of its own (no vitest/RTL/jsdom devDependencies, no test
 * script, pnpm strict isolation), and installing dependencies is out of
 * scope for this fix.
 *
 * Regression context (F06): the previous internal contract fired the
 * consumer's onClick and then, unless preventDefault was called, the
 * consumer's onChange as well. Consumers that passed the same non-idempotent
 * handler to both props (a selection toggle) were invoked twice per
 * activation, netting zero. The fixed contract is mutually exclusive:
 * onClick presence suppresses onChange; onChange-only usage is unchanged.
 *
 * Note on keyboard/AT activation: Space keyup and accessibility APIs
 * (AXPress/AXToggle) all produce a native DOM click on this <button>, which
 * is exactly what these tests dispatch. jsdom does not implement keyboard
 * activation behavior, so the key-to-click synthesis itself is browser
 * behavior outside test scope.
 */
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
