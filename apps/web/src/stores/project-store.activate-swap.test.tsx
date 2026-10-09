/**
 * React-level contract for the active project store swap: components reading
 * useProjectStore must re-render when activateProjectStore installs a
 * different store — the mechanism behind read-only version previews
 * (docs/VERSION-NODES-UX.md 预览不会打断编辑) and workspace switches.
 */
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  activateProjectStore,
  createProjectStore,
  useProjectStore,
} from "./project-store";
import { createEmptyProject } from "./project/project-helpers";

function Probe(): React.JSX.Element {
  const { project } = useProjectStore();
  return <p data-testid="probe-name">{project.name}</p>;
}

describe("activateProjectStore", () => {
  it("re-renders useProjectStore components when the active store swaps", () => {
    const other = createProjectStore({ isForeground: false });
    other.getState().loadProject(createEmptyProject("Preview Store"));

    const { getByTestId } = render(<Probe />);
    expect(getByTestId("probe-name").textContent).not.toBe("Preview Store");

    act(() => {
      activateProjectStore(other);
    });

    expect(getByTestId("probe-name").textContent).toBe("Preview Store");
  });

  it("a throwing active-store listener cannot starve React subscribers", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = createProjectStore({ isForeground: false });
    other.getState().loadProject(createEmptyProject("Preview After Throw"));

    const { getByTestId } = render(<Probe />);

    // The throwing listener registers FIRST so an aborting forEach would
    // leave every later listener — including React's — unnotified.
    const throwingUnsubscribe = useProjectStore.subscribe(() => {
      throw new Error("boom during swap");
    });

    try {
      act(() => {
        activateProjectStore(other);
      });
      expect(getByTestId("probe-name").textContent).toBe("Preview After Throw");
      expect(consoleWarn).toHaveBeenCalled();
    } finally {
      throwingUnsubscribe();
      consoleWarn.mockRestore();
      act(() => {
        activateProjectStore(createProjectStore({ isForeground: true }));
      });
    }
  });
});
