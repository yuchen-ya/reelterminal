/**
 * media.rename — project media DISPLAY-name renaming.
 *
 * Covered behavior:
 *  - the op changes only the display name; the source filename (name) keeps
 *    its import-time semantics and the file on disk is never touched (bytes
 *    are addressed by media id),
 *  - empty/blank/over-long display names are rejected with INVALID_PARAMS
 *    and the revision does not move,
 *  - unknown media ids fail NOT_FOUND,
 *  - timeline.query exposes displayName next to name so agent search and the
 *    GUI panel agree; items without displayName use the source filename,
 *  - the op translates to the same core media/rename action the GUI rename
 *    uses, so undo restores the display name.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { opToCoreActions } from "./ops";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import { mediaDisplayName } from "@reelterminal/core/types/project";
import type { Action } from "@reelterminal/core/types/actions";

describe("media.rename (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let mediaId: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("media-rename");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Rename" });
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    if (!imported.ok) throw new Error("import failed");
    mediaId = imported.value.mediaId;
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  async function mediaItem(id: string) {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("state failed");
    const item = state.value.project.mediaLibrary.items.find(
      (candidate) => candidate.id === id,
    );
    expect(item).toBeTruthy();
    return item!;
  }

  it("renames only the display name and keeps the source filename", async () => {
    const before = await mediaItem(mediaId);
    // A fresh import keeps source-filename semantics: no displayName yet.
    expect(before.displayName).toBeUndefined();

    const result = await facade["edit.apply"]({
      ops: [{ op: "media.rename", mediaId, displayName: "中文片头 v3" }],
    });
    expect(result.ok).toBe(true);

    const after = await mediaItem(mediaId);
    expect(after.displayName).toBe("中文片头 v3");
    // The source filename is untouched — relink/restore matching still works.
    expect(after.name).toBe(before.name);
    // Resolved display goes through the shared fallback helper.
    expect(mediaDisplayName(after)).toBe("中文片头 v3");
  });

  it("timeline.query exposes displayName next to name; unrenamed items omit it", async () => {
    const unrenamed = await facade["timeline.query"]({
      entityTypes: ["media"],
      fields: ["name", "displayName", "type"],
    });
    expect(unrenamed.ok).toBe(true);
    if (!unrenamed.ok) return;
    expect(unrenamed.value.items).toHaveLength(1);
    expect(unrenamed.value.items[0]!.data.displayName).toBeUndefined();

    const renamed = await facade["edit.apply"]({
      ops: [{ op: "media.rename", mediaId, displayName: "Renamed Shot" }],
    });
    expect(renamed.ok).toBe(true);

    const query = await facade["timeline.query"]({
      entityTypes: ["media"],
      fields: ["name", "displayName", "type"],
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.items).toHaveLength(1);
    expect(query.value.items[0]!.data).toMatchObject({
      name: (await mediaItem(mediaId)).name,
      displayName: "Renamed Shot",
    });
  });

  it("rejects blank and over-long names without moving the revision", async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    for (const displayName of ["", "   ", "x".repeat(121)]) {
      const r = await facade["edit.apply"]({
        ops: [{ op: "media.rename", mediaId, displayName }],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("INVALID_PARAMS");
    }

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
  });

  it("fails NOT_FOUND for an unknown media id", async () => {
    const r = await facade["edit.apply"]({
      ops: [
        { op: "media.rename", mediaId: "media-missing", displayName: "X" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("translates to the same core media/rename action the GUI uses", () => {
    const project = createEmptyProject("Translation");
    project.mediaLibrary.items.push({ id: "m1", name: "raw.mp4" } as never);

    const actions = opToCoreActions(
      { op: "media.rename", mediaId: "m1", displayName: "  DisplayName  " },
      project,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("media/rename");
    expect(actions[0]!.params).toMatchObject({
      mediaId: "m1",
      name: "DisplayName",
    });
  });
});

describe("media.rename undo (core action history)", () => {
  const seedProject = () => {
    const project = createEmptyProject("UndoRename");
    project.mediaLibrary.items.push({
      id: "media-1",
      name: "take-01.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 320,
        height: 180,
        frameRate: 10,
        codec: "h264",
        sampleRate: 0,
        channels: 0,
        fileSize: 10,
      },
      thumbnailUrl: null,
      waveformData: null,
    } as never);
    return project;
  };

  const mk = (type: string, params: Record<string, unknown>): Action => ({
    type,
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params,
  });

  it("the inverse of the first rename restores the source-filename fallback", async () => {
    const project = seedProject();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    // Items without displayName use the source filename.
    const first = await executor.execute(
      mk("media/rename", { mediaId: "media-1", name: "中文标题" }),
      project,
    );
    expect(first.success).toBe(true);
    let item = project.mediaLibrary.items[0]!;
    expect(item.displayName).toBe("中文标题");
    expect(item.name).toBe("take-01.mp4");

    const inverse = history.undo();
    expect(inverse?.type).toBe("media/rename");
    expect(inverse?.params).toMatchObject({
      mediaId: "media-1",
      name: "take-01.mp4",
    });
    await executor.execute(inverse!, project);
    item = project.mediaLibrary.items[0]!;
    expect(mediaDisplayName(item)).toBe("take-01.mp4");
    // The source filename itself was never rewritten by the rename.
    expect(item.name).toBe("take-01.mp4");
  });

  it("chained renames walk back through executor undo/redo", async () => {
    const project = seedProject();
    const executor = new ActionExecutor();

    await executor.execute(
      mk("media/rename", { mediaId: "media-1", name: "中文标题" }),
      project,
    );
    await executor.execute(
      mk("media/rename", { mediaId: "media-1", name: "旧标题" }),
      project,
    );
    expect(mediaDisplayName(project.mediaLibrary.items[0]!)).toBe("旧标题");

    const undo1 = await executor.undo(project);
    expect(undo1.success).toBe(true);
    expect(mediaDisplayName(project.mediaLibrary.items[0]!)).toBe("中文标题");

    const undo2 = await executor.undo(project);
    expect(undo2.success).toBe(true);
    expect(mediaDisplayName(project.mediaLibrary.items[0]!)).toBe("take-01.mp4");

    const redo = await executor.redo(project);
    expect(redo.success).toBe(true);
    expect(mediaDisplayName(project.mediaLibrary.items[0]!)).toBe("中文标题");
  });
});
