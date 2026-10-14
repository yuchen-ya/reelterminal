import { expect, it } from "vitest";
import type { Track } from "@reelterminal/core";
import { hasLayeredTransition } from "./layered-transition";

it("uses full composition only when a visible extra video/image layer overlaps a transition", () => {
  const pair = { clipA: { id: "a" }, clipB: { id: "b" } };
  const tracks = [{ type: "video", clips: [{ id: "a", startTime: 0, duration: 6 }, { id: "b", startTime: 6, duration: 6 }] }, { type: "video", clips: [{ id: "overlay", startTime: 0, duration: 12 }] }] as Track[];
  expect(hasLayeredTransition(tracks, 6, pair)).toBe(true);
  expect(hasLayeredTransition(tracks, 6, null)).toBe(false);
  expect(hasLayeredTransition(tracks.slice(0, 1), 6, pair)).toBe(false);
  expect(hasLayeredTransition([{ ...tracks[1]!, hidden: true }, tracks[0]!], 6, pair)).toBe(false);
  expect(hasLayeredTransition(tracks, 12, pair)).toBe(false);
});
