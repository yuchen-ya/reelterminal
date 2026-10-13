import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Project, TextClip } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useNotificationStore } from "../../../stores/notification-store";
import { resetProductPerfFlow } from "../../../performance/product-flow";
import { TextClipComponent } from "./TextClipComponent";

vi.mock("@reelterminal/ui", () => ({
  ToolcraftContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/icons/lucide-compat", () => ({ Type: () => null }));
vi.mock("./GraphicsClipContextMenu", () => ({ useGraphicsClipContextMenuItems: () => [] }));
vi.mock("./AgentReferenceBadge", () => ({ AgentReferenceBadge: () => null }));
vi.mock("../ProjectMarkerBadge", () => ({ ProjectMarkerBadgeStack: () => null }));

type Commit = (clipId: string, time: number) => boolean | Promise<boolean>;
type TrimCommit = (clipId: string, edge: "left" | "right", time: number) => boolean | Promise<boolean>;

function textClip(): TextClip {
  return {
    id: "text-clip",
    trackId: "text-track",
    startTime: 1,
    duration: 2,
    text: "Text",
    style: {
      fontFamily: "Arial",
      fontSize: 24,
      fontWeight: 400,
      fontStyle: "normal",
      color: "#fff",
      textAlign: "left",
      verticalAlign: "middle",
      lineHeight: 1,
      letterSpacing: 0,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    keyframes: [],
  } as TextClip;
}

function setProject(clip: TextClip): void {
  const empty = createEmptyProject("Text gesture");
  useProjectStore.setState({
    workspaceRevision: 6,
    projectRevision: 6,
  });
  useProjectStore.setState({
    project: { ...empty, textClips: [clip] } as Project,
  });
  useUIStore.setState({ snapSettings: { ...useUIStore.getState().snapSettings, enabled: false } });
}

function box(left = 0): DOMRect {
  return {
    x: left, y: 0, left, top: 0, right: left + 800, bottom: 48,
    width: 800, height: 48, toJSON: () => ({}),
  } as DOMRect;
}

function renderTextClip(callbacks: { onMoveClip: Commit; onTrim: TrimCommit }) {
  setProject(textClip());
  const result = render(
    <div data-testid="timeline-lane">
      <TextClipComponent
        textClip={textClip()}
        pixelsPerSecond={60}
        isSelected
        onSelect={() => undefined}
        onMoveClip={callbacks.onMoveClip}
        onTrim={callbacks.onTrim}
      />
    </div>,
  );
  const element = result.container.querySelector<HTMLElement>("[data-live-editor-target-id='text-clip']")!;
  vi.spyOn(element.parentElement!, "getBoundingClientRect").mockReturnValue(box());
  return { ...result, element };
}

afterEach(() => {
  cleanup();
  resetProductPerfFlow();
  useNotificationStore.getState().clearAll();
  useProjectStore.getState().createNewProject("Reset");
});

describe("TextClipComponent timeline gesture previews", () => {
  it("keeps text dragging transient and commits one snapped start time on release", async () => {
    const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
    const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { element } = renderTextClip({ onMoveClip, onTrim });

    act(() => fireEvent.mouseDown(element, { button: 0, clientX: 70, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 100, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 130, clientY: 10 }));

    expect(onMoveClip).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projectRevision).toBe(7);
    expect(element.style.transform).toBe("translateX(120px)");

    act(() => fireEvent.mouseUp(window));
    await waitFor(() => expect(onMoveClip).toHaveBeenCalledTimes(1));
    expect(onMoveClip).toHaveBeenCalledWith("text-clip", 2);
  });

  it.each(["escape", "blur", "unmount"] as const)(
    "cancels a text drag on %s without committing",
    (cancelBy) => {
      const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
      const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
      const { element, unmount } = renderTextClip({ onMoveClip, onTrim });

      act(() => fireEvent.mouseDown(element, { button: 0, clientX: 70, clientY: 10 }));
      act(() => fireEvent.mouseMove(window, { clientX: 130, clientY: 10 }));
      if (cancelBy === "escape") act(() => fireEvent.keyDown(window, { key: "Escape" }));
      else if (cancelBy === "blur") act(() => fireEvent.blur(window));
      else unmount();
      act(() => fireEvent.mouseUp(window));

      expect(onMoveClip).not.toHaveBeenCalled();
      if (cancelBy !== "unmount") expect(element.style.transform).toBe("translateX(60px)");
    },
  );

  it("previews text trimming locally and commits once after release", async () => {
    const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
    const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { element } = renderTextClip({ onMoveClip, onTrim });
    const leftHandle = element.querySelector<HTMLElement>(".cursor-ew-resize")!;

    act(() => fireEvent.mouseDown(leftHandle, { button: 0, clientX: 60, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 90, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 120, clientY: 10 }));

    expect(onTrim).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projectRevision).toBe(7);
    expect(element.style.transform).toBe("translateX(120px)");
    expect(element.style.width).toBe("60px");

    act(() => fireEvent.mouseUp(window));
    await waitFor(() => expect(onTrim).toHaveBeenCalledTimes(1));
    expect(onTrim).toHaveBeenCalledWith("text-clip", "left", 2);
  });

  it("cancels text trimming on blur and restores the original bounds", () => {
    const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
    const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { element } = renderTextClip({ onMoveClip, onTrim });
    const leftHandle = element.querySelector<HTMLElement>(".cursor-ew-resize")!;

    act(() => fireEvent.mouseDown(leftHandle, { button: 0, clientX: 60, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 90, clientY: 10 }));
    act(() => fireEvent.blur(window));
    act(() => fireEvent.mouseUp(window));

    expect(onTrim).not.toHaveBeenCalled();
    expect(element.style.transform).toBe("translateX(60px)");
    expect(element.style.width).toBe("120px");
  });

  it("restores the text preview and reports a failed final move", async () => {
    const onMoveClip = vi.fn<Commit>().mockResolvedValue(false);
    const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { element } = renderTextClip({ onMoveClip, onTrim });

    act(() => fireEvent.mouseDown(element, { button: 0, clientX: 70, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 130, clientY: 10 }));
    act(() => fireEvent.mouseUp(window));

    await waitFor(() => expect(useNotificationStore.getState().notifications).toHaveLength(1));
    expect(element.style.transform).toBe("translateX(60px)");
    expect(useProjectStore.getState().projectRevision).toBe(7);
  });
});
