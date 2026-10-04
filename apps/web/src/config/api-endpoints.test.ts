import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "VITE_REELTERMINAL_CLOUD", "VITE_OPENREEL_CLOUD",
  "VITE_REELTERMINAL_CLOUD_URL", "VITE_OPENREEL_CLOUD_URL", "VITE_CLOUD_API_URL",
  "VITE_REELTERMINAL_TRANSCRIBE_URL", "VITE_OPENREEL_TRANSCRIBE_URL",
  "VITE_REELTERMINAL_FFMPEG_CORE_URL", "VITE_REELTERMINAL_VIDSTAB_MT_URL", "VITE_REELTERMINAL_VIDSTAB_ST_URL",
];
async function registry() {
  vi.resetModules();
  return import("./api-endpoints");
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of keys) delete (import.meta.env as Record<string, unknown>)[key];
});

describe("local-first endpoint configuration", () => {
  it("has no cloud backend or cloud capability by default", async () => {
    const config = await registry();
    expect(config.REELTERMINAL_CLOUD_ENABLED).toBe(false);
    expect(config.REELTERMINAL_TRANSCRIBE_ENABLED).toBe(false);
    expect(config.REELTERMINAL_CLOUD_URL).toBe("");
    expect(config.REELTERMINAL_TRANSCRIBE_URL).toBe("");
  });
  it("requires a backend even with an explicit opt-in", async () => {
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "on");
    const config = await registry();
    expect(config.REELTERMINAL_CLOUD_ENABLED).toBe(false);
    expect(config.REELTERMINAL_TRANSCRIBE_ENABLED).toBe(false);
  });
  it.each(["", "off", "false", "0", "enabled"])("does not opt in with %s", async (value) => {
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", value);
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://service.example");
    expect((await registry()).REELTERMINAL_CLOUD_ENABLED).toBe(false);
  });
  it("enables only the explicitly configured service", async () => {
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "ON");
    vi.stubEnv("VITE_REELTERMINAL_TRANSCRIBE_URL", "https://transcribe.example");
    const config = await registry();
    expect(config.REELTERMINAL_TRANSCRIBE_ENABLED).toBe(true);
    expect(config.REELTERMINAL_CLOUD_ENABLED).toBe(false);
  });
  it("preserves configured legacy deployments with explicit opt-in", async () => {
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://legacy.example");
    const config = await registry();
    expect(config.REELTERMINAL_CLOUD_ENABLED).toBe(true);
    expect(config.REELTERMINAL_CLOUD_URL).toBe("https://legacy.example");
  });
  it("lets the current setting and empty URL override legacy settings", async () => {
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://legacy.example");
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "");
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "");
    const config = await registry();
    expect(config.REELTERMINAL_CLOUD_ENABLED).toBe(false);
    expect(config.REELTERMINAL_CLOUD_URL).toBe("");
  });
  it("preserves configured media-core overrides", async () => {
    vi.stubEnv("VITE_REELTERMINAL_FFMPEG_CORE_URL", "https://assets.example/ffmpeg");
    vi.stubEnv("VITE_REELTERMINAL_VIDSTAB_ST_URL", "https://assets.example/vidstab");
    const config = await registry();
    expect(config.REELTERMINAL_FFMPEG_CORE_URL).toBe("https://assets.example/ffmpeg");
    expect(config.REELTERMINAL_VIDSTAB_ST_URL).toBe("https://assets.example/vidstab");
  });
});
