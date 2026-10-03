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

const MEDIA_ENV_KEYS = [
  "VITE_REELTERMINAL_FFMPEG_CORE_URL",
  "VITE_REELTERMINAL_VIDSTAB_MT_URL",
  "VITE_REELTERMINAL_VIDSTAB_ST_URL",
] as const;

function clearCloudEnv(): void {
  for (const key of [...CLOUD_ENV_KEYS, ...MEDIA_ENV_KEYS]) {
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

    expect(registry.REELTERMINAL_CLOUD_ENABLED).toBe(true);
    const isDev = import.meta.env.DEV;
    expect(registry.REELTERMINAL_CLOUD_URL).toBe(
      isDev ? "http://localhost:8787" : "https://api.openreel.video",
    );
    expect(registry.REELTERMINAL_TRANSCRIBE_URL).toBe(
      "https://cloud.openreel.video",
    );
  });

  it.each(["off", "OFF", "Off"])(
    "disables the cloud only for the exact value `off` (%s)",
    async (value) => {
      clearCloudEnv();
      vi.stubEnv("VITE_OPENREEL_CLOUD", value);
      const registry = await loadRegistry();

      expect(registry.REELTERMINAL_CLOUD_ENABLED).toBe(false);
      // Opting out must not change where a re-enabled build would point.
      const isDev = import.meta.env.DEV;
      expect(registry.REELTERMINAL_CLOUD_URL).toBe(
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

      expect(registry.REELTERMINAL_CLOUD_ENABLED).toBe(true);
    },
  );

  it("lets VITE_OPENREEL_CLOUD_URL override the cloud base URL", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://cloud.example.dev");
    const registry = await loadRegistry();

    expect(registry.REELTERMINAL_CLOUD_URL).toBe("https://cloud.example.dev");
  });

  it("still honors VITE_CLOUD_API_URL as a compatibility alias", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_CLOUD_API_URL", "https://legacy.example.dev");
    const registry = await loadRegistry();

    expect(registry.REELTERMINAL_CLOUD_URL).toBe("https://legacy.example.dev");
  });

  it("prefers VITE_OPENREEL_CLOUD_URL over the legacy alias", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://cloud.example.dev");
    vi.stubEnv("VITE_CLOUD_API_URL", "https://legacy.example.dev");
    const registry = await loadRegistry();

    expect(registry.REELTERMINAL_CLOUD_URL).toBe("https://cloud.example.dev");
  });

  it("treats an empty override like a missing one and falls back to the default", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "");
    vi.stubEnv("VITE_CLOUD_API_URL", "");
    const registry = await loadRegistry();

    const isDev = import.meta.env.DEV;
    expect(registry.REELTERMINAL_CLOUD_URL).toBe(
      isDev ? "http://localhost:8787" : "https://api.openreel.video",
    );
  });

  it("lets VITE_OPENREEL_TRANSCRIBE_URL override the transcription URL", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_TRANSCRIBE_URL", "https://gpu.example.dev");
    const registry = await loadRegistry();

    expect(registry.REELTERMINAL_TRANSCRIBE_URL).toBe("https://gpu.example.dev");
  });
});

/**
 * Current environment names take precedence over supported VITE_OPENREEL_*
 * aliases so existing deployments retain their configured service target.
 */
describe("api-endpoints env alias precedence", () => {
  const NEW_KEYS = [
    "VITE_REELTERMINAL_CLOUD",
    "VITE_REELTERMINAL_CLOUD_URL",
    "VITE_REELTERMINAL_TRANSCRIBE_URL",
  ] as const;

  function clearAliasEnv(): void {
    for (const key of [...CLOUD_ENV_KEYS, ...NEW_KEYS]) {
      delete (import.meta.env as Record<string, unknown>)[key];
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    clearAliasEnv();
  });

  it("disables the cloud via the new VITE_REELTERMINAL_CLOUD=off name", async () => {
    clearAliasEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "off");
    const registry = await loadRegistry();
    expect(registry.REELTERMINAL_CLOUD_ENABLED).toBe(false);
  });

  it("prefers the new name when both VITE_REELTERMINAL_CLOUD and VITE_OPENREEL_CLOUD are set", async () => {
    clearAliasEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", ""); // new name set-and-empty: cloud stays enabled
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    const registry = await loadRegistry();
    expect(registry.REELTERMINAL_CLOUD_ENABLED).toBe(true);
  });

  it("falls back to the legacy VITE_OPENREEL_CLOUD_URL when the new URL name is unset", async () => {
    clearAliasEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://legacy.example.dev");
    const registry = await loadRegistry();
    expect(registry.REELTERMINAL_CLOUD_URL).toBe("https://legacy.example.dev");
  });

  it("lets VITE_REELTERMINAL_CLOUD_URL win over both legacy aliases", async () => {
    clearAliasEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://new.example.dev");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://legacy.example.dev");
    vi.stubEnv("VITE_CLOUD_API_URL", "https://older.example.dev");
    const registry = await loadRegistry();
    expect(registry.REELTERMINAL_CLOUD_URL).toBe("https://new.example.dev");
  });

  it("new URL name set-and-empty keeps its empty semantics and never falls back to the legacy name", async () => {
    // §3: an empty new name is handled per its own empty-value semantics
    // (the || chain falls to the default), never to the legacy name.
    clearAliasEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://legacy.example.dev");
    const registry = await loadRegistry();
    const isDev = import.meta.env.DEV;
    expect(registry.REELTERMINAL_CLOUD_URL).toBe(
      isDev ? "http://localhost:8787" : "https://api.openreel.video",
    );
  });

  it("lets VITE_REELTERMINAL_TRANSCRIBE_URL override the transcription URL", async () => {
    clearAliasEnv();
    vi.stubEnv("VITE_REELTERMINAL_TRANSCRIBE_URL", "https://gpu.example.dev");
    const registry = await loadRegistry();
    expect(registry.REELTERMINAL_TRANSCRIBE_URL).toBe("https://gpu.example.dev");
  });
});

/**
 * Media-core download locations (EXTERNAL-DEPENDENCIES W9/W10): new
 * settings with no legacy names — unset or empty keeps the defaults owned
 * by @reelterminal/core.
 */
describe("api-endpoints media core URL overrides", () => {
  it("keeps every media override empty with no env set", async () => {
    clearCloudEnv();
    const registry = await loadRegistry();

    expect(registry.REELTERMINAL_FFMPEG_CORE_URL).toBe("");
    expect(registry.REELTERMINAL_VIDSTAB_MT_URL).toBe("");
    expect(registry.REELTERMINAL_VIDSTAB_ST_URL).toBe("");
  });

  it("lets each VITE_REELTERMINAL_* media URL override its core", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_REELTERMINAL_FFMPEG_CORE_URL", "https://mirror.example.dev/ffmpeg-core");
    vi.stubEnv("VITE_REELTERMINAL_VIDSTAB_MT_URL", "https://mirror.example.dev/vidstab/mt");
    vi.stubEnv("VITE_REELTERMINAL_VIDSTAB_ST_URL", "https://mirror.example.dev/vidstab/st");
    const registry = await loadRegistry();

    expect(registry.REELTERMINAL_FFMPEG_CORE_URL).toBe(
      "https://mirror.example.dev/ffmpeg-core",
    );
    expect(registry.REELTERMINAL_VIDSTAB_MT_URL).toBe(
      "https://mirror.example.dev/vidstab/mt",
    );
    expect(registry.REELTERMINAL_VIDSTAB_ST_URL).toBe(
      "https://mirror.example.dev/vidstab/st",
    );
  });
});
