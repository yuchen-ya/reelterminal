import { describe, it, expect } from "vitest";
import { ActionExecutor } from "../action-executor";
import type { Project } from "../../types/project";
import type { Action } from "../../types/actions";

function makeProject(): Project {
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 0,
      markers: [],
      subtitles: [],
      tracks: [
        { id: "tt", type: "text", name: "Text", clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false },
      ],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${type}`,
  timestamp: Date.now(),
  params,
});

const textClips = (p: Project) =>
  (p as unknown as { textClips?: Array<{ id: string; text: string }> }).textClips ?? [];

function textClip(id: string, text: string) {
  return {
    id,
    trackId: "tt",
    startTime: 0,
    duration: 3,
    text,
    style: {},
    transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, anchor: { x: 0.5, y: 0.5 }, rotation: 0, opacity: 1 },
    keyframes: [],
  };
}

describe("overlay handlers (project-authoritative)", () => {
  it("text/create appends to project.textClips and undoes", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    await executor.execute(act("text/create", { clip: textClip("x1", "hi") }), project);
    expect(textClips(project)).toHaveLength(1);
    expect(textClips(project)[0].text).toBe("hi");
    await executor.undo(project);
    expect(textClips(project)).toHaveLength(0);
  });

  it("text/update merges fields and undoes to the prior value", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    await executor.execute(act("text/create", { clip: textClip("x1", "hi") }), project);
    await executor.execute(act("text/update", { clipId: "x1", updates: { text: "bye" } }), project);
    expect(textClips(project)[0].text).toBe("bye");
    await executor.undo(project);
    expect(textClips(project)[0].text).toBe("hi");
  });

  it("text/remove deletes and undo restores the clip", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    await executor.execute(act("text/create", { clip: textClip("x1", "hi") }), project);
    await executor.execute(act("text/remove", { clipId: "x1" }), project);
    expect(textClips(project)).toHaveLength(0);
    await executor.undo(project);
    expect(textClips(project)).toHaveLength(1);
    expect(textClips(project)[0].id).toBe("x1");
  });

  it("text/update rejects an unknown clip", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    const res = await executor.execute(act("text/update", { clipId: "nope", updates: {} }), project);
    expect(res.success).toBe(false);
  });

  it("shape/create works through the same factory", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    await executor.execute(
      act("shape/create", { clip: { id: "s1", type: "shape", trackId: "tt", startTime: 0, duration: 2, transform: {}, keyframes: [], shapeType: "rectangle", style: {} } }),
      project,
    );
    const shapes = (project as unknown as { shapeClips?: unknown[] }).shapeClips ?? [];
    expect(shapes).toHaveLength(1);
  });
});

describe("overlay handlers reject unsafe SVG content", () => {
  const VALID_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const SCRIPT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const EXTERNAL_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>';

  const svgClip = (id: string, svgContent: string) => ({
    id,
    trackId: "tt",
    startTime: 0,
    duration: 2,
    type: "svg" as const,
    svgContent,
    viewBox: { minX: 0, minY: 0, width: 10, height: 10 },
    transform: {},
    keyframes: [],
  });

  const svgClips = (p: Project) =>
    ((p as unknown as { svgClips?: Array<{ id: string; svgContent: string }> }).svgClips ?? []);

  it("svg/create rejects script-bearing content with a coded error", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    const res = await executor.execute(
      act("svg/create", { clip: svgClip("sv1", SCRIPT_SVG) }),
      project,
    );
    expect(res.success).toBe(false);
    expect(svgClips(project)).toHaveLength(0);
  });

  it("svg/create rejects external references", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    const res = await executor.execute(
      act("svg/create", { clip: svgClip("sv2", EXTERNAL_SVG) }),
      project,
    );
    expect(res.success).toBe(false);
    expect(svgClips(project)).toHaveLength(0);
  });

  it("svg/create accepts valid content and undoes cleanly", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    const res = await executor.execute(
      act("svg/create", { clip: svgClip("sv3", VALID_SVG) }),
      project,
    );
    expect(res.success).toBe(true);
    expect(svgClips(project)).toHaveLength(1);
    await executor.undo(project);
    expect(svgClips(project)).toHaveLength(0);
  });

  it("svg/update rejects swapping in unsafe content and leaves the clip unchanged", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    await executor.execute(
      act("svg/create", { clip: svgClip("sv4", VALID_SVG) }),
      project,
    );
    const res = await executor.execute(
      act("svg/update", { clipId: "sv4", updates: { svgContent: SCRIPT_SVG } }),
      project,
    );
    expect(res.success).toBe(false);
    expect(svgClips(project)[0].svgContent).toBe(VALID_SVG);
  });
});
