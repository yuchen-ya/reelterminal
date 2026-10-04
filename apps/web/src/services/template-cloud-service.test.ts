import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service reads the build-time cloud switch at module scope, so the
 * opt-out cases re-import the module against a stubbed environment.
 */

type ServiceModule = typeof import("./template-cloud-service");

async function loadService(): Promise<ServiceModule> {
  vi.resetModules();
  return import("./template-cloud-service");
}

function clearCloudEnv(): void {
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD;
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD_URL;
}

describe("TemplateCloudService cloud opt-out", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearCloudEnv();
  });

  it.each([undefined, "off"])("short-circuits every method with zero network with cloud setting %s", async (value) => {
    clearCloudEnv();
    if (value !== undefined) vi.stubEnv("VITE_OPENREEL_CLOUD", value);
    const { templateCloudService } = await loadService();

    await expect(templateCloudService.listTemplates()).resolves.toEqual([]);
    await expect(templateCloudService.getTemplate("t1")).resolves.toBeNull();
    await expect(templateCloudService.uploadTemplate({} as never)).resolves.toEqual({
      success: false,
      error: expect.any(String),
    });
    await expect(templateCloudService.deleteTemplate("t1")).resolves.toEqual({
      success: false,
      error: expect.any(String),
    });
    await expect(templateCloudService.checkHealth()).resolves.toBe(false);
    await expect(
      templateCloudService.listScriptableTemplates(),
    ).resolves.toEqual([]);
    await expect(
      templateCloudService.getScriptableTemplate("t1"),
    ).resolves.toBeNull();

    expect(templateCloudService.isCloudEnabled()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports write-class operations as unavailable with the localized explanation", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    const { templateCloudService } = await loadService();

    const upload = await templateCloudService.uploadTemplate({} as never);
    expect(upload.success).toBe(false);
    expect(upload.error).toBe(
      "Cloud templates are disabled in this build's configuration.",
    );
  });

  it("uses an explicitly enabled backend", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
    const { templateCloudService } = await loadService();

    expect(templateCloudService.isCloudEnabled()).toBe(true);

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });
    await expect(templateCloudService.listTemplates()).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/templates");
  });

  it.each(["on", "ON"])(
    "stays enabled and networked for non-off values (%s)",
    async (value) => {
      clearCloudEnv();
      vi.stubEnv("VITE_OPENREEL_CLOUD", value);
      vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
      const { templateCloudService } = await loadService();

      expect(templateCloudService.isCloudEnabled()).toBe(true);

      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ templates: [] }),
      });
      await templateCloudService.listTemplates();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("TemplateCloudService listTemplatesWithStatus failure reporting", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearCloudEnv();
  });

  it("reports failure instead of collapsing to an empty list when the request rejects", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
    const { templateCloudService } = await loadService();
    fetchSpy.mockRejectedValue(new Error("network down"));

    await expect(
      templateCloudService.listTemplatesWithStatus(),
    ).resolves.toEqual({ templates: [], failed: true });
  });

  it("reports failure for a non-ok response", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
    const { templateCloudService } = await loadService();
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await expect(
      templateCloudService.listTemplatesWithStatus(),
    ).resolves.toEqual({ templates: [], failed: true });
  });

  it("returns the templates with failed: false when the cloud responds", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
    const { templateCloudService } = await loadService();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [{ id: "cloud-1", name: "Cloud" }] }),
    });

    await expect(
      templateCloudService.listTemplatesWithStatus(),
    ).resolves.toEqual({
      templates: [{ id: "cloud-1", name: "Cloud" }],
      failed: false,
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/templates");
  });

  it("short-circuits with failed: false and zero network when the cloud is off", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    const { templateCloudService } = await loadService();

    await expect(
      templateCloudService.listTemplatesWithStatus(),
    ).resolves.toEqual({ templates: [], failed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
