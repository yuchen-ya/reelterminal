import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Project, ShapeClip, SVGClip, StickerClip } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useNotificationStore } from "../../../stores/notification-store";
import { resetProductPerfFlow } from "../../../performance/product-flow";
import { ShapeClipComponent } from "./ShapeClipComponent";

vi.mock("@reelterminal/ui", () => ({
  ToolcraftContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/icons/lucide-compat", () => ({ Shapes: () => null, FileCode: () => null, Smile: () => null }));
vi.mock("./GraphicsClipContextMenu", () => ({ useGraphicsClipContextMenuItems: () => [] }));
vi.mock("./AgentReferenceBadge", () => ({ AgentReferenceBadge: () => null }));
vi.mock("../ProjectMarkerBadge", () => ({ ProjectMarkerBadgeStack: () => null }));

type Commit = (clipId: string, time: number) => boolean | Promise<boolean>;
type TrimCommit = (clipId: string, edge: "left" | "right", time: number) => boolean | Promise<boolean>;
type GraphicClip = ShapeClip | SVGClip | StickerClip;
type GraphicKind = "shape" | "svg" | "sticker" | "emoji";

function graphicClip(type: GraphicKind): GraphicClip {
  const base = {
    id: `${type}-clip`,
    trackId: "graphics-track",
    startTime: 1,
    duration: 2,
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    keyframes: [],
  };
  if (type === "shape") {
    return { ...base, type, shapeType: "rectangle", style: { fill: { type: "solid", color: "#fff", opacity: 1 }, stroke: { color: "#000", width: 1, opacity: 1 } } } as ShapeClip;
  }
  if (type === "svg") {
    return { ...base, type, svgContent: "<svg/>", viewBox: { minX: 0, minY: 0, width: 1, height: 1 }, preserveAspectRatio: "xMidYMid" } as SVGClip;
  }
  return { ...base, type, imageUrl: "data:image/png;base64,AA==" } as StickerClip;
}

function setProject(clip: GraphicClip): void {
  const empty = createEmptyProject("Graphic gesture");
  const project = {
    ...empty,
    shapeClips: clip.type === "shape" ? [clip] : [],
    svgClips: clip.type === "svg" ? [clip] : [],
    stickerClips: clip.type === "sticker" || clip.type === "emoji" ? [clip] : [],
  } as Project;
  useProjectStore.setState({ projectRevision: 6, workspaceRevision: 6 });
  useProjectStore.setState({ project });
  useUIStore.setState({ snapSettings: { ...useUIStore.getState().snapSettings, enabled: false } });
}

function box(left = 0): DOMRect {
  return {
    x: left, y: 0, left, top: 0, right: left + 800, bottom: 48,
    width: 800, height: 48, toJSON: () => ({}),
  } as DOMRect;
}

function renderGraphic(type: GraphicKind, callbacks: { onMoveClip: Commit; onTrim: TrimCommit }) {
  const clip = graphicClip(type);
  setProject(clip);
  const result = render(
    <div data-testid="timeline-lane">
      <ShapeClipComponent
        shapeClip={clip}
        pixelsPerSecond={60}
        isSelected
        onSelect={() => undefined}
        onMoveClip={callbacks.onMoveClip}
        onTrim={callbacks.onTrim}
      />
    </div>,
  );
  const element = result.container.querySelector<HTMLElement>(`[data-live-editor-target-id='${type}-clip']`)!;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(box(60));
  vi.spyOn(element.parentElement!, "getBoundingClientRect").mockReturnValue(box());
  return { ...result, element };
}

afterEach(() => {
  cleanup();
  resetProductPerfFlow();
  useNotificationStore.getState().clearAll();
  useProjectStore.getState().createNewProject("Reset");
});

describe("ShapeClipComponent timeline gesture previews", () => {
  it.each(["shape", "svg", "sticker", "emoji"] as const)(
    "%s drag is transient and commits once on release",
    async (type) => {
      const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
      const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
      const { element } = renderGraphic(type, { onMoveClip, onTrim });

      act(() => fireEvent.mouseDown(element, { button: 0, clientX: 70, clientY: 10 }));
      act(() => fireEvent.mouseMove(window, { clientX: 100, clientY: 10 }));
      act(() => fireEvent.mouseMove(window, { clientX: 130, clientY: 10 }));

      expect(onMoveClip).not.toHaveBeenCalled();
      expect(useProjectStore.getState().projectRevision).toBe(7);
      expect(element.style.transform).toBe("translateX(120px)");

      act(() => fireEvent.mouseUp(window));
      await waitFor(() => expect(onMoveClip).toHaveBeenCalledTimes(1));
      expect(onMoveClip).toHaveBeenCalledWith(`${type}-clip`, 2);
    },
  );

  it.each(["shape", "svg", "sticker", "emoji"] as const)(
    "%s trim is transient and commits once on release",
    async (type) => {
      const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
      const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
      const { element } = renderGraphic(type, { onMoveClip, onTrim });
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
      expect(onTrim).toHaveBeenCalledWith(`${type}-clip`, "left", 2);
    },
  );

  it("cancels an SVG trim on Escape and restores its original bounds", () => {
    const onMoveClip = vi.fn<Commit>().mockResolvedValue(true);
    const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { element } = renderGraphic("svg", { onMoveClip, onTrim });
    const leftHandle = element.querySelector<HTMLElement>(".cursor-ew-resize")!;

    act(() => fireEvent.mouseDown(leftHandle, { button: 0, clientX: 60, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 120, clientY: 10 }));
    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    act(() => fireEvent.mouseUp(window));

    expect(onTrim).not.toHaveBeenCalled();
    expect(element.style.transform).toBe("translateX(60px)");
    expect(element.style.width).toBe("120px");
  });

  it("restores a failed final sticker move and reports it", async () => {
    const onMoveClip = vi.fn<Commit>().mockResolvedValue(false);
    const onTrim = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { element } = renderGraphic("sticker", { onMoveClip, onTrim });

    act(() => fireEvent.mouseDown(element, { button: 0, clientX: 70, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 130, clientY: 10 }));
    act(() => fireEvent.mouseUp(window));

    await waitFor(() => expect(useNotificationStore.getState().notifications).toHaveLength(1));
    expect(element.style.transform).toBe("translateX(60px)");
    expect(useProjectStore.getState().projectRevision).toBe(7);
  });
});
