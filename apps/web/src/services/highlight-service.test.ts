import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The service takes its base URL from the central endpoint registry,
 * using an explicitly configured backend.
 * The registry reads env at module scope, hence the resetModules +
 * dynamic import pattern; the core analyzer is mocked out because the
 * audio graph is irrelevant to URL formation. The real CloudRequestError
 * stays available so failure-shape tests can assert on it.
 */

vi.mock("@reelterminal/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reelterminal/core")>();
  return {
    ...actual,
    analyzeAudioForHighlights: vi.fn(() => ({ segments: [], duration: 12 })),
  };
});

async function loadService() {
  vi.stubEnv("VITE_REELTERMINAL_CLOUD", "on");
  if (!import.meta.env.VITE_REELTERMINAL_CLOUD_URL) vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://service.example");
  vi.resetModules();
  return import("./highlight-service");
}

function clearCloudEnv(): void {
  for (const key of ["VITE_REELTERMINAL_CLOUD", "VITE_REELTERMINAL_CLOUD_URL"]) {
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

describe("highlight-service URL configuration", () => {
  it("posts highlights to REELTERMINAL_CLOUD_URL, honoring VITE_REELTERMINAL_CLOUD_URL", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://selfhosted.example");
    const fetchSpy = stubFetch();
    const { extractHighlights } = await loadService();

    await extractHighlights({} as AudioBuffer, []);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://selfhosted.example/highlights",
    );
  });

  it("uses the configured backend for highlight requests", async () => {
    clearCloudEnv();
    const fetchSpy = stubFetch();
    const { extractHighlights } = await loadService();
    const { REELTERMINAL_CLOUD_URL } = await import("../config/api-endpoints");

    await extractHighlights({} as AudioBuffer, []);

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `${REELTERMINAL_CLOUD_URL}/highlights`,
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

it("does not upload transcript or audio metrics in the default local build", async () => {
  clearCloudEnv();
  vi.resetModules();
  const fetchSpy = stubFetch();
  const { extractHighlights } = await import("./highlight-service");
  await expect(extractHighlights({} as AudioBuffer, [])).rejects.toThrow("unavailable");
  expect(fetchSpy).not.toHaveBeenCalled();
});
