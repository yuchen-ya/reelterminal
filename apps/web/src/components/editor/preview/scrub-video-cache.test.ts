import { expect, test } from "vitest";
import { scrubVideoCacheKey, scrubVideoCacheLimit } from "./scrub-video-cache";

test("simultaneous clips of one source have independent seek state", () => {
  expect(scrubVideoCacheKey("earlier", "same-source", false)).not.toBe(scrubVideoCacheKey("later", "same-source", false));
  expect(scrubVideoCacheKey("earlier", "same-source", true)).not.toBe(scrubVideoCacheKey("earlier", "same-source", false));
  expect(scrubVideoCacheKey("clip:a", "b", false)).not.toBe(scrubVideoCacheKey("clip", "a:b", false));
});

test("three active layers are not cyclically evicted by a two-entry cache", () => {
  const clips = Array.from({ length: 3 }, (_, i) => ({ id: `clip-${i}`, mediaId: "same-source", startTime: 0, duration: 12 }));
  expect(scrubVideoCacheLimit([{ type: "video", clips }], 2, () => "video")).toBe(3);
  expect(scrubVideoCacheLimit([{ type: "video", clips }], 12, () => "video")).toBe(2);
  expect(scrubVideoCacheLimit([{ type: "video", hidden: true, clips }], 2, () => "video")).toBe(2);
});

test("large sequential timelines do not retain every decoder", () => {
  const clips = Array.from({ length: 2000 }, (_, i) => ({ id: `clip-${i}`, mediaId: `media-${i}`, startTime: i * 5, duration: 5 }));
  expect(scrubVideoCacheLimit([{ type: "video", clips }], 12, () => "video")).toBe(2);
  expect(scrubVideoCacheLimit([{ type: "image", clips: clips.slice(0, 3).map(c => ({ ...c, startTime: 0 })) }], 2, () => "image")).toBe(2);
});
