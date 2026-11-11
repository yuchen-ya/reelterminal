import { expect, it } from "vitest";
import type { Project } from "@reelterminal/core/types/project";
import { timelineRenderMediaIds } from "./media-references";

it("collects nested footage, stabilized media and assets used by a Motion instance", () => {
  const project = {
    timeline: { tracks: [{ clips: [{ mediaId: "compound:nested" }] }] },
    compoundClips: [{ id: "nested", content: { tracks: [{ clips: [{
      mediaId: "camera", stabilization: { enabled: true, renderedSource: { mediaId: "stabilized" } },
    }] }] } }],
    motionInstances: [{ compositionId: "outer", variableOverrides: { portrait: "replacement" } }],
    motionCompositions: [
      { id: "outer", layers: [{ type: "composition", compositionId: "card" }], assets: [], variables: [] },
      { id: "card", layers: [{ type: "image", assetId: "default",
        variableBindings: [{ target: "image.assetId", variableId: "portrait" }] }],
        assets: [
          { id: "default", mediaId: "card-photo" }, { id: "replacement", mediaId: "custom-photo" },
          { id: "unused", mediaId: "unused-photo" },
        ], variables: [{ id: "portrait", type: "media", value: "default" }] },
    ],
  } as unknown as Project;
  expect([...timelineRenderMediaIds(project)].sort()).toEqual([
    "camera", "compound:nested", "custom-photo", "stabilized",
  ]);
});
