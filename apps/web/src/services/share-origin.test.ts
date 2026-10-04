import { describe, it, expect, afterEach } from "vitest";
import { shareBaseOrigin } from "./share-origin";
import { generateShareableLink } from "../hooks/use-router";
import { getSharePageUrl } from "./share-service";

afterEach(() => {
  delete (window as unknown as { reelterminal?: unknown }).reelterminal;
});

describe("shareBaseOrigin", () => {
  it("uses publicOrigin on desktop for share + deep links", () => {
    (window as unknown as { reelterminal: unknown }).reelterminal = {
      platform: "desktop",
      publicOrigin: "https://editor.example",
    };
    expect(shareBaseOrigin()).toBe("https://editor.example");
    expect(generateShareableLink("share")).toMatch(/^https:\/\/editor\.example#\//);
    expect(getSharePageUrl("x")).toBe("https://editor.example#/share/x");
  });

  it("uses window.location origin+pathname on web", () => {
    const expected = `${window.location.origin}${window.location.pathname}`;
    expect(shareBaseOrigin()).toBe(expected);
    expect(getSharePageUrl("x")).toBe(`${expected}#/share/x`);
  });
});
