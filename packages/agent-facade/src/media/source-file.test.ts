import { describe, expect, it } from "vitest";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveLocalSourceFile,
  selectMediaSource,
  selectProjectMediaSource,
} from "./source-file";
import { createEmptyProject } from "../project-factory";

const record = {
  id: "m1",
  originalUrl: join(tmpdir(), "source-classification", "media", "original.mp4"),
};
const mediaRoot = join(tmpdir(), "source-classification", "media");

describe("media source selection", () => {
  it("uses originalUrl only when contentUrl is absent", () => {
    expect(selectMediaSource(record)).toEqual({
      mediaId: "m1",
      sourceKind: "original",
      path: record.originalUrl,
    });
    expect(selectMediaSource({ ...record, contentUrl: undefined })).toEqual({
      mediaId: "m1",
      sourceKind: "original",
      path: record.originalUrl,
    });
  });

  it.each(["", null, join(mediaRoot, "controlled.mp4")])("takes contentUrl %s as authoritative", (contentUrl) => {
    const selected = selectMediaSource({ ...record, contentUrl });
    expect(selected.sourceKind).toBe("controlled");
    expect(selected.path).toBe(typeof contentUrl === "string" ? contentUrl : null);
  });

  it("classifies an unknown id without scanning for a file", () => {
    const project = createEmptyProject("source-selection");
    expect(() => selectProjectMediaSource(project, "missing")).toThrowError(expect.objectContaining({
      code: "NOT_FOUND",
      details: { reason: "media_not_found", mediaId: "missing" },
    }));
  });
});

describe("local source error classification", () => {
  it.each(["https://example.invalid/controlled.mp4", String.raw`\\server.invalid\share\controlled.mp4`])(
    "classifies forbidden source %s as outside_roots before filesystem access",
    async (contentUrl) => {
      await expect(resolveLocalSourceFile(selectMediaSource({ ...record, contentUrl }), {
        verb: "media.inspect",
        roots: [mediaRoot],
        resolvePath: () => { throw new Error("filesystem must not be consulted"); },
      })).rejects.toMatchObject({
        code: "INVALID_PARAMS",
        details: { reason: "outside_roots", mediaId: "m1", sourceKind: "controlled" },
      });
    },
  );

  it.each(["EACCES", "EPERM"])("maps injected realpath %s to source_unreadable", async (fsCode) => {
    await expect(resolveLocalSourceFile(selectMediaSource({ ...record, contentUrl: join(mediaRoot, "controlled.mp4") }), {
      verb: "media.inspect",
      roots: [mediaRoot],
      resolvePath: () => ({ kind: "unresolvable", fsCode }),
    })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      details: {
        reason: "source_unreadable",
        mediaId: "m1",
        sourceKind: "controlled",
        fsCode,
      },
    });
  });

  it("keeps an unknown realpath failure unresolvable", async () => {
    await expect(resolveLocalSourceFile(selectMediaSource(record), {
      verb: "frames.extract",
      roots: [mediaRoot],
      resolvePath: () => ({ kind: "unresolvable" }),
    })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      details: { reason: "unresolvable", mediaId: "m1", sourceKind: "original" },
    });
  });

  it("maps a stat permission error and does not convert unknown internal failures", async () => {
    const source = selectMediaSource(record);
    await expect(resolveLocalSourceFile(source, {
      verb: "media.inspect",
      statFile: async () => { throw Object.assign(new Error("injected EACCES"), { code: "EACCES" }); },
    })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      details: { reason: "source_unreadable", fsCode: "EACCES" },
    });

    const internal = new Error("unexpected stat failure");
    await expect(resolveLocalSourceFile(source, {
      verb: "media.inspect",
      statFile: async () => { throw internal; },
    })).rejects.toBe(internal);
  });

  it("classifies a selected directory as not_file", async () => {
    await expect(resolveLocalSourceFile(selectMediaSource(record), {
      verb: "media.inspect",
      statFile: async () => ({ isFile: () => false }) as Stats,
    })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      details: { reason: "not_file", mediaId: "m1", sourceKind: "original" },
    });
  });

  it("omits backing paths from media-ID errors but retains explicit path diagnostics", async () => {
    const mediaFailure = await resolveLocalSourceFile(selectMediaSource({
      ...record,
      contentUrl: join(tmpdir(), "private", "controlled.mp4"),
    }), {
      verb: "media.inspect",
      roots: [mediaRoot],
      resolvePath: () => ({ kind: "outside" }),
    }).then(
      () => { throw new Error("expected media-ID resolution to fail"); },
      (error: unknown) => error as { details: Record<string, unknown> },
    );
    expect(mediaFailure).toMatchObject({
      code: "INVALID_PARAMS",
      details: { reason: "outside_roots", mediaId: "m1", sourceKind: "controlled" },
    });
    expect(mediaFailure.details).not.toHaveProperty("path");

    const explicitPath = join(tmpdir(), "private", "explicit.mp4");
    await expect(resolveLocalSourceFile({ path: explicitPath }, {
      verb: "frames.extract",
      roots: [mediaRoot],
      resolvePath: () => ({ kind: "outside" }),
    })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      details: { reason: "outside_roots", path: explicitPath },
    });
  });
});
