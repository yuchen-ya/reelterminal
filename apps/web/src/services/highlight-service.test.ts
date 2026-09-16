import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * highlight-service used to read VITE_CLOUD_API_URL directly at module
 * scope. It now takes its base URL from the central endpoint registry,
 * so the URL follows the shared overrides (and the dev/prod switch).
 * The registry reads env at module scope, hence the resetModules +
 * dynamic import pattern; the core analyzer is mocked out because the
 * audio graph is irrelevant to URL formation. The real CloudRequestError
 * stays available so failure-shape tests can assert on it.
 */

vi.mock("@openreel/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openreel/core")>();
  return {
    ...actual,
    analyzeAudioForHighlights: vi.fn(() => ({ segments: [], duration: 12 })),
  };
});

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

describe("highlight-service failure classification", () => {
  async function capturedRejection(
    fetchImpl: () => Promise<unknown>,
  ): Promise<{ kind: string; status?: number; detail: string }> {
    clearCloudEnv();
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    const { extractHighlights } = await loadService();
    try {
      await extractHighlights({} as AudioBuffer, []);
      throw new Error("expected extractHighlights to reject");
    } catch (err) {
      return err as { kind: string; status?: number; detail: string };
    }
  }

  it("throws a structured network error when the request cannot be sent", async () => {
    const err = await capturedRejection(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(err.kind).toBe("network");
    expect(err.status).toBeUndefined();
    expect(err.detail).toContain("Failed to fetch");
  });

  it("throws a structured timeout error when the request exceeds the budget", async () => {
    const err = await capturedRejection(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expect(err.kind).toBe("timeout");
    expect(err.detail).toContain("timed out");
    expect(err.detail).toContain("120 seconds");
  });

  it("keeps the server-provided reason and status for HTTP failures", async () => {
    const err = await capturedRejection(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "model overloaded" }),
    }));
    expect(err.kind).toBe("server");
    expect(err.status).toBe(503);
    expect(err.detail).toBe("model overloaded");
  });

  it("maps 429 responses to the rate-limited category", async () => {
    const err = await capturedRejection(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    }));
    expect(err.kind).toBe("rateLimited");
    expect(err.status).toBe(429);
    expect(err.detail).toBe("API error: 429");
  });

  it("treats an unparseable 2xx body as an invalid response", async () => {
    const err = await capturedRejection(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }));
    expect(err.kind).toBe("responseInvalid");
  });

  it("treats a 2xx body without a highlights list as an invalid response", async () => {
    const err = await capturedRejection(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    expect(err.kind).toBe("responseInvalid");
    expect(err.detail).toContain("no highlights list");
  });
});
