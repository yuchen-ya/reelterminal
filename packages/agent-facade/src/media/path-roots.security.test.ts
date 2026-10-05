import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { resolveContainedPathDetailed, hasUrlScheme } from "./path-roots";

describe("path rejection before filesystem resolution", () => {
  it.each([
    String.raw`\\server.invalid\share\video.mp4`, "//server.invalid/share/video.mp4",
    String.raw`\\?\UNC\server.invalid\share\video.mp4`,
    String.raw`\\?\C:\media\video.mp4`, String.raw`\\.\pipe\reelterminal`,
    String.raw`\??\UNC\server.invalid\share\video.mp4`,
    String.raw`\Device\Mup\server.invalid\share\video.mp4`,
    "file://server.invalid/share/video.mp4", "ab:payload",
  ])("never resolves %s", (candidate) => {
    const resolver = vi.fn(() => { throw new Error("must not resolve"); });
    expect(resolveContainedPathDetailed(candidate, ["C:/media"], resolver).kind).toBe("outside");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("ignores forbidden roots without resolving them", () => {
    const candidate = path.resolve("local.mp4");
    const resolver = vi.fn((value: string) => value);
    expect(resolveContainedPathDetailed(candidate, [String.raw`\\server.invalid\share`], resolver).kind).toBe("outside");
    expect(resolver.mock.calls).toEqual([[candidate]]);
    expect(hasUrlScheme("ab:payload")).toBe(true);
  });
});
