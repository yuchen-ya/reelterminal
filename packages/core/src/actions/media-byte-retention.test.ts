import { describe, expect, it } from "vitest";
import type { Action } from "../types/actions";
import { ActionHistory } from "./action-history";
import {
  entryRetainsMediaBytes,
  historyRetainsMediaBytes,
} from "./media-byte-retention";

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
