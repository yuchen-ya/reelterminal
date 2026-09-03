import { describe, expect, it } from "vitest";
import type { Track } from "@openreel/core";
import {
  compareTracksForComposite,
  isOverlayTrackType,
  type IndexedTrack,
} from "./composite-track-order";

const track = (type: Track["type"]) => ({ type }) as Track;

const order = (types: Track["type"][]): Track["type"][] =>
  types
    .map((type, originalIndex) => ({ track: track(type), originalIndex }))
    .sort(compareTracksForComposite)
    .map(({ track: t }) => t.type);

describe("isOverlayTrackType", () => {
  it("treats text and graphics as overlays", () => {
    expect(isOverlayTrackType("text")).toBe(true);
    expect(isOverlayTrackType("graphics")).toBe(true);
    expect(isOverlayTrackType("video")).toBe(false);
    expect(isOverlayTrackType("image")).toBe(false);
    expect(isOverlayTrackType("audio")).toBe(false);
  });
});

describe("compareTracksForComposite", () => {
  it("paints overlay tracks after video tracks regardless of array position", () => {
    // Agent-created projects append the text track after video tracks; the
    // overlay must still composite on top (matches playing/export).
    expect(order(["video", "audio", "text"])).toEqual([
      "audio",
      "video",
      "text",
    ]);
  });

  it("keeps higher-index-first painter order within the video group", () => {
    const sorted = (["video", "video", "video"] as Track["type"][])
      .map((type, originalIndex) => ({ track: track(type), originalIndex }))
      .sort(compareTracksForComposite)
      .map(({ originalIndex }) => originalIndex);
    expect(sorted).toEqual([2, 1, 0]);
  });

  it("keeps higher-index-first painter order within the overlay group", () => {
    const sorted = (
      ["text", "graphics", "text", "graphics"] as Track["type"][]
    )
      .map((type, originalIndex) => ({ track: track(type), originalIndex }))
      .sort(compareTracksForComposite)
      .map(({ originalIndex }) => originalIndex);
    expect(sorted).toEqual([3, 2, 1, 0]);
  });

  it("puts every overlay above every video/image track", () => {
    const sorted: IndexedTrack<Track>[] = (
      ["video", "text", "image", "graphics"] as Track["type"][]
    )
      .map((type, originalIndex) => ({ track: track(type), originalIndex }))
      .sort(compareTracksForComposite);
    expect(sorted.map(({ track: t }) => t.type)).toEqual([
      "image",
      "video",
      "graphics",
      "text",
    ]);
  });
});
