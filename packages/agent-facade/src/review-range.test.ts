import { describe, expect, it } from "vitest";
import {
  createReviewRange,
  reviewCandidateActions,
} from "@reelterminal/core/types/review-range";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import type { Clip, Track } from "@reelterminal/core/types/timeline";
import type { MediaItem } from "@reelterminal/core/types/project";
import { createEmptyProject } from "./project-factory";

function fixture() {
  const project = createEmptyProject("Review");
  const clip = {
    id: "clip",
    mediaId: "source",
    startTime: 1,
    duration: 2,
    inPoint: 3,
    outPoint: 7,
    speed: 2,
  } as Clip;
  project.timeline.tracks.push({ id: "v", clips: [clip] } as Track);
  Object.assign(project.timeline, { duration: 3 });
  Object.assign(project.settings, { frameRate: 30 });
  project.mediaLibrary.items.push(
    ...["source", "candidate"].map(
      (id) => ({ id, type: "video", metadata: { duration: 8 } }) as MediaItem,
    ),
  );
  return project;
}

describe("review frame ranges", () => {
  it("maps zero-based half-open timeline frames to source seconds at constant speed", () => {
    const review = createReviewRange(fixture(), 30, 60);
    expect(review.mappings).toEqual([
      {
        clipId: "clip",
        mediaId: "source",
        timelineStartSec: 1,
        timelineEndSec: 2,
        sourceStartSec: 3,
        sourceEndSec: 5,
      },
    ]);
    expect(() => createReviewRange(fixture(), 30, 30)).toThrow();
    expect(() => createReviewRange(fixture(), 89, 91)).toThrow();
    const project = fixture();
    Object.assign(project.timeline.tracks[0].clips[0], { reversed: true });
    expect(() => createReviewRange(project, 30, 60)).toThrow(/constant-speed/);
  });

  it("adopts the recorded candidate and restores clips, status and task on undo", async () => {
    const project = fixture();
    Object.assign(project, {
      requirements: {
        nextNumber: 2,
        items: [
          {
            id: "q",
            number: 1,
            title: "Review",
            description: "",
            priority: "normal",
            status: "review",
            markerIds: [],
            createdAt: 1,
            updatedAt: 1,
            resultMediaIds: ["candidate"],
            reviewRange: createReviewRange(project, 30, 60),
          },
        ],
      },
    });
    const before = structuredClone(project);
    const actions = reviewCandidateActions(project, "q", "candidate", 8);
    const executor = new ActionExecutor();
    for (const action of actions)
      expect((await executor.execute(action, project)).success).toBe(true);
    expect(project.timeline.tracks[0].clips[0]).toMatchObject({
      mediaId: "candidate",
      duration: 2,
      inPoint: 3,
      outPoint: 7,
    });
    expect(project.requirements?.items[0].status).toBe("done");
    expect(project.mediaLibrary.items[1].production?.status).toBe("adopted");
    for (const _ of actions)
      expect((await executor.undo(project)).success).toBe(true);
    expect(project.requirements).toEqual(before.requirements);
    expect(project.mediaLibrary).toEqual(before.mediaLibrary);
    expect(project.timeline.tracks[0].clips[0].mediaId).toBe("source");
    Object.assign(project.timeline.tracks[0].clips[0], { inPoint: 4 });
    expect(() => reviewCandidateActions(project, "q", "candidate", 8)).toThrow(
      /changed/,
    );
  });
});
