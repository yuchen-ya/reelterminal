import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProductionService } from "./production-service";

it("binds evidence to the requested timeline frame and revision, independent of GUI playhead", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-evidence-"));
  try {
    const file = path.join(dir, "frame.png");
    await writeFile(file, "frame bytes");
    const callExternal = vi.fn(async (verb: string, params: any) =>
      verb === "project.get_state"
        ? {
            ok: true,
            value: {
              revision: 7,
              project: {
                id: "project",
                settings: { width: 1920, height: 1080, frameRate: 30 },
                timeline: { duration: 2 },
              },
            },
          }
        : {
            ok: true,
            value: {
              revision: 7,
              timeSec: params.timeSec,
              artifact: { path: file, sizeBytes: 11 },
            },
          },
    );
    const service = createProductionService({ callExternal } as never, []);
    const captured = await service.captureReview({
      projectId: "project",
      expectedRevision: 7,
      timelineFrame: 15,
    });
    expect(callExternal).toHaveBeenCalledWith(
      "preview.render_frame",
      expect.objectContaining({ timeSec: 0.5, expectedRevision: 7 }),
    );
    expect(captured.evidence).toEqual({
      timelineFrame: 15,
      timeSec: 0.5,
      projectId: "project",
      sourceRevision: 7,
      artifactPath: file,
    });
    expect(captured.screenshot).toMatch(/^data:image\/png;base64,/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses evidence if a different project revision is returned", async () => {
  const callExternal = vi.fn(async (verb: string) =>
    verb === "project.get_state"
      ? {
          ok: true,
          value: {
            revision: 7,
            project: {
              id: "project",
              settings: { width: 1920, height: 1080, frameRate: 30 },
              timeline: { duration: 2 },
            },
          },
        }
      : {
          ok: true,
          value: {
            revision: 8,
            timeSec: 0.5,
            artifact: { path: "unread", sizeBytes: 1 },
          },
        },
  );
  const service = createProductionService({ callExternal } as never, []);
  await expect(
    service.captureReview({
      projectId: "project",
      expectedRevision: 7,
      timelineFrame: 15,
    }),
  ).rejects.toThrow(/does not match/);
});
