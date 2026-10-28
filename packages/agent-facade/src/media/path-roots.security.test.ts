import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
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

describe("Windows short path aliases", () => {
  const short = String.raw`C:\PROGRA~1`;
  const long = String.raw`C:\Program Files`;
  it.skipIf(process.platform !== "win32" || !existsSync(short) || !existsSync(long))(
    "recognizes an 8.3 alias and its long name as the same root", () => {
      expect(realpathSync.native(short).toLowerCase()).toBe(realpathSync.native(long).toLowerCase());
      expect(resolveContainedPathDetailed(long, [short]).kind).toBe("ok");
      expect(resolveContainedPathDetailed(short, [long]).kind).toBe("ok");
    },
  );
});
