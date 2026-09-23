import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FFMPEG_CORE_BASE_URL,
  DEFAULT_VIDSTAB_MT_URL,
  DEFAULT_VIDSTAB_ST_URL,
  getFfmpegCoreBaseUrl,
  getVidstabCoreUrl,
  resetMediaCdnOverrides,
  setMediaCdnOverrides,
} from "./media-cdn-config";

afterEach(() => {
  resetMediaCdnOverrides();
});

describe("media-cdn-config", () => {
  it("resolves the built-in locations with no overrides", () => {
    expect(getFfmpegCoreBaseUrl()).toBe(DEFAULT_FFMPEG_CORE_BASE_URL);
    expect(getVidstabCoreUrl("mt")).toBe(DEFAULT_VIDSTAB_MT_URL);
    expect(getVidstabCoreUrl("st")).toBe(DEFAULT_VIDSTAB_ST_URL);
  });

  it("redirects each core independently", () => {
    setMediaCdnOverrides({
      ffmpegCoreBaseUrl: "https://mirror.example.dev/ffmpeg-core",
      vidstabStUrl: "https://mirror.example.dev/vidstab/st",
    });

    expect(getFfmpegCoreBaseUrl()).toBe("https://mirror.example.dev/ffmpeg-core");
    expect(getVidstabCoreUrl("st")).toBe("https://mirror.example.dev/vidstab/st");
    expect(getVidstabCoreUrl("mt")).toBe(DEFAULT_VIDSTAB_MT_URL);
  });

  it("treats an empty override like a missing one", () => {
    setMediaCdnOverrides({ ffmpegCoreBaseUrl: "", vidstabMtUrl: "" });

    expect(getFfmpegCoreBaseUrl()).toBe(DEFAULT_FFMPEG_CORE_BASE_URL);
    expect(getVidstabCoreUrl("mt")).toBe(DEFAULT_VIDSTAB_MT_URL);
  });

  it("restores the defaults on reset", () => {
    setMediaCdnOverrides({ ffmpegCoreBaseUrl: "https://mirror.example.dev/core" });
    resetMediaCdnOverrides();

    expect(getFfmpegCoreBaseUrl()).toBe(DEFAULT_FFMPEG_CORE_BASE_URL);
  });
});
