import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The registry reads VITE_* variables at module scope, so every case
 * re-imports the module against a freshly stubbed environment.
 */

const CLOUD_ENV_KEYS = [
  "VITE_OPENREEL_CLOUD",
  "VITE_OPENREEL_CLOUD_URL",
  "VITE_CLOUD_API_URL",
  "VITE_OPENREEL_TRANSCRIBE_URL",
] as const;

function clearCloudEnv(): void {
  for (const key of CLOUD_ENV_KEYS) {
    delete (import.meta.env as Record<string, unknown>)[key];
  }
}

async function loadRegistry() {
  vi.resetModules();
  return import("./api-endpoints");
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearCloudEnv();
});

describe("api-endpoints cloud registry", () => {
  it("keeps every default with no env set: cloud enabled, built-in URLs", async () => {
    clearCloudEnv();
    const registry = await loadRegistry();

    expect(registry.OPENREEL_CLOUD_ENABLED).toBe(true);
    const isDev = import.meta.env.DEV;
    expect(registry.OPENREEL_CLOUD_URL).toBe(
      isDev ? "http://localhost:8787" : "https://api.openreel.video",
    );
    expect(registry.OPENREEL_TRANSCRIBE_URL).toBe(
      "https://cloud.openreel.video",
    );
  });

  it.each(["off", "OFF", "Off"])(
    "disables the cloud only for the exact value `off` (%s)",
    async (value) => {
      clearCloudEnv();
      vi.stubEnv("VITE_OPENREEL_CLOUD", value);
      const registry = await loadRegistry();

      expect(registry.OPENREEL_CLOUD_ENABLED).toBe(false);
      // Opting out must not change where a re-enabled build would point.
      const isDev = import.meta.env.DEV;
      expect(registry.OPENREEL_CLOUD_URL).toBe(
        isDev ? "http://localhost:8787" : "https://api.openreel.video",
      );
    },
  );

  it.each(["", "false", "0", "no", "disabled", " off ", "on"])(
    "keeps the cloud enabled for any other VITE_OPENREEL_CLOUD value (%s)",
    async (value) => {
      clearCloudEnv();
      vi.stubEnv("VITE_OPENREEL_CLOUD", value);
      const registry = await loadRegistry();

      expect(registry.OPENREEL_CLOUD_ENABLED).toBe(true);
    },
  );

  it("lets VITE_OPENREEL_CLOUD_URL override the cloud base URL", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://cloud.example.dev");
    const registry = await loadRegistry();

    expect(registry.OPENREEL_CLOUD_URL).toBe("https://cloud.example.dev");
  });

  it("still honors VITE_CLOUD_API_URL as a compatibility alias", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_CLOUD_API_URL", "https://legacy.example.dev");
    const registry = await loadRegistry();

    expect(registry.OPENREEL_CLOUD_URL).toBe("https://legacy.example.dev");
  });

  it("prefers VITE_OPENREEL_CLOUD_URL over the legacy alias", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://cloud.example.dev");
    vi.stubEnv("VITE_CLOUD_API_URL", "https://legacy.example.dev");
    const registry = await loadRegistry();

    expect(registry.OPENREEL_CLOUD_URL).toBe("https://cloud.example.dev");
  });

  it("treats an empty override like a missing one and falls back to the default", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "");
    vi.stubEnv("VITE_CLOUD_API_URL", "");
    const registry = await loadRegistry();

    const isDev = import.meta.env.DEV;
    expect(registry.OPENREEL_CLOUD_URL).toBe(
      isDev ? "http://localhost:8787" : "https://api.openreel.video",
    );
  });

  it("lets VITE_OPENREEL_TRANSCRIBE_URL override the transcription URL", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_TRANSCRIBE_URL", "https://gpu.example.dev");
    const registry = await loadRegistry();

    expect(registry.OPENREEL_TRANSCRIBE_URL).toBe("https://gpu.example.dev");
  });
});
