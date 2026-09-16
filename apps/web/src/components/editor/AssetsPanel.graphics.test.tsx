import "../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngineStore } from "../../stores/engine-store";
import { useNotificationStore } from "../../stores/notification-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import { AssetsPanel } from "./AssetsPanel";

const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<image href="assets/embedded.png"/>' +
  '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/>' +
  "</svg>";
const SCRIPT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const EXTERNAL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/cat.png"/></svg>';

/**
 * Captures the dynamically created file input and hands it a file.
 *
 * jsdom's File lacks Blob.text(), so the "file" is a minimal stub exposing
 * the one member the import handler consumes.
 */
async function pickSvgFile(
  content: string,
  name: string,
): Promise<HTMLInputElement> {
  const file = { name, text: async () => content } as unknown as File;
  const captured: HTMLInputElement[] = [];
  const realCreateElement = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, "createElement")
    .mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const el = realCreateElement(tag, options);
      if (tag === "input") captured.push(el as HTMLInputElement);
      return el;
    }) as typeof document.createElement);

  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Import SVG File" }),
    );
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const input = captured[captured.length - 1];
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    fireEvent.change(input);
    return input;
  } finally {
    spy.mockRestore();
  }
}

describe("AssetsPanel graphics workflow", () => {
  beforeEach(() => {
    useEngineStore.getState().getGraphicsEngine()?.clearCache();
    useProjectStore.setState({
      hasOpenProject: true,
      project: createEmptyProject("Graphics workflow"),
    });
    useTimelineStore.setState({ playheadPosition: 2.25 });
    useUIStore.getState().clearSelection();
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    cleanup();
    useEngineStore.getState().getGraphicsEngine()?.clearCache();
    useUIStore.getState().clearSelection();
    useNotificationStore.getState().clearAll();
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("places a new shape at the playhead and opens it in the inspector", async () => {
    render(<AssetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));

    expect(
      screen.getByRole("button", { name: "Import & Add Sticker" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rectangle" }));

    await waitFor(() => {
      const shapes =
        useEngineStore.getState().getGraphicsEngine()?.getAllShapeClips() ?? [];
      expect(shapes).toHaveLength(1);
      expect(shapes[0]).toMatchObject({
        shapeType: "rectangle",
        startTime: 2.25,
      });
      expect(useUIStore.getState().getSelectedClipIds()).toEqual([shapes[0]?.id]);
    });
  });

  it("rejects an unsafe SVG import with an explicit error and no half import", async () => {
    const { container } = render(<AssetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));

    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;

    await pickSvgFile(
      SCRIPT_SVG,
      "unsafe.svg",
    );

    await waitFor(() => {
      const errors = useNotificationStore
        .getState()
        .notifications.filter((n) => n.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].title).toBe("SVG import rejected");
      expect(errors[0].message).toContain("<script>");
    });

    // No half import: no clip on the engine, no extra graphics track, and
    // nothing selected.
    expect(
      useEngineStore.getState().getGraphicsEngine()?.getAllSVGClips(),
    ).toHaveLength(0);
    expect(
      useProjectStore.getState().project.timeline.tracks.length,
    ).toBe(tracksBefore);
    expect(useUIStore.getState().getSelectedClipIds()).toEqual([]);
    expect(container).toBeInTheDocument();
  });

  it("rejects an SVG that references external resources", async () => {
    render(<AssetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));

    await pickSvgFile(
      EXTERNAL_SVG,
      "external.svg",
    );

    await waitFor(() => {
      const errors = useNotificationStore
        .getState()
        .notifications.filter((n) => n.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("external resources");
    });
    expect(
      useEngineStore.getState().getGraphicsEngine()?.getAllSVGClips(),
    ).toHaveLength(0);
  });

  it("imports a valid SVG (with a relative image reference) onto a new graphics track", async () => {
    render(<AssetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));

    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;

    await pickSvgFile(
      VALID_SVG,
      "logo.svg",
    );

    await waitFor(() => {
      const clips =
        useEngineStore.getState().getGraphicsEngine()?.getAllSVGClips() ?? [];
      expect(clips).toHaveLength(1);
      expect(clips[0]).toMatchObject({ type: "svg", startTime: 2.25 });
      expect(clips[0]?.svgContent).toContain('href="assets/embedded.png"');
    });

    // The rejection toast must not have fired for the valid file.
    expect(
      useNotificationStore.getState().notifications.filter(
        (n) => n.type === "error",
      ),
    ).toHaveLength(0);

    // A graphics track was created and the new clip is selected.
    expect(
      useProjectStore.getState().project.timeline.tracks.length,
    ).toBeGreaterThan(tracksBefore);
    const clipId =
      useEngineStore.getState().getGraphicsEngine()?.getAllSVGClips()[0]?.id;
    expect(useUIStore.getState().getSelectedClipIds()).toEqual(
      clipId ? [clipId] : [],
    );
  });

  it("keeps a live-revealed media target keyboard-focusable", () => {    const initial = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...initial,
        mediaLibrary: {
          ...initial.mediaLibrary,
          items: [
            {
              id: "media-focus",
              name: "focus.mp4",
              type: "video",
              fileHandle: null,
              blob: null,
              metadata: {
                duration: 1,
                width: 320,
                height: 180,
                frameRate: 30,
                codec: "h264",
                sampleRate: 0,
                channels: 0,
                fileSize: 1,
              },
              thumbnailUrl: null,
              waveformData: null,
            },
          ],
        },
      },
    });

    const { container } = render(<AssetsPanel />);
    const target = container.querySelector<HTMLElement>(
      '[data-live-media-id="media-focus"]',
    );
    expect(target).not.toBeNull();
    expect(target?.tabIndex).toBe(0);
  });
});
