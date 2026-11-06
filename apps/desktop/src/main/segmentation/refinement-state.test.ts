import { expect, it } from "vitest";
import { RefinementState } from "./refinement-state";
import type { SegmentationPrompts } from "./types";

const initial: SegmentationPrompts = { points: [{ x: 0.4, y: 0.5, foreground: true }] };
const next: SegmentationPrompts = { points: [...initial.points, { x: 0.1, y: 0.2, foreground: false }] };

it("publishes only accepted current results and never adopts cancelled or old ACK logits", () => {
  const state = new RefinementState<string>();
  const version = state.begin("image-a/revision1/rotation0", "edit-1");
  state.stage(1, initial, "mask-a", version);
  state.cancel(1);
  state.accept(1);
  expect(state.prior(next)).toBeUndefined();
  state.stage(2, initial, "accepted-a", version);
  state.accept(2);
  expect(state.prior(next)).toBe("accepted-a");
  state.stage(3, next, "late-a", version);
  state.begin("image-a/revision1/rotation0", "edit-2");
  state.accept(3);
  expect(state.prior({ points: [...next.points, { x: 0.2, y: 0.1, foreground: true }] })).toBeUndefined();
});

it("resets on image, pixel revision, rotation, refinement session, explicit clear or in-flight reset", () => {
  const state = new RefinementState<string>();
  for (const key of ["image-b/rev1/rotation0", "image-a/rev2/rotation0", "image-a/rev1/rotation90"]) {
    const version = state.begin("image-a/rev1/rotation0", "edit");
    state.stage(1, initial, "prior", version);
    state.accept(1);
    state.begin(key, "edit");
    expect(state.prior(next)).toBeUndefined();
  }
  const version = state.begin("image-a/rev1/rotation0", "edit");
  state.reset();
  state.stage(9, initial, "computed-before-clear", version);
  state.accept(9);
  expect(state.prior(next)).toBeUndefined();
});

it("refines append-only point/box additions but discards old logits on removal, movement or changed box", () => {
  const box = { left: 0, top: 0, right: 0.8, bottom: 0.9 };
  const state = new RefinementState<string>();
  const version = state.begin("pixels", "edit");
  state.stage(1, initial, "point-mask", version);
  state.accept(1);
  expect(state.prior({ ...next, box })).toBe("point-mask");
  const withBox = { ...next, box };
  for (const replacement of [initial, { ...next, box: { ...box, right: 0.7 } }, { ...next, points: [{ ...initial.points[0], x: 0.6 }, next.points[1]] }]) {
    state.stage(2, withBox, "box-mask", version);
    state.accept(2);
    expect(state.prior(replacement)).toBeUndefined();
  }
});
