import { PassThrough } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import { fetchUrl, type FetchUrlDependencies } from "./fetch-url";

const publicAddress: LookupAddress = { address: "93.184.216.34", family: 4 };

function response(
  statusCode: number,
  headers: IncomingHttpHeaders = {},
  chunks: readonly Uint8Array[] = [],
): IncomingMessage {
  const stream = new PassThrough() as PassThrough & {
    statusCode: number;
    statusMessage: string;
    headers: IncomingHttpHeaders;
  };
  stream.statusCode = statusCode;
  stream.statusMessage = statusCode === 200 ? "OK" : "Found";
  stream.headers = headers;
  queueMicrotask(() => {
    if (stream.destroyed) return;
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream as unknown as IncomingMessage;
}

function dependencies(
  request: FetchUrlDependencies["request"] = async () =>
    response(200, { "content-type": "model/gltf-binary" }, [new Uint8Array([1, 2, 3])]),
  lookup: FetchUrlDependencies["lookup"] = async () => [publicAddress],
): FetchUrlDependencies {
  return { request, lookup };
}

describe("fetchUrl", () => {
  it.each([
    "http://127.0.0.1/model.glb",
    "http://2130706433/model.glb",
    "http://10.2.3.4/model.glb",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/model.glb",
    "http://[fd00::1]/model.glb",
    "http://[fe80::1]/model.glb",
    "http://[fec0::1]/model.glb",
    "http://[2001:db8::1]/model.glb",
    "http://[::ffff:7f00:1]/model.glb",
    "http://renderer.local/model.glb",
  ])("refuses non-public literal and local hosts: %s", async (url) => {
    const request = vi.fn<FetchUrlDependencies["request"]>();
    const lookup = vi.fn<FetchUrlDependencies["lookup"]>();

    const result = await fetchUrl({ url }, dependencies(request, lookup));

    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname if any DNS answer is private", async () => {
    const request = vi.fn<FetchUrlDependencies["request"]>();
    const result = await fetchUrl(
      { url: "https://model.example/scene.glb" },
      dependencies(request, async () => [
        publicAddress,
        { address: "192.168.1.3", family: 4 },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the request to the validated DNS address", async () => {
    const request = vi.fn<FetchUrlDependencies["request"]>(async () =>
      response(200, { "content-type": "model/gltf-binary" }, [new Uint8Array([1, 2, 3])]),
    );
    const addresses = [publicAddress, { address: "93.184.216.35", family: 4 }];
    const lookup = vi.fn<FetchUrlDependencies["lookup"]>(async () => addresses);

    const result = await fetchUrl(
      { url: "https://model.example/scene.glb", maxBytes: 8 },
      dependencies(request, lookup),
    );

    expect(result.ok).toBe(true);
    expect([...new Uint8Array(result.body)]).toEqual([1, 2, 3]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      new URL("https://model.example/scene.glb"),
      publicAddress,
      expect.any(AbortSignal),
    );
  });

  it("allows and pins a global IPv6 answer", async () => {
    const address: LookupAddress = {
      address: "2606:4700:4700::1111",
      family: 6,
    };
    const request = vi.fn<FetchUrlDependencies["request"]>(async () =>
      response(200, {}, [new Uint8Array([1])]),
    );

    const result = await fetchUrl(
      { url: "https://model.example/scene.glb" },
      dependencies(request, async () => [address]),
    );

    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      new URL("https://model.example/scene.glb"),
      address,
      expect.any(AbortSignal),
    );
  });

  it("does not follow redirect responses", async () => {
    const request = vi.fn<FetchUrlDependencies["request"]>(async () =>
      response(302, { location: "http://127.0.0.1/private" }),
    );

    const result = await fetchUrl(
      { url: "https://model.example/scene.glb" },
      dependencies(request),
    );

    expect(result).toMatchObject({
      ok: false,
      status: 302,
      error: "Redirect responses are not followed",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("enforces the limit while reading a chunked response", async () => {
    const request = vi.fn<FetchUrlDependencies["request"]>(async () =>
      response(200, {}, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]),
    );

    const result = await fetchUrl(
      { url: "https://model.example/scene.glb", maxBytes: 4 },
      dependencies(request),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("max 4 bytes");
    expect(result.body.byteLength).toBe(0);
  });

  it("times out a request that never finishes", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn<FetchUrlDependencies["request"]>(
      (_url, _address, signal) => {
        requestSignal = signal;
        return new Promise(() => undefined);
      },
    );

    try {
      const resultPromise = fetchUrl(
        { url: "https://model.example/scene.glb" },
        dependencies(request),
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await resultPromise;

      expect(result).toMatchObject({ ok: false, error: "Request timed out" });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects embedded credentials and caps caller-provided limits", async () => {
    const request = vi.fn<FetchUrlDependencies["request"]>();
    const withCredentials = await fetchUrl(
      { url: "https://user:password@model.example/scene.glb" },
      dependencies(request),
    );
    expect(withCredentials.error).toContain("embedded credentials");
    expect(request).not.toHaveBeenCalled();

    const invalidLimit = await fetchUrl(
      { url: "https://model.example/scene.glb", maxBytes: Number.MAX_SAFE_INTEGER + 1 },
      dependencies(request),
    );
    expect(invalidLimit.error).toBe("Invalid byte limit");
  });
});
