import { expect, it } from "vitest";
import { artifactPathKey, collectArtifactPaths } from "./artifact-paths";

it("conservatively matches native paths, encoded file URLs and case/Unicode aliases for retention", () => {
  expect(artifactPathKey("file:///E:/Media/my%20clip.mp4")).toBe(artifactPathKey("e:\\media\\my clip.mp4"));
  expect(artifactPathKey("file://server/Share/clip.mp4")).toBe(artifactPathKey("\\\\server\\Share\\clip.mp4"));
  expect(artifactPathKey("/Media/clip.mp4")).toBe(artifactPathKey("/media/clip.mp4"));
  expect(artifactPathKey("/media/cafe\u0301.mp4")).toBe(artifactPathKey("/media/caf\u00e9.mp4"));
  expect(artifactPathKey("https://example.com/video.mp4")).toBeUndefined();
  expect(artifactPathKey("file:///invalid%path")).toBeUndefined();
  expect(artifactPathKey("C:\\..\\exports\\take.mp4")).toBe(artifactPathKey("C:\\exports\\take.mp4"));
  expect(artifactPathKey("\\\\server\\share\\..\\take.mp4")).toBe(artifactPathKey("\\\\server\\share\\take.mp4"));
});

it("collects journal and nested source pointers without traversing binary payloads", () => {
  const record: Record<string, unknown> = {
    before: { fileRef: { path: "E:\\artifacts\\take.mp4" } },
    project: { mediaLibrary: { items: [{ originalUrl: "file:///E:/artifacts/take.mp4" }] } },
    renderFonts: [{ data: new Uint8Array(1024), dataUrl: "data:font/woff2;base64,AAAA" }],
    blob: new Blob(["E:\\not-a-reference.mp4"]),
  };
  record.cycle = record;
  expect([...collectArtifactPaths(record)]).toEqual(["e:/artifacts/take.mp4"]);
});
