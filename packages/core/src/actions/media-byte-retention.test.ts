import { describe, expect, it } from "vitest";
import type { Action } from "../types/actions";
import { ActionHistory } from "./action-history";
import {
  entryRetainsMediaBytes,
  historyRetainsMediaBytes,
  projectRetainsWorkAssetMediaBytes,
} from "./media-byte-retention";
import type { WorkAsset } from "../types";

const act = (type: string, params: Record<string, unknown> = {}): Action => ({
  type,
  id: `a-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  params,
});

const makeEntry = (
  action: Action,
  inverseAction: Action | null,
): {
  action: Action;
  inverseAction: Action | null;
  timestamp: number;
  description: string;
} => ({
  action,
  inverseAction,
  timestamp: Date.now(),
  description: action.type,
});

describe("media byte retention predicate", () => {
  it("retains bytes for a delete entry regardless of which stack it sits on", () => {
    const entry = makeEntry(
      act("media/delete", { mediaId: "m1" }),
      act("media/restore", { mediaItem: { id: "m1" } }),
    );

    expect(entryRetainsMediaBytes(entry, "m1")).toBe(true);
    expect(entryRetainsMediaBytes(entry, "other")).toBe(false);
  });

  it("retains bytes through a media/restore inverse action", () => {
    const entry = makeEntry(
      act("clip/add", { trackId: "t1" }),
      act("media/restore", { mediaItem: { id: "m1" } }),
    );

    expect(entryRetainsMediaBytes(entry, "m1")).toBe(true);
    expect(entryRetainsMediaBytes(entry, "other")).toBe(false);
  });

  it("retains bytes for an undone import via its action params item", () => {
    // An undone import sits on the redo stack with the full item in the action
    // params; the inverse delete only carries the "__LAST_ADDED__" marker, so
    // matching must use the media item id.
    const entry = makeEntry(
      act("media/import", {
        file: {},
        mediaItem: { id: "m1", name: "clip.mp4" },
      }),
      act("media/delete", { mediaId: "__LAST_ADDED__" }),
    );

    expect(entryRetainsMediaBytes(entry, "m1")).toBe(true);
    expect(entryRetainsMediaBytes(entry, "__LAST_ADDED__")).toBe(false);
    expect(entryRetainsMediaBytes(entry, "other")).toBe(false);
  });

  it("ignores entries that never reference the media", () => {
    const entry = makeEntry(
      act("track/add", { trackType: "video" }),
      act("track/remove", { trackId: "t1" }),
    );

    expect(entryRetainsMediaBytes(entry, "m1")).toBe(false);
  });

  it("scans the undo and redo stacks of a live history", () => {
    const history = new ActionHistory();
    history.push(
      act("media/delete", { mediaId: "m1" }),
      act("media/restore", { mediaItem: { id: "m1" } }),
    );

    expect(historyRetainsMediaBytes(history, "m1")).toBe(true);

    history.undo(); // entry now lives on the redo stack
    expect(historyRetainsMediaBytes(history, "m1")).toBe(true);

    history.push(act("clip/add", { trackId: "t1" }), act("clip/remove"));
    // The delete entry was evicted: nothing can restore m1 anymore.
    expect(historyRetainsMediaBytes(history, "m1")).toBe(false);
  });
});

const workAsset = (overrides: Partial<WorkAsset> = {}): WorkAsset =>
  ({
    schemaVersion: 1,
    id: "wa-1",
    kind: "single",
    name: "Hero trim",
    sourceMediaId: "m1",
    sourceRange: { inSec: 0, outSec: 2 },
    unsupportedParams: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as WorkAsset;

describe("work asset reference retention", () => {
  it("retains bytes for media referenced by a project work asset", () => {
    const project = { workAssets: [workAsset()] };

    expect(projectRetainsWorkAssetMediaBytes(project, "m1")).toBe(true);
    expect(projectRetainsWorkAssetMediaBytes(project, "other")).toBe(false);
  });

  it("retains bytes in the missingSource state (referenced media absent)", () => {
    const project = { workAssets: [workAsset()] };

    // The reference survives the media deletion; only deleting the work
    // asset itself releases the bytes.
    expect(projectRetainsWorkAssetMediaBytes(project, "m1")).toBe(true);
  });

  it("releases bytes once the referencing asset is deleted", () => {
    const project = { workAssets: [] };

    expect(projectRetainsWorkAssetMediaBytes(project, "m1")).toBe(false);
  });

  it("tolerates projects without the workAssets field", () => {
    expect(projectRetainsWorkAssetMediaBytes({}, "m1")).toBe(false);
    expect(
      projectRetainsWorkAssetMediaBytes(
        { workAssets: "garbage" } as unknown as { workAssets?: WorkAsset[] },
        "m1",
      ),
    ).toBe(false);
  });

  const multiAsset = (overrides: Partial<WorkAsset> = {}): WorkAsset =>
    workAsset({
      kind: "multi",
      clipSnapshot: undefined,
      members: [
        {
          memberId: "m-a",
          mediaId: "m-anchor-alt",
          sourceRange: { inSec: 0, outSec: 2 },
          relativeStart: 0,
          lane: { trackType: "video", laneOffset: 0 },
          snapshot: {} as never,
        },
        {
          memberId: "m-b",
          mediaId: "m-member",
          sourceRange: { inSec: 1, outSec: 3 },
          relativeStart: 1.5,
          lane: { trackType: "audio", laneOffset: 0 },
          snapshot: {} as never,
        },
      ],
      ...overrides,
    }) as WorkAsset;

  it("retains bytes for every member media of a multi asset (anchor and members)", () => {
    const project = { workAssets: [multiAsset()] };

    expect(projectRetainsWorkAssetMediaBytes(project, "m1")).toBe(true); // anchor (top-level)
    expect(projectRetainsWorkAssetMediaBytes(project, "m-member")).toBe(true);
    expect(projectRetainsWorkAssetMediaBytes(project, "m-anchor-alt")).toBe(true);
    expect(projectRetainsWorkAssetMediaBytes(project, "other")).toBe(false);
  });

  it("keeps protecting member media while a multi asset sits in missingSource state", () => {
    // The member reference survives the media deletion (legal persistent
    // state); only deleting the asset releases the bytes.
    const project = { workAssets: [multiAsset()] };

    expect(projectRetainsWorkAssetMediaBytes(project, "m-member")).toBe(true);
  });

  it("ignores malformed members arrays instead of crashing the GC scan", () => {
    const project = {
      workAssets: [
        workAsset({
          kind: "multi",
          members: "garbage",
        } as unknown as Partial<WorkAsset>),
      ],
    };

    expect(projectRetainsWorkAssetMediaBytes(project, "m1")).toBe(true);
    expect(projectRetainsWorkAssetMediaBytes(project, "other")).toBe(false);
  });
});
