import { describe, expect, it } from "vitest";
import {
  inferMediaType,
  isSupportedFormat,
} from "./mediabunny-engine";

describe("supported media formats", () => {
  it("accepts m4a containers (AAC in MP4) as audio", () => {
    expect(isSupportedFormat("audio/mp4")).toBe(true);
    expect(isSupportedFormat("audio/x-m4a")).toBe(true);
    expect(inferMediaType("audio/mp4")).toBe("audio");
    expect(inferMediaType("audio/x-m4a")).toBe("audio");
  });

  it("keeps the pre-existing audio/video/image formats supported", () => {
    expect(isSupportedFormat("video/mp4")).toBe(true);
    expect(isSupportedFormat("audio/mpeg")).toBe(true);
    expect(isSupportedFormat("audio/aac")).toBe(true);
    expect(isSupportedFormat("audio/wav")).toBe(true);
    expect(isSupportedFormat("image/png")).toBe(true);
    expect(inferMediaType("video/mp4")).toBe("video");
    expect(inferMediaType("image/png")).toBe("image");
  });

  it("ignores MIME parameters when matching", () => {
    expect(isSupportedFormat("audio/mp4; codecs=mp4a.40.2")).toBe(true);
    expect(inferMediaType("video/mp4; codecs=avc1")).toBe("video");
  });

  it("still rejects unknown formats", () => {
    expect(isSupportedFormat("application/octet-stream")).toBe(false);
    expect(isSupportedFormat("video/x-msvideo")).toBe(false);
    expect(inferMediaType("application/octet-stream")).toBeNull();
  });
});
