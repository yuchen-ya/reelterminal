import { afterEach, expect, it, vi } from "vitest";
import { resetMediaCdnOverrides } from "../../media/media-cdn-config";
import { VidstabEngine } from "./vidstab-engine";

afterEach(() => {
  resetMediaCdnOverrides();
  vi.unstubAllGlobals();
});

it("does not download a private core when stabilization is unconfigured", async () => {
  resetMediaCdnOverrides();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const engine = new VidstabEngine();
  await expect(engine.load()).rejects.toThrow("no vidstab core is configured");
  expect(fetch).not.toHaveBeenCalled();
  expect(engine.isLoaded()).toBe(false);
});
