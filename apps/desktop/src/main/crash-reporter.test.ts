import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { getVersion: vi.fn(() => "1.2.3") },
}));

vi.mock("electron", () => electron);

import { reportError } from "./crash-reporter";

describe("crash reporting", () => {
  const originalEndpoint = process.env.REELTERMINAL_CRASH_ENDPOINT;
  const originalLegacyEndpoint = process.env.OPENREEL_CRASH_ENDPOINT;
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });

  beforeEach(() => {
    delete process.env.REELTERMINAL_CRASH_ENDPOINT;
    delete process.env.OPENREEL_CRASH_ENDPOINT;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (originalEndpoint === undefined) delete process.env.REELTERMINAL_CRASH_ENDPOINT;
    else process.env.REELTERMINAL_CRASH_ENDPOINT = originalEndpoint;
    if (originalLegacyEndpoint === undefined) delete process.env.OPENREEL_CRASH_ENDPOINT;
    else process.env.OPENREEL_CRASH_ENDPOINT = originalLegacyEndpoint;
    vi.unstubAllGlobals();
  });

  it("does not send reports unless an HTTPS endpoint is explicitly configured", async () => {
    reportError({
      type: "renderer-error",
      source: "renderer",
      message: "contains a private file path",
    });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only a known event type and runtime metadata to an opted-in endpoint", async () => {
    process.env.REELTERMINAL_CRASH_ENDPOINT = "https://collector.example/report";
    reportError({
      type: "renderer-error",
      source: "renderer",
      message: "private project URL and file path",
      stack: "private stack trace",
      context: { private: "project data" },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      type: "renderer-error",
      appVersion: "1.2.3",
      platform: process.platform,
      electronVersion: process.versions.electron,
    });
    expect(String(request.body)).not.toContain("private");
    expect(String(request.body)).not.toContain("stack");
    expect(String(request.body)).not.toContain("context");
  });

  it("maps unrecognized event types to a fixed category", async () => {
    process.env.REELTERMINAL_CRASH_ENDPOINT = "https://collector.example/report";
    reportError({
      type: "user-supplied text that is not a category",
      source: "renderer",
      message: "unused data",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ type: "unknown" });
  });

  it.each([
    "http://collector.example/report",
    "https://user:password@collector.example/report",
    "not a URL",
  ])("ignores an invalid or non-HTTPS endpoint: %s", async (endpoint) => {
    process.env.REELTERMINAL_CRASH_ENDPOINT = endpoint;
    reportError({
      type: "renderer-error",
      source: "renderer",
      message: "unused data",
    });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
