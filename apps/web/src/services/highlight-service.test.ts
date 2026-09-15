import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * highlight-service used to read VITE_CLOUD_API_URL directly at module
 * scope. It now takes its base URL from the central endpoint registry,
 * so the URL follows the shared overrides (and the dev/prod switch).
 * The registry reads env at module scope, hence the resetModules +
 * dynamic import pattern; the core analyzer is mocked out because the
 * audio graph is irrelevant to URL formation.
 */

vi.mock("@openreel/core", () => ({
  analyzeAudioForHighlights: vi.fn(() => ({ segments: [], duration: 12 })),
}));

async function loadService() {
  vi.resetModules();
  return import("./highlight-service");
}

function clearCloudEnv(): void {
  for (const key of ["VITE_OPENREEL_CLOUD_URL", "VITE_CLOUD_API_URL"]) {
    delete (import.meta.env as Record<string, unknown>)[key];
  }
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ highlights: [] }),
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCloudEnv();
});

describe("highlight-service URL registry migration", () => {
  it("posts highlights to OPENREEL_CLOUD_URL, honoring VITE_OPENREEL_CLOUD_URL", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://selfhosted.example");
    const fetchSpy = stubFetch();
    const { extractHighlights } = await loadService();

    await extractHighlights({} as AudioBuffer, []);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://selfhosted.example/highlights",
    );
  });

  it("still honors VITE_CLOUD_API_URL as a compatibility alias", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_CLOUD_API_URL", "https://legacy.example");
    const fetchSpy = stubFetch();
    const { extractHighlights } = await loadService();

    await extractHighlights({} as AudioBuffer, []);

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://legacy.example/highlights",
    );
  });

  it("falls back to the built-in registry default when no override is set", async () => {
    clearCloudEnv();
    const fetchSpy = stubFetch();
    const { extractHighlights } = await loadService();
    const { OPENREEL_CLOUD_URL } = await import("../config/api-endpoints");

    await extractHighlights({} as AudioBuffer, []);

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `${OPENREEL_CLOUD_URL}/highlights`,
    );
  });

  it("prefers the new override over the legacy alias", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://selfhosted.example");
    vi.stubEnv("VITE_CLOUD_API_URL", "https://legacy.example");
    const fetchSpy = stubFetch();
    const { extractHighlights } = await loadService();

    await extractHighlights({} as AudioBuffer, []);

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://selfhosted.example/highlights",
    );
  });
});
