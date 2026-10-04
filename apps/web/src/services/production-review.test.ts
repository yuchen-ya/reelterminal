import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ActionExecutor,
  ActionHistory,
  type MediaItem,
  type Track,
} from "@reelterminal/core";
import { createReviewRange } from "@reelterminal/core/types/review-range";
import { createEmptyProject } from "../stores/project/project-helpers";
import { useProjectStore } from "../stores/project-store";
import { adoptReviewCandidate } from "./production-review";

beforeEach(() => {
  const project = createEmptyProject("Strict GUI adoption");
  project.mediaLibrary.items.push(
    ...["original", "candidate"].map(
      (id) =>
        ({ id, type: "video", metadata: { duration: 1.999 } }) as MediaItem,
    ),
  );
  project.timeline.tracks.push({
    id: "track",
    clips: [
      {
        id: "clip",
        mediaId: "original",
        startTime: 0,
        duration: 2,
        inPoint: 0,
        outPoint: 2,
      },
    ],
  } as Track);
  Object.assign(project.timeline, { duration: 2 });
  Object.assign(project, {
    requirements: {
      nextNumber: 2,
      items: [
        {
          id: "q",
          number: 1,
          title: "Repair",
          description: "",
          priority: "normal",
          status: "review",
          markerIds: [],
          createdAt: 1,
          updatedAt: 1,
          resultMediaIds: ["candidate"],
          reviewRange: createReviewRange(project, 0, 1),
        },
      ],
    },
  });
  const history = new ActionHistory();
  useProjectStore.setState({
    project,
    projectRevision: 0,
    hasOpenProject: true,
    actionHistory: history,
    actionExecutor: new ActionExecutor(history),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("rejects a frame-mismatched candidate without changing timeline, status or history", async () => {
  const before = structuredClone(useProjectStore.getState().project);
  vi.stubGlobal("reelterminal", {
    production: {
      verifyReplacement: vi
        .fn()
        .mockRejectedValue(new Error("decoded frame count differs")),
    },
  });
  await expect(adoptReviewCandidate("q", "candidate", "Adopt")).rejects.toThrow(
    /frame count/,
  );
  expect(useProjectStore.getState().project).toEqual(before);
});

it("uses verified frame duration rather than rounded container duration and groups undo", async () => {
  vi.stubGlobal("reelterminal", {
    production: {
      verifyReplacement: vi
        .fn()
        .mockResolvedValue({ durationSec: 2, frameCount: 60, frameRate: 30 }),
    },
  });
  await adoptReviewCandidate("q", "candidate", "Adopt");
  const store = useProjectStore.getState();
  expect(store.project.timeline.tracks[0].clips[0]).toMatchObject({
    mediaId: "candidate",
    outPoint: 2,
  });
  expect(store.project.requirements?.items[0].status).toBe("done");
  await store.undo();
  expect(
    useProjectStore.getState().project.timeline.tracks[0].clips[0].mediaId,
  ).toBe("original");
  expect(useProjectStore.getState().project.requirements?.items[0].status).toBe(
    "review",
  );
});

it("refuses edits made while native verification is in flight", async () => {
  vi.stubGlobal("reelterminal", {
    production: {
      verifyReplacement: async () => {
        useProjectStore.setState((state) => ({
          projectRevision: state.projectRevision + 1,
        }));
        return { durationSec: 2, frameCount: 60, frameRate: 30 };
      },
    },
  });
  await expect(adoptReviewCandidate("q", "candidate", "Adopt")).rejects.toThrow(
    /Project changed/,
  );
  expect(
    useProjectStore.getState().project.timeline.tracks[0].clips[0].mediaId,
  ).toBe("original");
});
