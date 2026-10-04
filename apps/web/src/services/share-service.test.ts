import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

/**
 * The service reads the build-time cloud switch at module scope, so the
 * opt-out cases re-import the module against a stubbed environment.
 * "Zero network" is asserted with fetch AND XMLHttpRequest spies so the
 * upload path cannot sneak past via XHR.
 */

type ServiceModule = typeof import("./share-service");

async function loadService(): Promise<ServiceModule> {
  vi.resetModules();
  return import("./share-service");
}

function clearCloudEnv(): void {
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD;
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD_URL;
}

class FakeXHR {
  static instances: FakeXHR[] = [];

  status = 200;
  responseText = JSON.stringify({
    shareId: "s1",
    shareUrl: "https://example.test/s/s1",
    expiresAt: 1,
  });
  upload = { addEventListener: vi.fn() };
  open = vi.fn();
  send = vi.fn(() => {
    queueMicrotask(() => this.listeners.get("load")?.());
  });
  private listeners = new Map<string, () => void>();

  constructor() {
    FakeXHR.instances.push(this);
  }

  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, handler);
  }
}

describe("share-service cloud opt-out", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let xhrCtor: Mock<() => FakeXHR>;

  beforeEach(() => {
    FakeXHR.instances = [];
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    xhrCtor = vi.fn(function () {
      return new FakeXHR();
    });
    vi.stubGlobal("XMLHttpRequest", xhrCtor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearCloudEnv();
  });

  it.each([undefined, "off"])("rejects uploads before any XHR with cloud setting %s", async (value) => {
    clearCloudEnv();
    if (value !== undefined) vi.stubEnv("VITE_OPENREEL_CLOUD", value);
    const { uploadForSharing } = await loadService();

    await expect(
      uploadForSharing(new Blob(["x"]), "clip.webm"),
    ).rejects.toThrow("Video sharing is disabled in this build's configuration.");

    // Neither the request nor the XHR object may be created.
    expect(xhrCtor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("short-circuits every read with zero network when the cloud is off", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    const { getShareInfo, getShareDownloadUrl, checkShareHealth } =
      await loadService();

    await expect(getShareInfo("s1")).resolves.toBeNull();
    expect(getShareDownloadUrl("s1")).toBe("");
    await expect(checkShareHealth()).resolves.toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads and reads only with an explicitly enabled backend", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "on");
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
    const { uploadForSharing, getShareInfo } = await loadService();

    await expect(
      uploadForSharing(new Blob(["x"]), "clip.webm"),
    ).resolves.toEqual({
      shareId: "s1",
      shareUrl: "https://example.test/s/s1",
      expiresAt: 1,
    });
    expect(xhrCtor).toHaveBeenCalledTimes(1);
    const xhr = FakeXHR.instances[0];
    expect(xhr.open).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/shares"),
    );
    expect(xhr.send).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ shareId: "s1" }),
    });
    await expect(getShareInfo("s1")).resolves.toEqual({ shareId: "s1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/shares/s1");
  });

  it.each(["on", "ON"])(
    "stays networked for non-off values (%s)",
    async (value) => {
      clearCloudEnv();
      vi.stubEnv("VITE_OPENREEL_CLOUD", value);
      vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "https://service.example");
      const { checkShareHealth } = await loadService();

      fetchSpy.mockResolvedValue({ ok: true, status: 200 });
      await expect(checkShareHealth()).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );
});
