import { describe, expect, it } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import { InverseActionGenerator } from "./inverse-action-generator";
import { ActionValidator } from "./action-validator";
import type { Action } from "../types/actions";
import type { Project, WorkAsset, WorkAssetMember } from "../types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: { duration: 0, tracks: [] },
    mediaLibrary: {
      items: [
        {
          id: "m1",
          name: "take-01.mp4",
          type: "video",
          fileHandle: null,
          blob: null,
          metadata: {
            duration: 30,
            width: 1920,
            height: 1080,
            frameRate: 30,
            codec: "h264",
            sampleRate: 48000,
            channels: 2,
            fileSize: 1024,
          },
          thumbnailUrl: null,
          waveformData: null,
        },
      ],
    },
    ...overrides,
  } as unknown as Project;
}

function makeAsset(overrides: Partial<WorkAsset> = {}): WorkAsset {
  return {
    schemaVersion: 1,
    id: "wa-1",
    kind: "single",
    name: "Hero trim",
    sourceMediaId: "m1",
    sourceRange: { inSec: 2, outSec: 6 },
    clipSnapshot: {
      duration: 4,
      inPoint: 2,
      outPoint: 6,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
      speed: 2,
      stabilization: { enabled: true, strength: 0.5, cropMode: "auto" },
    },
    unsupportedParams: [
      {
        field: "stabilization.profile",
        reason: "analysis artifact; recomputed on instantiate",
      },
    ],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function action(type: string, params: unknown): Action {
  return {
    type,
    id: `a-${Math.random()}`,
    timestamp: Date.now(),
    params: params as Record<string, unknown>,
  };
}

/** Assigns the read-only Project field in tests through a mutable view. */
function withAssets(
  project: Project,
  assets: WorkAsset[],
): Project {
  (project as { workAssets?: WorkAsset[] }).workAssets = assets;
  return project;
}

describe("workAsset/create", () => {
  it("appends the asset and is undoable and redoable", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();

    const result = await executor.execute(
      action("workAsset/create", { asset: makeAsset() }),
      project,
    );
    expect(result.success).toBe(true);
    expect(project.workAssets).toHaveLength(1);
    expect(project.workAssets?.[0]?.id).toBe("wa-1");
    expect(project.workAssets?.[0]?.name).toBe("Hero trim");

    await executor.undo(project);
    expect(project.workAssets).toHaveLength(0);

    await executor.redo(project);
    expect(project.workAssets).toHaveLength(1);
    expect(project.workAssets?.[0]?.id).toBe("wa-1");
  });

  it("stores a clone so later edits to the minted asset cannot leak in", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    const asset = makeAsset();

    await executor.execute(action("workAsset/create", { asset }), project);
    (asset.clipSnapshot as { speed?: number }).speed = 99;

    expect(project.workAssets?.[0]?.clipSnapshot?.speed).toBe(2);
  });

  it("allows two assets with the same name — names are not unique keys", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();

    await executor.execute(
      action("workAsset/create", { asset: makeAsset() }),
      project,
    );
    const second = await executor.execute(
      action("workAsset/create", {
        asset: makeAsset({ id: "wa-2", name: "Hero trim" }),
      }),
      project,
    );

    expect(second.success).toBe(true);
    expect(project.workAssets?.map((a) => a.id)).toEqual(["wa-1", "wa-2"]);
  });

  it("rejects a duplicate id", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    await executor.execute(action("workAsset/create", { asset: makeAsset() }), project);

    const result = await executor.execute(
      action("workAsset/create", { asset: makeAsset() }),
      project,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("already exists");
  });

  it("requires the source media to exist at create time", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();

    const result = await executor.execute(
      action("workAsset/create", {
        asset: makeAsset({ sourceMediaId: "missing-media" }),
      }),
      project,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("not found");
    expect(project.workAssets).toBeUndefined();
  });

  it.each([
    ["kind", makeAsset({ kind: "multi" as WorkAsset["kind"] }), "multi-clip"],
    [
      "sourceRange",
      makeAsset({ sourceRange: { inSec: 5, outSec: 2 } }),
      "outSec must be greater",
    ],
    ["empty name", makeAsset({ name: "   " }), "name is required"],
    [
      "schemaVersion",
      makeAsset({ schemaVersion: 2 as unknown as 1 }),
      "schemaVersion",
    ],
  ])("rejects an asset with an invalid %s", async (_label, asset, message) => {
    const executor = new ActionExecutor();
    const project = makeProject();

    const result = await executor.execute(
      action("workAsset/create", { asset }),
      project,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(message);
  });

  it("rejects a structurally invalid clipSnapshot", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();

    const result = await executor.execute(
      action("workAsset/create", {
        asset: makeAsset({
          clipSnapshot: {
            duration: -1,
            inPoint: 2,
            outPoint: 1,
            effects: "nope",
            audioEffects: [],
            keyframes: [],
            transform: null,
            volume: 1,
          } as unknown as WorkAsset["clipSnapshot"],
        }),
      }),
      project,
    );
    expect(result.success).toBe(false);
    const messages = result.error?.message ?? "";
    expect(messages).toContain("duration");
    expect(messages).toContain("outPoint");
    expect(messages).toContain("effects");
    expect(messages).toContain("transform");
  });
});

describe("workAsset/create kind multi", () => {
  const makeMember = (
    overrides: Partial<WorkAssetMember> = {},
  ): WorkAssetMember => ({
    memberId: "m-1",
    mediaId: "m1",
    sourceRange: { inSec: 2, outSec: 6 },
    relativeStart: 0,
    lane: { trackType: "video", laneOffset: 0 },
    snapshot: {
      duration: 4,
      inPoint: 2,
      outPoint: 6,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    },
    ...overrides,
  });

  const makeMultiAsset = (overrides: Partial<WorkAsset> = {}): WorkAsset =>
    makeAsset({
      kind: "multi",
      name: "Composite",
      clipSnapshot: undefined,
      members: [makeMember()],
      unsupportedParams: [],
      ...overrides,
    }) as WorkAsset;

  it("accepts a well-formed multi asset through validator and executor", async () => {
    const asset = makeMultiAsset({
      members: [
        makeMember(),
        makeMember({
          memberId: "m-2",
          mediaId: "m1",
          relativeStart: 1.5,
          lane: { trackType: "audio", laneOffset: 0 },
        }),
      ],
      transitions: [
        {
          fromMemberId: "m-1",
          toMemberId: "m-2",
          type: "crossfade",
          duration: 0.5,
          params: {},
        },
      ],
    });
    const validation = new ActionValidator().validate(
      action("workAsset/create", { asset }),
      makeProject(),
    );
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const executor = new ActionExecutor();
    const project = makeProject();
    const result = await executor.execute(
      action("workAsset/create", { asset }),
      project,
    );
    expect(result.success).toBe(true);
    expect(project.workAssets?.[0]?.kind).toBe("multi");
  });

  it("rejects a multi asset that carries a single-clip snapshot", async () => {
    const executor = new ActionExecutor();
    const result = await executor.execute(
      action("workAsset/create", {
        asset: makeMultiAsset({ clipSnapshot: makeAsset().clipSnapshot }),
      }),
      makeProject(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("clipSnapshot");
  });

  it("rejects a single asset that carries a members array", async () => {
    const executor = new ActionExecutor();
    const result = await executor.execute(
      action("workAsset/create", {
        asset: makeAsset({ members: [makeMember()] }),
      }),
      makeProject(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('kind "single" must not carry');
  });

  it("rejects duplicate memberIds, bad lanes, negative relativeStart, and malformed member snapshots", async () => {
    const cases: Array<[string, WorkAsset, string]> = [
      [
        "duplicate memberId",
        makeMultiAsset({
          members: [makeMember(), makeMember({ memberId: "m-1" })],
        }),
        "not unique",
      ],
      [
        "bad lane trackType",
        makeMultiAsset({
          members: [
            makeMember({ lane: { trackType: "text" as never, laneOffset: 0 } }),
          ],
        }),
        "trackType",
      ],
      [
        "bad lane offset",
        makeMultiAsset({
          members: [makeMember({ lane: { trackType: "video", laneOffset: 1.5 } })],
        }),
        "laneOffset",
      ],
      [
        "negative relativeStart",
        makeMultiAsset({ members: [makeMember({ relativeStart: -0.5 })] }),
        "relativeStart",
      ],
      [
        "member range out <= in",
        makeMultiAsset({
          members: [makeMember({ sourceRange: { inSec: 6, outSec: 2 } })],
        }),
        "greater than inSec",
      ],
      [
        "member snapshot malformed",
        makeMultiAsset({
          members: [
            makeMember({
              snapshot: {
                ...(makeMember().snapshot as object),
                speed: 0,
              } as WorkAssetMember["snapshot"],
            }),
          ],
        }),
        "speed",
      ],
      [
        "member mediaId empty",
        makeMultiAsset({ members: [makeMember({ mediaId: "" })] }),
        "mediaId is required",
      ],
    ];
    for (const [label, asset, message] of cases) {
      const executor = new ActionExecutor();
      const result = await executor.execute(
        action("workAsset/create", { asset }),
        makeProject(),
      );
      expect(result.success, label).toBe(false);
      expect(result.error?.message, label).toContain(message);
    }
  });

  it("rejects more members than the 64 cap", async () => {
    const members = Array.from({ length: 65 }, (_, index) =>
      makeMember({ memberId: `m-${index}` }),
    );
    const executor = new ActionExecutor();
    const result = await executor.execute(
      action("workAsset/create", {
        asset: makeMultiAsset({
          members: members as unknown as WorkAssetMember[],
        }),
      }),
      makeProject(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("at most 64 members");
  });

  it("checks member media existence at create time but not at restore time", async () => {
    const executor = new ActionExecutor();
    const asset = makeMultiAsset({
      members: [makeMember({ mediaId: "deleted-media" })],
    });

    const create = await executor.execute(
      action("workAsset/create", { asset }),
      makeProject(),
    );
    expect(create.success).toBe(false);
    expect(create.error?.message).toContain("Member 0 media deleted-media not found");

    const restoreExecutor = new ActionExecutor();
    const restoreProject = makeProject();
    const restore = await restoreExecutor.execute(
      action("workAsset/restore", { asset }),
      restoreProject,
    );
    expect(restore.success).toBe(true);
    expect(restoreProject.workAssets?.[0]?.kind).toBe("multi");
  });
});

describe("workAsset/restore", () => {
  it("is valid even when the source media no longer exists", async () => {
    // A delete of the source media can be undone AFTER the work asset was
    // removed: restoring the asset must not require the media to be present.
    const executor = new ActionExecutor();
    const project = makeProject();

    const result = await executor.execute(
      action("workAsset/restore", {
        asset: makeAsset({ sourceMediaId: "deleted-media" }),
      }),
      project,
    );
    expect(result.success).toBe(true);
    expect(project.workAssets).toHaveLength(1);
    expect(project.workAssets?.[0]?.sourceMediaId).toBe("deleted-media");
  });

  it("is idempotent on repeated apply (redo replay)", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();

    await executor.execute(
      action("workAsset/restore", { asset: makeAsset() }),
      project,
    );
    await executor.execute(
      action("workAsset/restore", { asset: makeAsset() }),
      project,
    );

    expect(project.workAssets).toHaveLength(1);
  });
});

describe("workAsset/delete", () => {
  it("removes the asset; undo restores the exact entry", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    withAssets(project, [makeAsset()]);
    const before = JSON.stringify(project.workAssets);

    const result = await executor.execute(
      action("workAsset/delete", { workAssetId: "wa-1" }),
      project,
    );
    expect(result.success).toBe(true);
    expect(project.workAssets).toHaveLength(0);

    await executor.undo(project);
    expect(JSON.stringify(project.workAssets)).toBe(before);
  });

  it("delete → undo → redo keeps the entry gone", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    withAssets(project, [makeAsset()]);

    await executor.execute(action("workAsset/delete", { workAssetId: "wa-1" }), project);
    await executor.undo(project);
    expect(project.workAssets).toHaveLength(1);
    await executor.redo(project);
    expect(project.workAssets).toHaveLength(0);
  });

  it("supports a missing-source asset cycle: delete it, then undo past a media removal", async () => {
    // R2 scenario: media deleted first (asset in missingSource state), the
    // asset deleted afterwards, and its restore stays valid without media.
    const executor = new ActionExecutor();
    const project = makeProject();
    withAssets(project, [makeAsset({ sourceMediaId: "deleted-media" })]);

    await executor.execute(action("workAsset/delete", { workAssetId: "wa-1" }), project);
    expect(project.workAssets).toHaveLength(0);

    const restore = new ActionValidator().validate(
      action("workAsset/restore", {
        asset: makeAsset({ sourceMediaId: "deleted-media" }),
      }),
      makeProject(),
    );
    expect(restore.valid).toBe(true);
  });

  it("rejects deleting an unknown asset", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();

    const result = await executor.execute(
      action("workAsset/delete", { workAssetId: "nope" }),
      project,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("not found");
  });
});

describe("workAsset/rename", () => {
  it("renames, bumps updatedAt, and undo restores the old name", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    withAssets(project, [makeAsset()]);

    const result = await executor.execute(
      action("workAsset/rename", { workAssetId: "wa-1", name: "Renamed" }),
      project,
    );
    expect(result.success).toBe(true);
    expect(project.workAssets?.[0]?.name).toBe("Renamed");
    expect(project.workAssets?.[0]?.updatedAt).toBeGreaterThan(1000);

    await executor.undo(project);
    expect(project.workAssets?.[0]?.name).toBe("Hero trim");
  });

  it("rejects renaming an unknown asset or with an invalid name", async () => {
    const executor = new ActionExecutor();
    const project = makeProject();
    withAssets(project, [makeAsset()]);

    const missing = await executor.execute(
      action("workAsset/rename", { workAssetId: "nope", name: "x" }),
      project,
    );
    expect(missing.success).toBe(false);

    const blank = await executor.execute(
      action("workAsset/rename", { workAssetId: "wa-1", name: "  " }),
      project,
    );
    expect(blank.success).toBe(false);

    const tooLong = await executor.execute(
      action("workAsset/rename", { workAssetId: "wa-1", name: "x".repeat(201) }),
      project,
    );
    expect(tooLong.success).toBe(false);
  });
});

describe("workAsset inverse actions", () => {
  const generator = new InverseActionGenerator();

  it("create inverts to delete-by-id", () => {
    const create = action("workAsset/create", { asset: makeAsset() });
    const inverse = generator.generate(create, makeProject());
    expect(inverse?.type).toBe("workAsset/delete");
    expect((inverse?.params as { workAssetId: string }).workAssetId).toBe("wa-1");
  });

  it("delete inverts to restore with the full previous asset", () => {
    const project = makeProject();
    withAssets(project, [makeAsset()]);
    const inverse = generator.generate(
      action("workAsset/delete", { workAssetId: "wa-1" }),
      project,
    );
    expect(inverse?.type).toBe("workAsset/restore");
    expect(
      (inverse?.params as { asset: WorkAsset }).asset.clipSnapshot?.speed,
    ).toBe(2);
  });

  it("delete of an unknown asset has no inverse", () => {
    const inverse = generator.generate(
      action("workAsset/delete", { workAssetId: "nope" }),
      makeProject(),
    );
    expect(inverse).toBeNull();
  });

  it("rename inverts to the previous name", () => {
    const project = makeProject();
    withAssets(project, [makeAsset({ name: "Before" })]);
    const inverse = generator.generate(
      action("workAsset/rename", { workAssetId: "wa-1", name: "After" }),
      project,
    );
    expect(inverse?.type).toBe("workAsset/rename");
    expect((inverse?.params as { name: string }).name).toBe("Before");
  });

  it("restore inverts back to delete", () => {
    const inverse = generator.generate(
      action("workAsset/restore", { asset: makeAsset() }),
      makeProject(),
    );
    expect(inverse?.type).toBe("workAsset/delete");
  });
});

describe("workAsset history attribution", () => {
  it("entries are discrete undo units and expose a description", () => {
    const history = new ActionHistory();
    history.push(
      action("workAsset/create", { asset: makeAsset() }),
      action("workAsset/delete", { workAssetId: "wa-1" }),
    );
    const [entry] = history.getHistoryEntries();
    expect(entry?.description).toBe('Save work asset "Hero trim"');
  });

  it("keeps rapid same-owner creates as discrete undo units (not auto-groupable)", () => {
    const history = new ActionHistory();
    history.push(
      action("workAsset/create", { asset: makeAsset() }),
      action("workAsset/delete", { workAssetId: "wa-1" }),
      "agent",
    );
    history.push(
      action("workAsset/create", { asset: makeAsset({ id: "wa-2" }) }),
      action("workAsset/delete", { workAssetId: "wa-2" }),
      "agent",
    );

    // Slider-drag coalescing does not apply to asset create/delete pairs.
    expect(history.getHistoryEntries()).toHaveLength(2);
    expect(history.getHistoryEntries().map((e) => e.owner)).toEqual([
      "agent",
      "agent",
    ]);
  });
});
