import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * B06 fault simulation for the passive Text3D font fetch observer.
 *
 * The core renderer downloads the default Text3D font from a hardcoded
 * remote URL and silently skips 3D text objects when the download fails.
 * These tests pin the observer that lets the web UI surface that
 * degradation: failure recording, same-origin loads ignored, pass-through
 * fetch semantics, and text3d presence detection.
 */

const originalFetch = window.fetch;
const fontUrl = "https://threejs.org/examples/fonts/helvetiker_bold.typeface.json";

async function loadModule() {
  vi.resetModules();
  return import("./text3d-font-status");
}

afterEach(() => {
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response;
}

describe("text3d font fetch observer", () => {
  it("records a failure when the remote font fetch rejects and notifies subscribers", async () => {
    const mod = await loadModule();
    window.fetch = vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return url === fontUrl
        ? Promise.reject(new Error("ERR_NETWORK"))
        : Promise.resolve(okResponse());
    }) as unknown as typeof window.fetch;

    mod.installText3DFontFetchObserver();
    let notified = 0;
    mod.subscribeText3DFontFailure(() => {
      notified += 1;
    });

    await expect(window.fetch(fontUrl)).rejects.toThrow("ERR_NETWORK");

    expect(mod.getText3DFontFailure()).toEqual({
      url: fontUrl,
      message: "ERR_NETWORK",
    });
    expect(notified).toBe(1);
  });

  it("ignores same-origin font loads and unrelated requests", async () => {
    const mod = await loadModule();
    window.fetch = vi.fn(() => Promise.resolve(okResponse())) as unknown as typeof window.fetch;

    mod.installText3DFontFetchObserver();

    await window.fetch("/fonts/helvetiker_regular.typeface.json");
    await window.fetch("https://example.com/other.json");

    expect(mod.getText3DFontFailure()).toBeNull();
  });

  it("records non-OK responses and re-arms after a success (retry path)", async () => {
    const mod = await loadModule();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 404 } as unknown as Response));
    window.fetch = fetchMock as unknown as typeof window.fetch;

    mod.installText3DFontFetchObserver();
    await window.fetch(fontUrl);
    expect(mod.getText3DFontFailure()?.message).toBe("HTTP 404");

    // Simulated recovery after a user retry: the explicit clear (what the
    // stage retry does) resets the failure, and a later failure is
    // recorded again.
    mod.clearText3DFontFailure();
    expect(mod.getText3DFontFailure()).toBeNull();

    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));
    await window.fetch(fontUrl);
    expect(mod.getText3DFontFailure()).toBeNull();

    fetchMock.mockImplementation(() =>
      Promise.reject(new Error("ERR_CONNECTION_RESET")),
    );
    await expect(window.fetch(fontUrl)).rejects.toThrow();
    expect(mod.getText3DFontFailure()?.message).toBe("ERR_CONNECTION_RESET");
  });

  it("forwards every call untouched — no extra requests, args preserved", async () => {
    const mod = await loadModule();
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
    window.fetch = fetchMock as unknown as typeof window.fetch;

    mod.installText3DFontFetchObserver();
    const init = { method: "GET" };
    await window.fetch(fontUrl, init);

    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(fontUrl);
    expect(calls[0][1]).toBe(init);
  });

  it("compositionHasText3DObjects detects visible scene3d text objects only", async () => {
    const mod = await loadModule();

    const withLegacyObject = {
      layers: [
        { type: "scene3d", visible: true, object: { kind: "text3d" } },
        { type: "text", visible: true },
      ],
    } as never;
    expect(mod.compositionHasText3DObjects(withLegacyObject)).toBe(true);

    const withSceneObjects = {
      layers: [
        {
          type: "scene3d",
          visible: true,
          object: { kind: "box" },
          objects: [{ id: "o1", object: { kind: "text3d" } }],
        },
      ],
    } as never;
    expect(mod.compositionHasText3DObjects(withSceneObjects)).toBe(true);

    const hiddenLayer = {
      layers: [{ type: "scene3d", visible: false, object: { kind: "text3d" } }],
    } as never;
    expect(mod.compositionHasText3DObjects(hiddenLayer)).toBe(false);

    const noScene3d = {
      layers: [{ type: "text", visible: true }],
    } as never;
    expect(mod.compositionHasText3DObjects(noScene3d)).toBe(false);
  });
});
