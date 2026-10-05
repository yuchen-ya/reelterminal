import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { classifyRequestUrl, renderHtmlPng } from "./html-render";
import type { ChromiumRuntime } from "./runtime";

describe("HTML asset rejection before filesystem resolution", () => {
  it.each([
    "file://server.invalid/share/image.png", "FILE://server.invalid/share/image.png",
    "file:////server.invalid/share/image.png",
    "file:///C:/%5C%5Cserver.invalid/share/image.png",
    "file:///C:/outside/image.png",
  ])("never resolves %s", async (url) => {
    const resolver = vi.fn(async () => { throw new Error("must not resolve"); });
    const verdict = await classifyRequestUrl(url, "C:/media/entry.html", "C:/media", resolver);
    expect(verdict.allow).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("resolves a local in-root asset and still checks its real path", async () => {
    const root = path.resolve("assets");
    const asset = path.join(root, "image.png");
    const resolver = vi.fn(async () => asset);
    expect((await classifyRequestUrl(String(pathToFileURL(asset)), path.join(root, "entry.html"), root, resolver)).allow).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect((await classifyRequestUrl(String(pathToFileURL(asset)), path.join(root, "entry.html"), root, async () => path.resolve("outside.png"))).allow).toBe(false);
  });

  it("refuses direct network source/root/destination before browser work", async () => {
    const runtime = { withIsolatedContext: vi.fn() } as unknown as ChromiumRuntime;
    const base = { source: { kind: "inline" as const, html: "<p>local</p>" }, width: 100, height: 100, destPath: path.resolve("out.png") };
    for (const request of [
      { ...base, source: { kind: "path" as const, path: String.raw`\\server.invalid\share\entry.html` } },
      { ...base, assetsRoot: String.raw`\\server.invalid\share` },
      { ...base, destPath: String.raw`\\.\pipe\output` },
    ]) await expect(renderHtmlPng(runtime, request)).rejects.toThrow(/Network and device paths/);
    expect(runtime.withIsolatedContext).not.toHaveBeenCalled();
  });
});
